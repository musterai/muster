// File: src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z as zod } from 'zod';
import {
  AgentService,
  CardService,
  CommentService,
  DocumentService,
  RoleService,
} from '../services/index.js';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import { requirePermission, TOOL_PERMISSIONS, withPermission } from '../shared/permission-enforcer.js';
import type { Services } from '../shared/services.js';
import { mcpCardCreateInputSchema } from '../shared/card-input-schema.js';
import { config } from '../config/index.js';
import { Request } from 'express';
import type { DatabaseAdapter } from '../db/adapter.js';

const z = zod;
const cardReferenceSchema = z.string().describe(
  'The card ULID or its human-readable key (e.g. "MUS-49"); writes resolve it to the immutable card ID.'
);

type InternalMcpServer = {
  _registeredTools?: Record<string, unknown>;
  tool: (...args: any[]) => any;
  registerTool: (...args: any[]) => any;
  [mcpPermissionBoundaryInstalled]?: boolean;
  [mcpPermissionBoundaryState]?: McpPermissionBoundaryState;
};

const mcpPermissionBoundaryInstalled = Symbol('mcpPermissionBoundaryInstalled');
const mcpPermissionBoundaryState = Symbol('mcpPermissionBoundaryState');

type McpPermissionBoundaryState = {
  /** Names deliberately registered through this auth-bound server instance. */
  toolNames: Set<string>;
};

/**
 * SDK calls parse a tool's input before invoking its registered handler. The
 * boundary also supports direct handler invocation in local tests and legacy
 * integrations, where no SDK parse occurred. Track values produced by the
 * exact registered schema so the latter gets a guard parse, while the former
 * cannot apply non-idempotent Zod transforms a second time.
 */
const mcpParsedInputObjects = new WeakMap<object, WeakSet<object>>();

function isZodSchema(value: unknown): value is zod.ZodTypeAny {
  return !!value
    && typeof value === 'object'
    && typeof (value as { parseAsync?: unknown }).parseAsync === 'function'
    && typeof (value as { safeParse?: unknown }).safeParse === 'function';
}

function isZodRawShape(value: unknown): value is zod.ZodRawShape {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isZodSchema(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  return entries.length > 0 && entries.some(isZodSchema);
}

/**
 * Reject extra input members without handing their attacker-controlled names
 * to the SDK's error formatter. `ZodObject.strict()` puts the complete key
 * list in a `unrecognized_keys` issue and the MCP SDK serializes that issue's
 * message verbatim. A root-level generic issue gives clients a stable refusal
 * while still preventing a handler or service from observing the input.
 */
function rejectUnknownMcpObjectKeys(
  schema: zod.ZodTypeAny,
  shape: zod.ZodRawShape,
): zod.ZodTypeAny {
  const knownKeys = new Set(Object.keys(shape));
  const unknownKeyGate = z.any().superRefine((value, context) => {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).some((key) => !knownKeys.has(key))
    ) {
      context.addIssue({
        code: zod.ZodIssueCode.custom,
        path: [],
        message: 'Invalid request input',
        // Do not run the wrapped schema after a rejected property. In
        // particular, a caller must not receive the original ZodObject's
        // `unrecognized_keys` issue, which would echo every unknown key.
        fatal: true,
      });
      return zod.NEVER;
    }
  });
  // The gate observes the original request object, then the caller's schema
  // executes exactly once. This preserves field/object transforms and
  // refinements instead of rebuilding a modern ZodObject from its shape.
  return unknownKeyGate.pipe(schema);
}

function markMcpParsedInputs(schema: zod.ZodTypeAny): zod.ZodTypeAny {
  const parsedObjects = new WeakSet<object>();
  const markedSchema = schema.transform((value) => {
    if (value && typeof value === 'object') {
      parsedObjects.add(value as object);
    }
    return value;
  });
  mcpParsedInputObjects.set(markedSchema as object, parsedObjects);
  return markedSchema;
}

function wasParsedByRegisteredMcpSchema(
  schema: zod.ZodTypeAny | undefined,
  value: unknown,
): boolean {
  if (!schema || !value || typeof value !== 'object') return false;
  return mcpParsedInputObjects.get(schema as object)?.has(value as object) === true;
}

function safeStrictMcpObjectSchema(shape: zod.ZodRawShape): zod.ZodTypeAny {
  return rejectUnknownMcpObjectKeys(z.object(shape), shape);
}

/**
 * Modern callers can wrap an object in Zod effects (for example
 * `z.object(...).strict().transform(...)`). Find the underlying input object
 * without rebuilding the caller's schema, so the raw unknown-key gate still
 * runs before any effect/refinement and the original parse remains singular.
 */
function getMcpObjectShape(schema: zod.ZodTypeAny): zod.ZodRawShape | undefined {
  if (schema instanceof zod.ZodObject) return schema.shape;

  const definition = (schema as { _def?: Record<string, unknown> })._def;
  if (!definition) return undefined;
  for (const candidate of [definition.schema, definition.innerType, definition.type, definition.in]) {
    if (isZodSchema(candidate)) {
      const shape = getMcpObjectShape(candidate);
      if (shape) return shape;
    }
  }
  return undefined;
}

/**
 * The MCP SDK accepts raw Zod shapes and turns them into non-strict objects.
 * Normalize every tool input at registration time so SDK validation and the
 * direct handler guard both reject unknown properties instead of stripping
 * them before the application can notice.
 */
function normalizeMcpInputSchema(value: unknown, assumeEmptyShape = false): zod.ZodTypeAny | undefined {
  if (isZodSchema(value)) {
    // `ZodObject.strict()` leaks unknown key names through the SDK's formatted
    // validation error. Gate the raw object before parsing instead. Unlike
    // rebuilding from `.shape`, this retains modern object refinements and
    // transforms exactly as the caller supplied them.
    const shape = getMcpObjectShape(value);
    return markMcpParsedInputs(shape ? rejectUnknownMcpObjectKeys(value, shape) : value);
  }

  if (isZodRawShape(value) || (assumeEmptyShape && value && typeof value === 'object' && Object.keys(value as object).length === 0)) {
    return markMcpParsedInputs(safeStrictMcpObjectSchema(value as zod.ZodRawShape));
  }

  return undefined;
}

/**
 * The SDK's legacy `tool()` overload only reliably accepts raw shapes across
 * its supported Zod peer range. Register with that compatible shape, then
 * replace the runtime input schema with our strict object below.
 */
function sdkCompatibleInputSchema(value: unknown): unknown {
  if (isZodSchema(value) && value instanceof zod.ZodObject) return value.shape;
  return value;
}

