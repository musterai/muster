// File: src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z as zod } from 'zod';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import { requirePermission, TOOL_PERMISSIONS } from '../shared/permission-enforcer.js';
import type { Services } from '../shared/services.js';
import { config } from '../config/index.js';
import { Request } from 'express';
import { registerCardTools } from './tools/card.tools.js';
import { registerWorkspaceTools } from './tools/workspace.tools.js';
import { registerDocumentTools } from './tools/document.tools.js';
import { registerAgentTools } from './tools/agent.tools.js';
import { registerKnowledgeTools } from './tools/knowledge.tools.js';
import { registerRoleTools } from './tools/role.tools.js';
import { cardLinkInstructions } from './card-links.js';

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
  const linkedCardGuidance = cardLinkInstructions();
  const server = new McpServer({
    name: 'muster',
    version: '1.0.0',
  }, {
    instructions: linkedCardGuidance,
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

**Linked Card References & Instance URL**:
   - ${linkedCardGuidance}

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
   - Boards are flexible and may use simple, standard, or custom lane layouts. Inspect each column's persisted workflow role via \`get_board\`; display names are presentation only.
   - Call \`list_cards\` or \`get_board\` to find unassigned cards in \`backlog\` or \`ready\` role columns. When you know only part of a card title, use \`search_cards\` with the project ID and title query.
   - When starting work on a task, call \`claim_card\` to record yourself as the assignee and create the work lease, then call \`move_card\` to advance it to the returned active workflow lane. Always respect column WIP limits; the server rejects over-limit creates/moves and unresolved blockers on claims or moves into any active lane.

4. **Mandatory Progress Comments on Cards**:
   - Agents **MUST ALWAYS** log their progress as comments directly on the target card using \`add_comment\`.
   - Post card comments for task pickup, sub-task completions, intermediate milestones, blockers, architectural decisions, and test/verification results.
   - Always state current work using full human-readable task titles and work summaries out loud (e.g. \`Working on Muster Task "Create user authentication middleware"\`), never raw ID strings like \`Work on card #01J3K...\`.
   - On a local/open-mode install, \`agent_id\` is REQUIRED on every \`add_comment\` call: pass the exact \`id\` returned by \`register_agent\`. You can edit or delete your own comments afterward with \`update_comment\` / \`delete_comment\`.

5. **Peer Review & Task Completion**:
   - Before moving a card to a \`review\` role lane, attach the branch, pull request, or commit you worked on via \`add_work_link\` — the human operator should never have to go find the work themselves.
   - When implementation is completed, if a \`review\` role column exists on the board, move the card there for verification. If no \`review\` role exists, post verification notes and move directly to a \`terminal\` role column.`,
        },
      },
    ],
  }));

  registerWorkspaceTools({ server, services, auth });
  registerCardTools({ server, services, auth });
  registerDocumentTools({ server, services, auth });
  registerAgentTools({ server, services, auth });
  registerKnowledgeTools({ server, services, auth });
  registerRoleTools({ server, services, auth });

  assertMcpToolPermissionInventory(server);
  return server;
}
