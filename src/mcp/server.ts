// File: src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z as zod } from 'zod';
import { RoleService } from '../services/index.js';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import { requirePermission, TOOL_PERMISSIONS, withPermission } from '../shared/permission-enforcer.js';
import type { Services } from '../shared/services.js';
import { config } from '../config/index.js';
import { Request } from 'express';
import {
  requireActor,
  resolveActor,
  withMutationAudit,
} from './tool-context.js';
import { registerCardTools } from './tools/card.tools.js';

const z = zod;
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


export function createMcpServer(services: Services, req?: Request, auth: AuthContext = OPEN_AUTH_CONTEXT): McpServer {
  const server = new McpServer({
    name: 'muster',
    version: '1.0.0',
  });
  installMcpPermissionBoundary(server, auth);

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
  server.tool('list_projects', {}, withPermission('list_projects', auth, async () => {
    const projects = await services.projectService.list(auth);
    return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
  }));

  server.tool('create_project', { name: z.string(), description: z.string().optional() }, withPermission('create_project', auth, async (args) => {
    const project = await services.projectService.create(args, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
  }));

  server.tool('get_project_summary', { project_id: z.string() }, withPermission('get_project_summary', auth, async ({ project_id }) => {
    const summary = await services.projectService.getSummary(project_id, auth);
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
      const project = await services.projectService.update(project_id, data, resolveActor(auth), undefined, auth);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    })
  );

  server.tool('delete_project', { project_id: z.string() }, withPermission('delete_project', auth, async ({ project_id }) => {
    await withMutationAudit(services, auth, {
      action: 'project.delete',
      target_type: 'project',
      target_id: project_id,
    }, tx => services.projectService.delete(project_id, resolveActor(auth), tx, auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Project ${project_id} deleted` }) }] };
  }));

  // --- Board & Column Tools ---
  server.tool('list_boards', { project_id: z.string() }, withPermission('list_boards', auth, async ({ project_id }) => {
    const boards = await services.boardService.list(project_id, auth);
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
      const board = await services.boardService.create(args, resolveActor(auth), undefined, auth);
      return { content: [{ type: 'text', text: JSON.stringify(board, null, 2) }] };
    })
  );

  server.tool('update_board', { board_id: z.string(), name: z.string() }, withPermission('update_board', auth, async ({ board_id, name }) => {
    const board = await services.boardService.update(board_id, { name }, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(board, null, 2) }] };
  }));

  server.tool('delete_board', { board_id: z.string() }, withPermission('delete_board', auth, async ({ board_id }) => {
    await services.boardService.delete(board_id, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Board ${board_id} deleted` }) }] };
  }));

  server.tool('get_board', { board_id: z.string() }, withPermission('get_board', auth, async ({ board_id }) => {
    const board = await services.boardService.getById(board_id, auth);
    if (!board) throw new Error(`Board ${board_id} not found`);

    const columns = await services.columnService.list(board_id, auth);
    const cards = await services.cardService.list({ board_id }, auth);

    return {
      content: [{ type: 'text', text: JSON.stringify({ ...board, columns, cards }, null, 2) }],
    };
  }));

  server.tool('create_column', {
    board_id: z.string(),
    name: z.string(),
    position: z.string().optional(),
    wip_limit: z.number().optional()
  }, withPermission('create_column', auth, async (args) => {
    const col = await services.columnService.create(args, undefined, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(col, null, 2) }] };
  }));

  server.tool('update_column', {
    column_id: z.string(),
    name: z.string().optional(),
    wip_limit: z.number().nullable().optional(),
    position: z.string().optional()
  }, withPermission('update_column', auth, async ({ column_id, ...data }) => {
    const col = await services.columnService.update(column_id, data, undefined, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(col, null, 2) }] };
  }));

  server.tool('move_column', { column_id: z.string(), position: z.string() }, withPermission('move_column', auth, async ({ column_id, position }) => {
    const col = await services.columnService.update(column_id, { position }, undefined, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(col, null, 2) }] };
  }));

  server.tool('delete_column', { column_id: z.string() }, withPermission('delete_column', auth, async ({ column_id }) => {
    await services.columnService.delete(column_id, undefined, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Column ${column_id} deleted` }) }] };
  }));

  // Card/comment/link/label schemas and handlers live together so their
  // transport contract can evolve without reopening unrelated domains.
  registerCardTools({ server, services, auth });
  // --- Document Management Tools ---
  server.tool('list_documents', {
    project_id: z.string(),
    status: z.string().optional(),
    parent_id: z.string().nullable().optional()
  }, withPermission('list_documents', auth, async ({ project_id, ...filters }) => {
    const result = await services.documentService.list(project_id, filters, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('create_document', {
    project_id: z.string(),
    title: z.string(),
    content: z.string(),
    parent_id: z.string().optional(),
  }, withPermission('create_document', auth, async (args) => {
    const author_id = resolveActor(auth);
    const result = await services.documentService.create({ ...args, author_id }, undefined, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('get_document', { document_id: z.string() }, withPermission('get_document', auth, async ({ document_id }) => {
    const result = await services.documentService.getById(document_id, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('update_document', {
    document_id: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    change_summary: z.string().optional(),
  }, withPermission('update_document', auth, async ({ document_id, ...data }) => {
    const author_id = resolveActor(auth);
    const result = await services.documentService.update(document_id, { ...data, author_id }, undefined, undefined, auth);
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

  server.tool('get_document_history', { document_id: z.string() }, withPermission('get_document_history', auth, async ({ document_id }) => {
    const result = await services.documentService.getHistory(document_id, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('delete_document', { document_id: z.string() }, withPermission('delete_document', auth, async ({ document_id }) => {
    await services.documentService.delete(document_id, resolveActor(auth), undefined, auth);
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

  server.tool('list_agents', {}, withPermission('list_agents', auth, async () => {
    const result = await services.agentService.list(auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  // --- Event & Activity Tools ---
  server.tool('get_activity', {
    project_id: z.string(),
    entity_type: z.string().optional(),
    entity_id: z.string().optional(),
    limit: z.number().optional()
  }, withPermission('get_activity', auth, async ({ project_id, ...filters }) => {
    const result = await services.eventService.list(project_id, filters, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  // --- Knowledge Base Tools ---
  server.tool('list_knowledge_bases', { project_id: z.string().optional() }, withPermission('list_knowledge_bases', auth, async ({ project_id }) => {
    const kbs = await services.kbService.list(project_id, auth);
    return { content: [{ type: 'text', text: JSON.stringify(kbs, null, 2) }] };
  }));

  server.tool('create_knowledge_base', {
    name: z.string(),
    description: z.string().optional(),
    is_global: z.boolean().optional(),
    project_ids: z.array(z.string()).optional(),
    agent_id: z.string().optional(),
  }, withPermission('create_knowledge_base', auth, async (args) => {
    const kb = await services.kbService.create(args, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(kb, null, 2) }] };
  }));

  server.tool('link_knowledge_base', {
    kb_id: z.string(),
    project_id: z.string(),
    agent_id: z.string().optional(),
  }, withPermission('link_knowledge_base', auth, async (args) => {
    await services.kbService.linkProject(args.kb_id, args.project_id, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `KB ${args.kb_id} linked to project ${args.project_id}` }) }] };
  }));

  server.tool('search_knowledge', {
    query: z.string(),
    kb_id: z.string().optional(),
    project_id: z.string().optional(),
    limit: z.number().optional()
  }, withPermission('search_knowledge', auth, async ({ query, kb_id, project_id, limit }) => {
    let kbIds: string[] | undefined;
    if (kb_id) {
      kbIds = [kb_id];
    } else if (project_id) {
      const kbs = await services.kbService.list(project_id, auth);
      kbIds = kbs.map(k => k.id);
    }
    const results = await services.kbService.searchKnowledge(query, kbIds, limit, auth);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }));

  server.tool('get_entity_knowledge', {
    query: z.string().describe('Entity ID, canonical identifier (IP, email, hostname), or entity name'),
    kb_id: z.string().optional()
  }, withPermission('get_entity_knowledge', auth, async ({ query, kb_id }) => {
    const result = await services.kbService.getEntityKnowledge(query, kb_id ? [kb_id] : undefined, auth);
    if (!result) return { content: [{ type: 'text', text: `No entity knowledge found for \"${query}\"` }] };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
    const fact = await services.kbService.addFact(args, actorId, undefined, auth);
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
    const entity = await services.kbService.upsertEntity(args, actorId, undefined, auth);
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
    const fact = await services.kbService.updateFact(fact_id, data, actorId, undefined, auth);
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
    const entity = await services.kbService.updateEntity(entity_id, data, actorId, undefined, auth);
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
    const relation = await services.kbService.addRelation(args, actorId, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(relation, null, 2) }] };
  }));

  // --- Role Management Tools ---
  server.tool('list_roles', { workspace_id: z.string() }, withPermission('list_roles', auth, async ({ workspace_id }) => {
    const roles = await services.roleService.list(workspace_id, auth);
    return { content: [{ type: 'text', text: JSON.stringify(roles, null, 2) }] };
  }));

  server.tool('get_role', { role_id: z.string() }, withPermission('get_role', auth, async ({ role_id }) => {
    const role = await services.roleService.getById(role_id, auth);
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
    }), tx => services.roleService.create(args, tx, auth));
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
    }, tx => services.roleService.update(role_id, data, tx, auth));
    return { content: [{ type: 'text', text: JSON.stringify(role, null, 2) }] };
  }));

  server.tool('delete_role', { role_id: z.string() }, withPermission('delete_role', auth, async ({ role_id }) => {
    await withMutationAudit(services, auth, {
      action: 'role.delete',
      target_type: 'role',
      target_id: role_id,
    }, tx => services.roleService.delete(role_id, tx, auth));
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
    }), tx => services.roleService.clone(role_id, new_key, new_name, tx, auth));
    return { content: [{ type: 'text', text: JSON.stringify(role, null, 2) }] };
  }));

  assertMcpToolPermissionInventory(server);
  return server;
}