/**
 * The legacy `tool()` overload only takes raw shapes, while modern
 * `registerTool()` explicitly accepts a complete Zod schema. Passing the
 * normalized schema through the modern API lets the SDK perform the one and
 * only parse (including our redacted unknown-key gate).
 */
function sdkModernInputSchema(value: unknown, normalized: zod.ZodTypeAny | undefined): unknown {
  return isZodSchema(value) ? normalized : sdkCompatibleInputSchema(value);
}

function assertMcpToolIsMapped(toolName: string): void {
  if (!(toolName in TOOL_PERMISSIONS)) {
    // Fail at registration, regardless of auth mode. Open mode skips request
    // authorization by design, but it must never hide an incomplete policy
    // catalog that would become a production authorization hole later.
    throw new Error(`MCP tool "${toolName}" is missing a permission mapping`);
  }
}

/**
 * Private SDK handler tests historically invoke `add_comment` after creating
 * a server with an in-memory authenticated context, bypassing SDK input
 * parsing entirely. Preserve that test seam without weakening the wire
 * contract: network calls are rejected by the strict registered schema first;
 * only an already-known local context (or the legacy open-mode author alias)
 * can fill the required open-mode label before direct handler validation.
 */
function supplyOpenModeCommentIdentity(
  toolName: string,
  auth: AuthContext,
  rawArgs: unknown,
): unknown {
  if (toolName !== 'add_comment' || config.auth.mode !== 'open' || !rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return rawArgs;
  }
  const args = rawArgs as Record<string, unknown>;
  if (typeof args.agent_id === 'string' && args.agent_id.length > 0) return args;
  const candidate = auth.principal?.id ?? args.author_id;
  return typeof candidate === 'string' && candidate.length > 0
    ? { ...args, agent_id: candidate }
    : args;
}

type McpToolGuardBinding = {
  toolName: string;
  inputSchema: zod.ZodTypeAny | undefined;
};

function guardMcpToolHandler(
  binding: McpToolGuardBinding,
  auth: AuthContext,
  handler: (...args: any[]) => any,
): (...args: any[]) => Promise<any> {
  return async (...handlerArgs: any[]) => {
    const { toolName, inputSchema } = binding;
    let permissionArgs: Record<string, unknown> = {};
    if (inputSchema) {
      const rawInput = supplyOpenModeCommentIdentity(toolName, auth, handlerArgs[0]);
      const parsed = wasParsedByRegisteredMcpSchema(inputSchema, rawInput)
        ? rawInput
        : await inputSchema.parseAsync(rawInput);
      handlerArgs[0] = parsed;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        permissionArgs = parsed as Record<string, unknown>;
      }
    }

    // This is intentionally centralized at registration rather than left to
    // individual handlers. A future tool can neither run unwrapped nor omit a
    // mapped permission check by accident.
    requirePermission(toolName, auth, permissionArgs);
    return handler(...handlerArgs);
  };
}

type InternalRegisteredTool = {
  inputSchema?: zod.ZodTypeAny;
  update?: (updates: Record<string, unknown>) => unknown;
};

function assertRegisteredMcpToolInventory(
  server: McpServer,
  state: McpPermissionBoundaryState,
): void {
  const registered = getRegisteredMcpToolNames(server);
  const expected = [...state.toolNames].sort();
  if (registered.join('\u0000') !== expected.join('\u0000')) {
    throw new Error(
      `MCP registered-tool inventory changed unexpectedly: expected=[${expected.join(', ')}], actual=[${registered.join(', ')}]`,
    );
  }
  for (const toolName of registered) {
    assertMcpToolIsMapped(toolName);
  }
}

/**
 * SDK registered tools expose `update({ callback })`. Guard that secondary
 * registration path too, otherwise a later callback replacement could undo
 * the central boundary after an initially safe registration.
 */
function instrumentRegisteredMcpTool(
  server: McpServer,
  state: McpPermissionBoundaryState,
  registered: unknown,
  binding: McpToolGuardBinding,
  auth: AuthContext,
): unknown {
  if (!registered || typeof registered !== 'object') return registered;
  const tool = registered as InternalRegisteredTool;
  if (binding.inputSchema) tool.inputSchema = binding.inputSchema;

  const rawUpdate = tool.update?.bind(tool);
  if (!rawUpdate) return registered;
  tool.update = (updates: Record<string, unknown>) => {
    // The SDK mutates `_registeredTools` before it replaces the callback. A
    // rename could therefore retain this closure's old permission decision.
    // Names are intentionally immutable for the lifetime of an auth-bound
    // server; disabling a tool remains available without weakening policy.
    const hasNameUpdate = Object.prototype.hasOwnProperty.call(updates, 'name')
      && updates.name !== undefined;
    const removesTool = hasNameUpdate && updates.name === null;
    if (hasNameUpdate && !removesTool && updates.name !== binding.toolName) {
      throw new Error(`MCP tool "${binding.toolName}" cannot be renamed after registration`);
    }

    const hasSchemaUpdate = Object.prototype.hasOwnProperty.call(updates, 'paramsSchema')
      && updates.paramsSchema !== undefined;
    const nextInputSchema = hasSchemaUpdate
      ? normalizeMcpInputSchema(updates.paramsSchema, updates.paramsSchema !== undefined)
      : tool.inputSchema;
    if (hasSchemaUpdate && !nextInputSchema) {
      throw new Error(`MCP tool "${binding.toolName}" must update with a valid input schema`);
    }
    const guardedUpdates = { ...updates };
    if (Object.prototype.hasOwnProperty.call(guardedUpdates, 'callback')) {
      if (typeof guardedUpdates.callback !== 'function') {
        throw new Error(`MCP tool "${binding.toolName}" must update through a function handler guarded by the permission boundary`);
      }
      guardedUpdates.callback = guardMcpToolHandler(
        binding,
        auth,
        guardedUpdates.callback as (...args: any[]) => any,
      );
    }
    if (hasSchemaUpdate && nextInputSchema) {
      guardedUpdates.paramsSchema = sdkCompatibleInputSchema(updates.paramsSchema);
    }
    const result = rawUpdate(guardedUpdates);
    if (removesTool) {
      // `RegisteredTool.remove()` is implemented by the SDK as
      // `update({ name: null })`. Mirror the SDK's successful deletion in the
      // boundary inventory, including when a callback is supplied in the same
      // update (the detached callback is never reachable through the server).
      state.toolNames.delete(binding.toolName);
    } else {
      binding.inputSchema = nextInputSchema;
      if (nextInputSchema) tool.inputSchema = nextInputSchema;
    }
    // This is deliberately automatic for every successful SDK update, not a
    // best-effort assertion callers must remember to run after mutating a
    // registered tool.
    assertRegisteredMcpToolInventory(server, state);
    return result;
  };
  return registered;
}

/** Return the SDK's actual runtime registrations, not a hand-maintained list. */
export function getRegisteredMcpToolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as InternalMcpServer)._registeredTools || {}).sort();
}

/**
 * Verify the canonical catalog against the actual SDK registry. This protects
 * both directions: a new tool without policy and stale policy after a tool is
 * removed. It intentionally has no manually copied expected-name list.
 */
export function assertMcpToolPermissionInventory(server: McpServer): void {
  const registered = getRegisteredMcpToolNames(server);
  const mapped = Object.keys(TOOL_PERMISSIONS).sort();
  const unmapped = registered.filter((name) => !(name in TOOL_PERMISSIONS));
  const stale = mapped.filter((name) => !registered.includes(name));
  if (unmapped.length > 0 || stale.length > 0) {
    throw new Error(
      `MCP permission inventory mismatch: unmapped=[${unmapped.join(', ')}], stale=[${stale.join(', ')}]`,
    );
  }
}

/**
 * Install the mandatory MCP authorization/validation boundary on both SDK
 * registration APIs. This remains effective even if a future handler calls
 * `server.tool(...)` directly without `withPermission(...)`.
 */
export function installMcpPermissionBoundary(server: McpServer, auth: AuthContext): void {
  const internal = server as unknown as InternalMcpServer;
  if (internal[mcpPermissionBoundaryInstalled]) return;
  const existingToolNames = getRegisteredMcpToolNames(server);
  if (existingToolNames.length > 0) {
    throw new Error(
      `MCP permission boundary must be installed before tool registration: existing=[${existingToolNames.join(', ')}]`,
    );
  }
  const state: McpPermissionBoundaryState = {
    toolNames: new Set(),
  };
  assertRegisteredMcpToolInventory(server, state);

  const rawTool = internal.tool.bind(server);
  internal.tool = (toolName: string, ...rest: any[]) => {
    assertMcpToolIsMapped(toolName);
    const handlerIndex = rest.length - 1;
    const handler = rest[handlerIndex];
    if (typeof handler !== 'function') {
      throw new Error(`MCP tool "${toolName}" must register a function handler through the permission boundary`);
    }

    const schemaIndex = typeof rest[0] === 'string' ? 1 : 0;
    const inputSchema = normalizeMcpInputSchema(rest[schemaIndex], rest.length === schemaIndex + 2);
    const binding: McpToolGuardBinding = { toolName, inputSchema };
    rest[handlerIndex] = guardMcpToolHandler(binding, auth, handler);
    const registered = rawTool(toolName, ...rest);
    // The server validates against this field at execution time. Replacing
    // the loose object made from a raw shape is what makes unknown MCP
    // properties a stable rejection rather than silently stripped input.
    state.toolNames.add(toolName);
    const instrumented = instrumentRegisteredMcpTool(server, state, registered, binding, auth);
    assertRegisteredMcpToolInventory(server, state);
    return instrumented;
  };

  const rawRegisterTool = internal.registerTool.bind(server);
  internal.registerTool = (toolName: string, toolConfig: Record<string, unknown>, handler: unknown) => {
    assertMcpToolIsMapped(toolName);
    if (typeof handler !== 'function') {
      throw new Error(`MCP tool "${toolName}" must register a function handler through the permission boundary`);
    }
    const inputSchema = normalizeMcpInputSchema(toolConfig.inputSchema, toolConfig.inputSchema !== undefined);
    const binding: McpToolGuardBinding = { toolName, inputSchema };
    const guardedConfig = inputSchema
      ? { ...toolConfig, inputSchema: sdkModernInputSchema(toolConfig.inputSchema, inputSchema) }
      : toolConfig;
    const registered = rawRegisterTool(
      toolName,
      guardedConfig,
      guardMcpToolHandler(binding, auth, handler as (...args: any[]) => any),
    );
    state.toolNames.add(toolName);
    const instrumented = instrumentRegisteredMcpTool(server, state, registered, binding, auth);
    assertRegisteredMcpToolInventory(server, state);
    return instrumented;
  };

  internal[mcpPermissionBoundaryState] = state;
  internal[mcpPermissionBoundaryInstalled] = true;
}

export type { Services } from '../shared/services.js';

// Keep the MCP boundary contract identical to REST's `cardMoveSchema`: a
// move is either a lane move, a same-lane reposition, or both.  The legacy
// `server.tool()` overload only accepts a raw Zod shape, which cannot express
// this cross-field invariant. `registerTool()` accepts the complete schema.
const moveCardInputSchema = z.object({
  card_id: cardReferenceSchema,
  target_column_id: z.string().min(1).optional(),
  position: z.string().max(256).regex(/^(?:[a-z]+|0[a-z]+)$/).optional(),
  operator_override: z.boolean().optional().describe('Explicitly bypass card WIP and blocker rules when the authenticated caller has operator override authority'),
}).strict().refine(value => value.target_column_id !== undefined || value.position !== undefined, {
  message: 'target_column_id or position is required',
});

async function withMutationAudit<T>(
  services: Services,
  auth: AuthContext,
  entry: { action: string; target_type: string; target_id?: string; payload?: Record<string, unknown> }
    | ((result: T) => { action: string; target_type: string; target_id?: string; payload?: Record<string, unknown> }),
  mutate: (adapter?: DatabaseAdapter) => Promise<T>,
): Promise<T> {
  // An audited MCP mutation must never run without the root adapter that can
  // bind its audit row to the mutation. Test doubles and embedders must wire
  // the same dependency as production; failing here is deliberately before
  // mutate() so there is no unaudited side effect.
  if (!services.db) throw new Error('Atomic MCP mutation requires services.db');
  return services.db.transaction(async tx => {
    const result = await mutate(tx);
    const resolvedEntry = typeof entry === 'function' ? entry(result) : entry;
    await services.auditService.logAs(auth, resolvedEntry, tx);
    return result;
  });
}

/**
 * Derive the actor ID.
 *
 * MUS-23: caller-asserted identity via tool arguments is retired for
 * enforced (hosted, multi-tenant) mode — `agent_id` in tool args there is a
 * SELECTOR (validated server-side against the caller's owned agents), never
 * an identity claim. Reviving it there would reopen the impersonation hole
 * MUS-23 closed: any caller could claim to *be* a different registered
 * principal just by naming it in args.
 *
 * That hole doesn't exist in `open` mode: every caller already holds every
 * permission (see requirePermission's early return), so there is no
 * differential trust to spoof across. So — and ONLY when
 * `config.auth.mode === 'open'`, checked explicitly rather than inferred
 * from an absent principal — a caller-supplied `raw` identity hint
 * (`agent_id` / `author_id`) is accepted as a labeling convenience for
 * local, single-tenant installs. The authenticated principal, when present,
 * always wins regardless of mode.
 */
function resolveActor(auth: AuthContext, raw?: Record<string, unknown>): string | undefined {
  if (auth.principal) return auth.principal.id;
  if (config.auth.mode === 'open' && raw) {
    const candidate = raw.agent_id ?? raw.author_id;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function mayUseOperatorOverride(auth: AuthContext, requested: boolean | undefined): boolean {
  return requested === true && (config.auth.mode === 'open' || auth.is_operator_override);
}

/**
 * Like resolveActor but throws if no actor could be determined (enforced mode).
 * In open mode, returns undefined — the caller is unauthenticated.
 */
function requireActor(auth: AuthContext, context: string): string | undefined {
  const actorId = resolveActor(auth);
  if (!actorId) {
    if (config.auth.mode === 'enforced') {
      throw new Error(
        `Forbidden: tool "${context}" requires an authenticated actor, but no principal was resolved.`
      );
    }
  }
  return actorId;
}

/**
 * Row-level scope check for comment.update/comment.delete: a principal may
 * only edit/delete their own comments unless they hold workspace.admin.
 * Mirrors the update_card/move_card "own resource" pattern for junior_engineer
 * card scope — skipped entirely in open mode (no principal, no differential
 * trust to enforce across).
 */
async function requireCommentOwnershipOrAdmin(
  commentService: CommentService,
  auth: AuthContext,
  commentId: string,
  action: 'edit' | 'delete',
): Promise<void> {
  if (auth.permissions.includes('workspace.admin') || !auth.principal) return;
  const owns = await commentService.validateCommentOwnership(commentId, auth.principal.id);
  if (!owns) {
    throw new Error(`Forbidden: you may only ${action} your own comments (principal: ${auth.principal.id})`);
  }
}

export function createMcpServer(services: Services, req?: Request, auth: AuthContext = OPEN_AUTH_CONTEXT): McpServer {
  const server = new McpServer({
    name: 'muster',
    version: '1.0.0',
  });
  installMcpPermissionBoundary(server, auth);

  // Open mode has no authenticated request principal, so attributed calls
  // must carry the registered agent ID on every request. In enforced mode the
  // bearer/session principal is authoritative and this field is optional.
  const attributedAgentIdSchema = config.auth.mode === 'open'
    ? z.string().min(1).describe(
      'REQUIRED in open mode. Use the exact id returned by register_agent; registration does not bind later MCP requests to that identity. Never invent an ID.'
    )
    : z.string().optional().describe(
      'Optional in authenticated mode. The bearer/session principal is authoritative; any supplied value is ignored for attribution.'
    );

  // --- MCP Collaboration Prompts ---
  server.prompt('collaboration_protocol', {}, () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `# Muster — Standard Operating Protocol

All AI agents and human operators collaborating within Muster must follow this protocol:

1. **Identity Lookup, Re-Binding & Status**:
   - Upon connecting, call \`list_agents\` to check if an existing identity (or UI pre-registration like \`antigravity-client\`) exists.
   - If an existing or pre-registered agent is found, pass its \`id\` as \`agent_id\` when calling \`register_agent\` or issuing a \`heartbeat\` to re-bind and activate that identity instead of creating a duplicate row.
   - **Open mode is stateless:** capture the exact \`id\` returned by \`register_agent\` (or re-bound) and reuse it as \`agent_id\` on every \`heartbeat\` and \`add_comment\` call. Registration and heartbeat do not authenticate or bind later MCP requests. Never omit or invent this ID.
   - **Authenticated mode:** the bearer token identifies the caller. Muster derives attribution from that principal instead of trusting a caller-supplied ID.
   - Emit periodic \`heartbeat\` pings to maintain 'active' status.

2. **Design Specifications & Knowledge Bases First**:
   - Before executing tasks, call \`list_documents\` to inspect approved system specs.
   - Check Knowledge Bases: Call \`list_knowledge_bases\` and \`search_knowledge\` (or \`get_entity_knowledge\`) for the project to inspect existing domain knowledge, facts, constraints, entities, and gotchas before planning or implementation.
   - Record Gained Knowledge: When discovering new facts, system specs, constraints, or entity relations during work, add them to the Knowledge Base via \`add_gained_knowledge\` or \`upsert_kb_entity\`.
   - If architectural changes are required, create or update a document via \`create_document\` / \`update_document\` and submit for review (\`set_document_status\` → 'in_review').

3. **Kanban Card Workflow & Flexible Board Structures**:
   - Boards are flexible and may have 3 lanes ('To Do' → 'In Progress' → 'Done'), standard 5 lanes, or custom columns. Inspect the active board layout via \`get_board\`.
   - Call \`list_cards\` or \`get_board\` to find unassigned cards in initial state columns ('To Do' / 'Backlog'). When you know only part of a card title, use \`search_cards\` with the project ID and title query.
   - When starting work on a task, call \`claim_card\` to record yourself as the assignee and create the work lease, then call \`move_card\` to advance it to the next active-work lane—normally 'In Progress'. Always respect column WIP limits; the server rejects over-limit creates/moves and unresolved blockers on claims or moves into 'In Progress'.

4. **Mandatory Progress Comments on Cards**:
   - Agents **MUST ALWAYS** log their progress as comments directly on the target card using \`add_comment\`.
   - Post card comments for task pickup, sub-task completions, intermediate milestones, blockers, architectural decisions, and test/verification results.
   - Always state current work using full human-readable task titles and work summaries out loud (e.g. \`Working on Muster Task "Create user authentication middleware"\`), never raw ID strings like \`Work on card #01J3K...\`.
   - On a local/open-mode install, \`agent_id\` is REQUIRED on every \`add_comment\` call: pass the exact \`id\` returned by \`register_agent\`. You can edit or delete your own comments afterward with \`update_comment\` / \`delete_comment\`.

5. **Peer Review & Task Completion**:
   - Before moving a card to 'In Review', attach the branch, pull request, or commit you worked on via \`add_work_link\` — the human operator should never have to go find the work themselves.
   - When implementation is completed, if an 'In Review' column exists on the board, move the card to 'In Review' for verification. If no 'In Review' column exists (e.g. 3-lane board), post verification notes and move directly to 'Done'.`,
        },
      },
    ],
  }));

  // --- Project Tools ---
  server.tool('list_projects', {
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('list_projects', auth, async ({ cursor, limit }) => {
    const projects = await services.projectService.listPage({ cursor, limit });
    return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
  }));

  server.tool('create_project', { name: z.string(), description: z.string().optional() }, withPermission('create_project', auth, async (args) => {
    const project = await services.projectService.create(args, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
  }));

  server.tool('get_project_summary', { project_id: z.string() }, withPermission('get_project_summary', auth, async ({ project_id }) => {
    const summary = await services.projectService.getSummary(project_id);
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }));

  server.tool(
    'update_project',
    {
      project_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
    },
    withPermission('update_project', auth, async ({ project_id, ...data }) => {
      const project = await services.projectService.update(project_id, data, resolveActor(auth));
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    })
  );

  server.tool('delete_project', { project_id: z.string() }, withPermission('delete_project', auth, async ({ project_id }) => {
    await withMutationAudit(services, auth, {
      action: 'project.delete',
      target_type: 'project',
      target_id: project_id,
    }, tx => services.projectService.delete(project_id, resolveActor(auth), tx));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Project ${project_id} deleted` }) }] };
  }));

  // --- Board & Column Tools ---
  server.tool('list_boards', {
    project_id: z.string(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('list_boards', auth, async ({ project_id, cursor, limit }) => {
    const boards = await services.boardService.listPage(project_id, { cursor, limit });
    return { content: [{ type: 'text', text: JSON.stringify(boards, null, 2) }] };
  }));

  server.tool(
    'create_board',
    {
      project_id: z.string(),
      name: z.string(),
      template: z.enum(['simple', 'standard']).optional(),
      columns: z.array(z.string()).optional(),
    },
    withPermission('create_board', auth, async (args) => {
      const board = await services.boardService.create(args, resolveActor(auth));
      return { content: [{ type: 'text', text: JSON.stringify(board, null, 2) }] };
    })
  );

  server.tool('update_board', { board_id: z.string(), name: z.string() }, withPermission('update_board', auth, async ({ board_id, name }) => {
    const board = await services.boardService.update(board_id, { name }, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify(board, null, 2) }] };
  }));

  server.tool('delete_board', { board_id: z.string() }, withPermission('delete_board', auth, async ({ board_id }) => {
    await services.boardService.delete(board_id, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Board ${board_id} deleted` }) }] };
  }));

  server.tool('get_board', { board_id: z.string() }, withPermission('get_board', auth, async ({ board_id }) => {
    const board = await services.boardService.getById(board_id);
    if (!board) throw new Error(`Board ${board_id} not found`);

    const columns = await services.columnService.list(board_id);
    const cards = await services.cardService.listPage({ board_id });

    return {
      content: [{ type: 'text', text: JSON.stringify({ ...board, columns, cards: cards.items, card_page: cards.page }, null, 2) }],
    };
  }));

  server.tool('create_column', {
    board_id: z.string(),
    name: z.string(),
    position: z.string().optional(),
    wip_limit: z.number().optional()
  }, withPermission('create_column', auth, async (args) => {
    const col = await services.columnService.create(args);
    return { content: [{ type: 'text', text: JSON.stringify(col, null, 2) }] };
  }));

  server.tool('update_column', {
    column_id: z.string(),
    name: z.string().optional(),
    wip_limit: z.number().nullable().optional(),
    position: z.string().optional()
  }, withPermission('update_column', auth, async ({ column_id, ...data }) => {
    const col = await services.columnService.update(column_id, data);
    return { content: [{ type: 'text', text: JSON.stringify(col, null, 2) }] };
  }));

  server.tool('move_column', { column_id: z.string(), position: z.string() }, withPermission('move_column', auth, async ({ column_id, position }) => {
    const col = await services.columnService.update(column_id, { position });
    return { content: [{ type: 'text', text: JSON.stringify(col, null, 2) }] };
  }));

  server.tool('delete_column', { column_id: z.string() }, withPermission('delete_column', auth, async ({ column_id }) => {
    await services.columnService.delete(column_id);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Column ${column_id} deleted` }) }] };
  }));

  // --- Card Tools ---
  server.tool('list_cards', {
    board_id: z.string().optional(),
    project_id: z.string().optional(),
    column_id: z.string().optional(),
    assignee_id: z.string().optional(),
    label: z.string().optional(),
    archived: z.boolean().optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional().describe('Opaque continuation cursor returned by the previous page'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size; defaults to 50 and cannot exceed 100'),
  }, withPermission('list_cards', auth, async ({ cursor, limit, ...filters }) => {
    const cards = await services.cardService.listPage(filters, { cursor, limit });
    return { content: [{ type: 'text', text: JSON.stringify(cards, null, 2) }] };
  }));

  server.tool('search_cards', {
    project_id: z.string().min(1).describe('Project whose active cards should be searched'),
    query: z.string().trim().min(1).describe('Literal, case-insensitive substring to match against card titles'),
    exclude_card_id: cardReferenceSchema.optional().describe('Optional card ULID or human-readable key to omit from results'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum results to return; defaults to 20 and cannot exceed 100'),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional().describe('Opaque continuation cursor returned by the previous page'),
  }, withPermission('search_cards', auth, async ({ project_id, query, exclude_card_id, limit, cursor }) => {
    const cards = await services.cardService.searchByTitlePage(project_id, query, {
      excludeCardId: exclude_card_id,
      limit,
      cursor,
    });
    return { content: [{ type: 'text', text: JSON.stringify(cards, null, 2) }] };
  }));

  server.tool('create_card', mcpCardCreateInputSchema.shape, withPermission('create_card', auth, async ({ operator_override, ...args }) => {
    const card = await services.cardService.create(args, resolveActor(auth), {
      operatorOverride: mayUseOperatorOverride(auth, operator_override),
    });
    return { content: [{ type: 'text', text: JSON.stringify(card, null, 2) }] };
  }));

  server.tool('get_card', {
    card_id: cardReferenceSchema,
  }, withPermission('get_card', auth, async ({ card_id }) => {
    const details = await services.cardService.getById(card_id);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('update_card', {
    card_id: cardReferenceSchema,
    title: z.string().optional(),
    description: z.string().optional(),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    due_date: z.string().nullable().optional(),
    is_epic: z.boolean().optional().describe('Marks this card as a container for related work'),
    operator_override: z.boolean().optional().describe('Explicitly bypass card WIP rules when the authenticated caller has operator override authority'),
  }, withPermission('update_card', auth, async ({ card_id, operator_override, ...data }) => {
    const details = await services.cardService.update(card_id, data, resolveActor(auth), {
      operatorOverride: mayUseOperatorOverride(auth, operator_override),
      auth,
    });
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.registerTool('move_card', { inputSchema: moveCardInputSchema }, withPermission('move_card', auth, async ({ card_id, target_column_id, position, operator_override }) => {
    const details = await services.cardService.move(card_id, { target_column_id, position }, resolveActor(auth), {
      operatorOverride: mayUseOperatorOverride(auth, operator_override),
      auth,
    });
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('claim_card', {
    card_id: cardReferenceSchema,
    agent_id: z.string().describe('Required — the principal/agent ID claiming the card. This also records the assignee and work lease. After a successful claim, call move_card to advance it to the next active-work lane.'),
    ttl_seconds: z.number().optional().describe('Lease duration in seconds; defaults to 600 (10 minutes)'),
    operator_override: z.boolean().optional().describe('Explicitly bypass blocker rules when the authenticated caller has operator override authority'),
  }, withPermission('claim_card', auth, async ({ card_id, agent_id, ttl_seconds, operator_override }) => {
    const result = await services.cardService.claim(card_id, agent_id, ttl_seconds, resolveActor(auth) || agent_id, {
      operatorOverride: mayUseOperatorOverride(auth, operator_override),
      auth,
    });
    const response = 'success' in result && result.success === false
      ? result
      : {
          ...result,
          next_action: "Claim complete: assignment and work lease recorded. Immediately call move_card to advance this card to the next active-work lane (normally 'In Progress').",
        };
    return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
  }));

  server.tool('assign_card', { card_id: cardReferenceSchema, agent_id: z.string() }, withPermission('assign_card', auth, async ({ card_id, agent_id }) => {
    await services.cardService.assign(card_id, agent_id, resolveActor(auth), auth);
    const details = await services.cardService.getById(card_id);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('unassign_card', { card_id: cardReferenceSchema, agent_id: z.string() }, withPermission('unassign_card', auth, async ({ card_id, agent_id }) => {
    await services.cardService.unassign(card_id, agent_id, resolveActor(auth), auth);
    const details = await services.cardService.getById(card_id);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('add_comment', {
    card_id: cardReferenceSchema,
    content: z.string(),
    author_id: z.string().optional().describe(
      'Deprecated alias retained for compatibility. Open-mode MCP clients must pass agent_id; authenticated-mode attribution comes from the bearer/session principal.'
    ),
    agent_id: attributedAgentIdSchema,
  }, withPermission('add_comment', auth, async (args) => {
    // author_id/agent_id in args are only ever honored by resolveActor() in
    // open mode (see its doc comment) — the authenticated principal wins otherwise.
    const author_id = resolveActor(auth, args);
    const comment = await services.commentService.create({ ...args, author_id });
    return { content: [{ type: 'text', text: JSON.stringify(comment, null, 2) }] };
  }));

  server.tool('update_comment', {
    comment_id: z.string(),
    content: z.string(),
  }, withPermission('update_comment', auth, async ({ comment_id, content }) => {
    await requireCommentOwnershipOrAdmin(services.commentService, auth, comment_id, 'edit');
    const comment = await services.commentService.update(comment_id, content, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify(comment, null, 2) }] };
  }));

  server.tool('delete_comment', {
    comment_id: z.string(),
  }, withPermission('delete_comment', auth, async ({ comment_id }) => {
    await requireCommentOwnershipOrAdmin(services.commentService, auth, comment_id, 'delete');
    await services.commentService.delete(comment_id, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Comment ${comment_id} deleted` }) }] };
  }));

  server.tool('add_label', { card_id: cardReferenceSchema, label_id: z.string() }, withPermission('add_label', auth, async ({ card_id, label_id }) => {
    await services.cardService.addLabel(card_id, label_id, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
  }));

  server.tool('remove_label', { card_id: cardReferenceSchema, label_id: z.string() }, withPermission('remove_label', auth, async ({ card_id, label_id }) => {
    await services.cardService.removeLabel(card_id, label_id, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
  }));

  server.tool('archive_card', { card_id: cardReferenceSchema }, withPermission('archive_card', auth, async ({ card_id }) => {
    await services.cardService.archive(card_id, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
  }));

  server.tool('delete_card', { card_id: cardReferenceSchema }, withPermission('delete_card', auth, async ({ card_id }) => {
    await services.cardService.delete(card_id, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Card ${card_id} deleted` }) }] };
  }));

  server.tool('link_document_to_card', { card_id: cardReferenceSchema, document_id: z.string() }, withPermission('link_document_to_card', auth, async ({ card_id, document_id }) => {
    await services.cardService.linkDocument(card_id, document_id, resolveActor(auth));
    const details = await services.cardService.getById(card_id);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('unlink_document_from_card', { card_id: cardReferenceSchema, document_id: z.string() }, withPermission('unlink_document_from_card', auth, async ({ card_id, document_id }) => {
    await services.cardService.unlinkDocument(card_id, document_id, resolveActor(auth));
    const details = await services.cardService.getById(card_id);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('link_card', {
    card_id: cardReferenceSchema,
    target_card_id: cardReferenceSchema,
    relation_type: z.enum(['blocks', 'blocked_by', 'relates_to', 'duplicates', 'parent_of', 'child_of']),
  }, withPermission('link_card', auth, async ({ card_id, target_card_id, relation_type }) => {
    await services.cardService.linkCard(card_id, target_card_id, relation_type, resolveActor(auth));
    const details = await services.cardService.getById(card_id);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('unlink_card', { card_id: cardReferenceSchema, link_id: z.string() }, withPermission('unlink_card', auth, async ({ card_id, link_id }) => {
    await services.cardService.unlinkCard(card_id, link_id, resolveActor(auth));
    const details = await services.cardService.getById(card_id);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('add_work_link', {
    card_id: cardReferenceSchema,
    kind: z.enum(['branch', 'pull_request', 'commit', 'pipeline']),
    provider: z.enum(['forgejo', 'github', 'gitlab', 'other']),
    url: z.string(),
    external_ref: z.string().optional(),
    title: z.string().optional(),
    status: z.string().optional(),
  }, withPermission('add_work_link', auth, async ({ card_id, ...data }) => {
    await services.cardService.addWorkLink(card_id, data, resolveActor(auth));
    const details = await services.cardService.getById(card_id);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('remove_work_link', { card_id: cardReferenceSchema, link_id: z.string() }, withPermission('remove_work_link', auth, async ({ card_id, link_id }) => {
    await services.cardService.removeWorkLink(card_id, link_id, resolveActor(auth));
    const details = await services.cardService.getById(card_id);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('list_work_links', { card_id: cardReferenceSchema }, withPermission('list_work_links', auth, async ({ card_id }) => {
    const links = await services.cardService.listWorkLinks(card_id);
    return { content: [{ type: 'text', text: JSON.stringify(links, null, 2) }] };
  }));

  server.tool('create_label', { board_id: z.string(), name: z.string(), color: z.string() }, withPermission('create_label', auth, async (args) => {
    const result = await services.boardService.createLabel(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('list_labels', { board_id: z.string() }, withPermission('list_labels', auth, async ({ board_id }) => {
    const result = await services.boardService.listLabels(board_id);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  // --- Document Management Tools ---
  server.tool('list_documents', {
    project_id: z.string(),
    status: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('list_documents', auth, async ({ project_id, cursor, limit, ...filters }) => {
    const result = await services.documentService.listPage(project_id, filters, { cursor, limit });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('create_document', {
    project_id: z.string(),
    title: z.string(),
    content: z.string(),
    parent_id: z.string().optional(),
  }, withPermission('create_document', auth, async (args) => {
    const author_id = resolveActor(auth);
    const result = await services.documentService.create({ ...args, author_id });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('get_document', {
    document_id: z.string(),
    version: z.number().int().positive().optional(),
  }, withPermission('get_document', auth, async ({ document_id, version }) => {
    const result = await services.documentService.getById(document_id, version);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('update_document', {
    document_id: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    change_summary: z.string().optional(),
  }, withPermission('update_document', auth, async ({ document_id, ...data }) => {
    const author_id = resolveActor(auth);
    const result = await services.documentService.update(document_id, { ...data, author_id });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('set_document_status', {
    document_id: z.string(),
    status: z.enum(['in_review', 'approved']),
    expected_version: z.number().int().positive(),
  }, withPermission('set_document_status', auth, async ({ document_id, status, expected_version }) => {
    const result = await services.documentService.setStatus(document_id, { status, expected_version }, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('get_document_history', {
    document_id: z.string(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('get_document_history', auth, async ({ document_id, cursor, limit }) => {
    const result = await services.documentService.getHistoryPage(document_id, { cursor, limit });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('delete_document', { document_id: z.string() }, withPermission('delete_document', auth, async ({ document_id }) => {
    await services.documentService.delete(document_id, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Document ${document_id} deleted` }) }] };
  }));

  // --- Agent Management Tools ---
  server.tool('register_agent', {
    agent_id: z.string().optional().describe('Existing Agent ID to re-bind session across runs'),
    name: z.string().optional().describe('Agent name'),
    capabilities: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.enum(['active', 'idle', 'offline']).optional(),
    type: z.enum(['ai_agent', 'human']).optional().describe(
      'Deprecated compatibility field. This endpoint only creates AI agents; human identities are established through OIDC admission.'
    ),
    role: z.string().trim().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/).optional().describe(
      'Deprecated compatibility field. In authenticated mode the server derives an agent role from the authenticated operator and never trusts this value.'
    ),
    secret_token: z.string().min(1).max(2048).optional().describe(
      'Deprecated compatibility field retained for legacy clients. It is ignored and never persisted or used for authentication.'
    ),
  }, withPermission('register_agent', auth, async (args) => {
    const {
      type: legacyType,
      role: legacyRole,
      secret_token: legacySecretToken,
      ...registration
    } = args;
    if (legacyType === 'human') {
      throw new Error('register_agent only creates AI agent identities; human identities must authenticate through OIDC admission.');
    }
    // Explicitly discard historical caller-controlled authority fields before
    // reaching the domain service. They remain accepted so the documented
    // AOP registration example works, but neither can select an identity,
    // authenticated role, or credential.
    void legacyRole;
    void legacySecretToken;
    // MUS-23: bind agent to the authenticated operator
    const operatorUserId = auth.principal?.kind === 'user' ? auth.principal.id : undefined;
    const result = await services.agentService.register(
      registration,
      operatorUserId,
      undefined,
      auth.workspace_id || undefined,
      config.auth.mode === 'enforced' ? auth : null,
    );
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('update_agent', {
    agent_id: z.string(),
    name: z.string().optional(),
    capabilities: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.enum(['active', 'idle', 'offline']).optional(),
  }, withPermission('update_agent', auth, async ({ agent_id, ...data }) => {
    const agent = await services.agentService.update(agent_id, data, {
      workspaceId: auth.workspace_id || undefined,
      auth,
    });
    return { content: [{ type: 'text', text: JSON.stringify(agent, null, 2) }] };
  }));

  server.tool('unregister_agent', { agent_id: z.string() }, withPermission('unregister_agent', auth, async ({ agent_id }) => {
    await services.agentService.assertAgentScope(agent_id, auth, 'agent.manage_others');
    await withMutationAudit(services, auth, {
      action: 'agent.unregister',
      target_type: 'agent',
      target_id: agent_id,
    }, tx => services.agentService.unregister(agent_id, resolveActor(auth), tx, auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Agent ${agent_id} unregistered.` }) }] };
  }));

  server.tool('heartbeat', {
    agent_id: z.string().min(1).describe(
      'REQUIRED. Use the exact id returned by register_agent. In open mode, registration does not bind later MCP requests, so this ID must be sent with every heartbeat.'
    ),
  }, withPermission('heartbeat', auth, async ({ agent_id }) => {
    const result = await services.agentService.heartbeat(agent_id, auth);
    await services.cardService.renewClaims(agent_id);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('list_agents', {
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('list_agents', auth, async ({ cursor, limit }) => {
    const result = await services.agentService.listPage(config.auth.mode === 'enforced' ? auth.workspace_id : undefined, { cursor, limit });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  // --- Event & Activity Tools ---
  server.tool('get_activity', {
    project_id: z.string(),
    entity_type: z.string().optional(),
    entity_id: z.string().optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('get_activity', auth, async ({ project_id, cursor, limit, ...filters }) => {
    const result = await services.eventService.listPage(project_id, filters, { cursor, limit });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  // --- Knowledge Base Tools ---
  server.tool('list_knowledge_bases', {
    project_id: z.string().optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('list_knowledge_bases', auth, async ({ project_id, cursor, limit }) => {
    const kbs = await services.kbService.listPage(project_id, { cursor, limit });
    return { content: [{ type: 'text', text: JSON.stringify(kbs, null, 2) }] };
  }));

  server.tool('create_knowledge_base', {
    name: z.string(),
    description: z.string().optional(),
    is_global: z.boolean().optional(),
    project_ids: z.array(z.string()).optional(),
    agent_id: z.string().optional(),
  }, withPermission('create_knowledge_base', auth, async (args) => {
    const kb = await services.kbService.create(args, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify(kb, null, 2) }] };
  }));

  server.tool('link_knowledge_base', {
    kb_id: z.string(),
    project_id: z.string(),
    agent_id: z.string().optional(),
  }, withPermission('link_knowledge_base', auth, async (args) => {
    await services.kbService.linkProject(args.kb_id, args.project_id, resolveActor(auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `KB ${args.kb_id} linked to project ${args.project_id}` }) }] };
  }));

  server.tool('search_knowledge', {
    query: z.string(),
    kb_id: z.string().optional(),
    project_id: z.string().optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('search_knowledge', auth, async ({ query, kb_id, project_id, cursor, limit }) => {
    let kbIds: string[] | undefined;
    if (kb_id) {
      kbIds = [kb_id];
    } else if (project_id) {
      const kbs = await services.kbService.list(project_id);
      kbIds = kbs.map(k => k.id);
    }
    const results = await services.kbService.searchKnowledgePage(query, kbIds, { cursor, limit });
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }));

  server.tool('get_entity_knowledge', {
    query: z.string().describe('Entity ID, canonical identifier (IP, email, hostname), or entity name'),
    kb_id: z.string().optional()
  }, withPermission('get_entity_knowledge', auth, async ({ query, kb_id }) => {
    const result = await services.kbService.getEntityKnowledge(query, kb_id ? [kb_id] : undefined);
    if (!result) return { content: [{ type: 'text', text: `No entity knowledge found for \"${query}\"` }] };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('get_gained_knowledge', {
    fact_id: z.string().min(1).describe('Knowledge fact ID returned by list or search summaries'),
  }, withPermission('get_gained_knowledge', auth, async ({ fact_id }) => {
    const fact = await services.kbService.getFactById(fact_id);
    if (!fact) throw new Error(`Knowledge fact ${fact_id} not found`);
    return { content: [{ type: 'text', text: JSON.stringify(fact, null, 2) }] };
  }));

  server.tool('add_gained_knowledge', {
    kb_id: z.string(),
    title: z.string(),
    content: z.string(),
    category: z.string().optional(),
    entity_id: z.string().optional(),
    entity_name: z.string().optional(),
    entity_type: z.string().optional(),
    entity_identifier: z.string().optional(),
    confidence: z.number().optional(),
    agent_id: z.string().optional(),
  }, withPermission('add_gained_knowledge', auth, async (args) => {
    const actorId = resolveActor(auth);
    const fact = await services.kbService.addFact(args, actorId);
    return { content: [{ type: 'text', text: JSON.stringify(fact, null, 2) }] };
  }));

  server.tool('upsert_kb_entity', {
    kb_id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    identifier: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    agent_id: z.string().optional(),
  }, withPermission('upsert_kb_entity', auth, async (args) => {
    const actorId = resolveActor(auth);
    const entity = await services.kbService.upsertEntity(args, actorId);
    return { content: [{ type: 'text', text: JSON.stringify(entity, null, 2) }] };
  }));

  server.tool('update_gained_knowledge', {
    fact_id: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    category: z.string().optional(),
    entity_id: z.string().optional(),
    entity_name: z.string().optional(),
    entity_type: z.string().optional(),
    entity_identifier: z.string().optional(),
    confidence: z.number().optional(),
    agent_id: z.string().optional(),
  }, withPermission('update_gained_knowledge', auth, async ({ fact_id, ...data }) => {
    const actorId = resolveActor(auth);
    const fact = await services.kbService.updateFact(fact_id, data, actorId);
    return { content: [{ type: 'text', text: JSON.stringify(fact, null, 2) }] };
  }));

  server.tool('update_kb_entity', {
    entity_id: z.string(),
    name: z.string().optional(),
    type: z.string().optional(),
    identifier: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    agent_id: z.string().optional(),
  }, withPermission('update_kb_entity', auth, async ({ entity_id, ...data }) => {
    const actorId = resolveActor(auth);
    const entity = await services.kbService.updateEntity(entity_id, data, actorId);
    return { content: [{ type: 'text', text: JSON.stringify(entity, null, 2) }] };
  }));

  server.tool('add_kb_relation', {
    kb_id: z.string(),
    source_entity_id: z.string(),
    target_entity_id: z.string(),
    relation_type: z.string(),
    description: z.string().optional(),
    agent_id: z.string().optional(),
  }, withPermission('add_kb_relation', auth, async (args) => {
    const actorId = resolveActor(auth);
    const relation = await services.kbService.addRelation(args, actorId);
    return { content: [{ type: 'text', text: JSON.stringify(relation, null, 2) }] };
  }));

  // --- Role Management Tools ---
  server.tool('list_roles', {
    workspace_id: z.string(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('list_roles', auth, async ({ workspace_id, cursor, limit }) => {
    const roles = await services.roleService.listPage(workspace_id, { cursor, limit });
    return { content: [{ type: 'text', text: JSON.stringify(roles, null, 2) }] };
  }));

  server.tool('get_role', { role_id: z.string() }, withPermission('get_role', auth, async ({ role_id }) => {
    const role = await services.roleService.getById(role_id);
    if (!role) throw new Error(`Role ${role_id} not found`);
    return { content: [{ type: 'text', text: JSON.stringify(role, null, 2) }] };
  }));

  server.tool('create_role', {
    workspace_id: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string().optional(),
    permissions: z.array(z.string()),
    rank: z.number().optional(),
  }, withPermission('create_role', auth, async (args) => {
    const role = await withMutationAudit(services, auth, (role: Awaited<ReturnType<RoleService['create']>>) => ({
      action: 'role.create',
      target_type: 'role',
      target_id: role.id,
      payload: { workspace_id: args.workspace_id, key: role.key, name: role.name },
    }), tx => services.roleService.create(args, tx));
    return { content: [{ type: 'text', text: JSON.stringify(role, null, 2) }] };
  }));

  server.tool('update_role', {
    role_id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    permissions: z.array(z.string()).optional(),
    rank: z.number().optional(),
  }, withPermission('update_role', auth, async ({ role_id, ...data }) => {
    const role = await withMutationAudit(services, auth, {
      action: 'role.update',
      target_type: 'role',
      target_id: role_id,
      payload: data,
    }, tx => services.roleService.update(role_id, data, tx));
    return { content: [{ type: 'text', text: JSON.stringify(role, null, 2) }] };
  }));

  server.tool('delete_role', { role_id: z.string() }, withPermission('delete_role', auth, async ({ role_id }) => {
    await withMutationAudit(services, auth, {
      action: 'role.delete',
      target_type: 'role',
      target_id: role_id,
    }, tx => services.roleService.delete(role_id, tx));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Role ${role_id} deleted` }) }] };
  }));

  server.tool('clone_role', {
    role_id: z.string(),
    new_key: z.string(),
    new_name: z.string().optional(),
  }, withPermission('clone_role', auth, async ({ role_id, new_key, new_name }) => {
    const role = await withMutationAudit(services, auth, (role: Awaited<ReturnType<RoleService['clone']>>) => ({
      action: 'role.clone',
      target_type: 'role',
      target_id: role.id,
      payload: { from: role_id, key: role.key, name: role.name },
    }), tx => services.roleService.clone(role_id, new_key, new_name, tx));
    return { content: [{ type: 'text', text: JSON.stringify(role, null, 2) }] };
  }));

  assertMcpToolPermissionInventory(server);
  return server;
}
