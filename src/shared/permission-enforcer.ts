// File: src/shared/permission-enforcer.ts
//
// Layer 1 — declarative permission boundary map.
// Every MCP tool and every REST route is mapped to its required permission verb.
// Unmapped entries are DENIED by default, so adding a new tool without mapping
// produces a loud 403 during development rather than a silent hole in production.
//
// Layer 2 — row-level scope checks for rules a flat verb map cannot express:
//   1. Junior engineers may update/move only cards they are assigned to.
//   2. An agent may only act as an agent whose operator_user_id matches the
//      authenticated principal.

import { AuthContext } from './auth-context.js';
import { Permission, ALL_PERMISSIONS } from './permissions.js';
import { config } from '../config/index.js';

// ============================================================
// PermissionError — structured, actionable refusal payload
// ============================================================

export interface PermissionRefusal {
  error: 'forbidden';
  required_permission: string;
  your_role: string | null;
  message: string;
}

export class PermissionDeniedError extends Error {
  public readonly refusal: PermissionRefusal;

  constructor(requiredPermission: string, roleName: string | null) {
    const message = `Forbidden: requires "${requiredPermission}" (your role: ${roleName || 'none'})`;
    super(message);
    this.name = 'PermissionDeniedError';
    this.refusal = {
      error: 'forbidden',
      required_permission: requiredPermission,
      your_role: roleName,
      message,
    };
  }
}

// ============================================================
// TOOL_PERMISSIONS — map every MCP tool name to its required permission
// ============================================================

/**
 * Permission spec for a tool or route.
 * - A static string: always requires that permission.
 * - A function: receives the tool arguments and returns the required permission.
 *   Used when the required verb depends on the operation (e.g. set_document_status).
 */
export const WORKSPACE_READ = 'workspace.read' as const;
export type AccessRequirement = Permission | typeof WORKSPACE_READ;
export type PermissionSpec = AccessRequirement | ((args: Record<string, unknown>) => AccessRequirement);

export const OPERATION_PERMISSIONS = {
  // ── Project Tools ──
  list_projects: WORKSPACE_READ,
  create_project: 'project.create',
  get_project_summary: WORKSPACE_READ,
  update_project: 'project.update',
  delete_project: 'project.delete',

  // ── Board & Column Tools ──
  list_boards: WORKSPACE_READ,
  get_board: WORKSPACE_READ,
  create_board: 'board.manage',
  update_board: 'board.manage',
  delete_board: 'board.manage',
  create_column: 'board.manage',
  update_column: 'board.manage',
  move_column: 'board.manage',
  delete_column: 'board.manage',

  // ── Card Tools ──
  list_cards: WORKSPACE_READ,
  search_cards: WORKSPACE_READ,
  get_card: WORKSPACE_READ,
  create_card: 'card.create',
  update_card: 'card.update',
  move_card: 'card.move',
  delete_card: 'card.delete',
  archive_card: 'card.archive',
  claim_card: 'card.claim',
  assign_card: (args) => {
    // If the card_id is present and user is assigning themselves, allow assign_self
    // The row-level check in Layer 2 handles the "own cards only" rule for junior_engineer.
    return 'card.assign_others';
  },
  unassign_card: 'card.assign_others',
  add_label: 'card.update',
  remove_label: 'card.update',
  link_card: 'card.update',
  unlink_card: 'card.update',
  add_work_link: 'card.update',
  remove_work_link: 'card.update',
  list_work_links: WORKSPACE_READ,
  link_document_to_card: 'card.update',
  unlink_document_from_card: 'card.update',

  // ── Label Tools ──
  create_label: 'label.manage',
  list_labels: WORKSPACE_READ,

  // ── Comment Tools ──
  add_comment: 'comment.create',
  update_comment: 'comment.update',
  delete_comment: 'comment.delete',

  // ── Document Tools ──
  list_documents: WORKSPACE_READ,
  create_document: 'doc.create',
  get_document: WORKSPACE_READ,
  update_document: 'doc.update',
  delete_document: 'doc.delete',
  set_document_status: (args) => {
    return args.status === 'approved' ? 'doc.approve' : 'doc.submit_review';
  },
  get_document_history: WORKSPACE_READ,

  // ── Agent Management Tools ──
  register_agent: 'agent.register',
  update_agent: 'agent.register',
  unregister_agent: 'agent.manage_others',
  heartbeat: WORKSPACE_READ,
  list_agents: WORKSPACE_READ,

  // ── KB Tools ──
  list_knowledge_bases: WORKSPACE_READ,
  create_knowledge_base: 'kb.write',
  link_knowledge_base: 'kb.write',
  search_knowledge: WORKSPACE_READ,
  get_entity_knowledge: WORKSPACE_READ,
  add_gained_knowledge: 'kb.write',
  upsert_kb_entity: 'kb.write',
  update_gained_knowledge: 'kb.write',
  update_kb_entity: 'kb.write',
  add_kb_relation: 'kb.write',

  // ── Role Management Tools ──
  list_roles: WORKSPACE_READ,
  get_role: WORKSPACE_READ,
  create_role: 'role.manage',
  update_role: 'role.manage',
  delete_role: 'role.manage',
  clone_role: 'role.manage',

  // ── Event Tools ──
  get_activity: WORKSPACE_READ,

  // ── REST-only operations ──
  // These remain named operations in the same policy catalog so their access
  // decisions cannot drift into a second, transport-specific permission map.
  health_check: WORKSPACE_READ,
  list_users: WORKSPACE_READ,
  update_member: 'member.manage',
  remove_member: 'member.manage',
  list_tokens: WORKSPACE_READ,
  create_token: WORKSPACE_READ,
  revoke_token: WORKSPACE_READ,
  lookup_device_authorization: WORKSPACE_READ,
  approve_device_authorization: 'project.create',
  deny_device_authorization: 'project.create',
  get_oauth_authorization_details: WORKSPACE_READ,
  consent_oauth_authorization: 'agent.register',
  get_audit_log: 'workspace.admin',
  list_invitations: 'member.invite',
  create_invitation: 'member.invite',
  delete_invitation: 'member.invite',

} satisfies Record<string, PermissionSpec>;

export type OperationName = keyof typeof OPERATION_PERMISSIONS;

/**
 * Backwards-compatible export for callers and tests that enumerate MCP tool
 * decisions. Permissions themselves live exclusively in
 * OPERATION_PERMISSIONS; REST routes reference operation names below.
 */
const REST_ONLY_OPERATIONS = new Set<OperationName>([
  'health_check',
  'list_users',
  'update_member',
  'remove_member',
  'list_tokens',
  'create_token',
  'revoke_token',
  'lookup_device_authorization',
  'approve_device_authorization',
  'deny_device_authorization',
  'get_oauth_authorization_details',
  'consent_oauth_authorization',
  'get_audit_log',
  'list_invitations',
  'create_invitation',
  'delete_invitation',
]);

export const TOOL_PERMISSIONS: Record<string, PermissionSpec> = Object.fromEntries(
  Object.entries(OPERATION_PERMISSIONS).filter(([operation]) => !REST_ONLY_OPERATIONS.has(operation as OperationName)),
);

// ============================================================
// REST ROUTE PERMISSIONS — map HTTP method + path pattern to permission
// ============================================================

export interface RoutePattern {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pattern: RegExp | string;
  operation: OperationName;
  /** Public routes are intentionally unauthenticated and must be exact. */
  public?: boolean;
}

/**
 * Route permission map for REST endpoints.
 * Patterns are checked in order; first match wins.
 * Read operations (GET with no side effects on the main entity) use the
 * workspace-read permission rather than a full write verb.
 */
export const REST_ROUTE_PERMISSIONS: RoutePattern[] = [
  // ── Health (always public) ──
  { method: 'GET', pattern: /^\/api\/v1\/health$/, operation: 'health_check', public: true },

  // ── Projects ──
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/summary$/, operation: 'get_project_summary' },
  { method: 'GET', pattern: /^\/api\/v1\/projects(?:\/[^/]+)?$/, operation: 'list_projects' },
  { method: 'POST', pattern: /^\/api\/v1\/projects$/, operation: 'create_project' },
  { method: 'PUT', pattern: /^\/api\/v1\/projects\/[^/]+$/, operation: 'update_project' },
  { method: 'DELETE', pattern: /^\/api\/v1\/projects\/[^/]+$/, operation: 'delete_project' },

  // ── Boards ──
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/(?:boards|all-boards)$/, operation: 'list_boards' },
  { method: 'GET', pattern: /^\/api\/v1\/boards\/[^/]+$/, operation: 'get_board' },
  { method: 'POST', pattern: /^\/api\/v1\/projects\/[^/]+\/boards$/, operation: 'create_board' },
  { method: 'PUT', pattern: /^\/api\/v1\/boards\/[^/]+$/, operation: 'update_board' },
  { method: 'DELETE', pattern: /^\/api\/v1\/boards\/[^/]+$/, operation: 'delete_board' },

  // ── Columns ──
  { method: 'POST', pattern: /^\/api\/v1\/boards\/[^/]+\/columns$/, operation: 'create_column' },
  { method: 'PUT', pattern: /^\/api\/v1\/columns\/[^/]+$/, operation: 'update_column' },
  { method: 'DELETE', pattern: /^\/api\/v1\/columns\/[^/]+$/, operation: 'delete_column' },

  // ── Cards ──
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/cards\/search$/, operation: 'search_cards' },
  { method: 'GET', pattern: /^\/api\/v1\/(?:projects\/[^/]+|boards\/[^/]+)\/cards$/, operation: 'list_cards' },
  { method: 'GET', pattern: /^\/api\/v1\/cards\/[^/]+$/, operation: 'get_card' },
  { method: 'GET', pattern: /^\/api\/v1\/cards\/[^/]+\/work-links$/, operation: 'list_work_links' },
  { method: 'POST', pattern: /^\/api\/v1\/columns\/[^/]+\/cards$/, operation: 'create_card' },
  { method: 'PUT', pattern: /^\/api\/v1\/cards\/[^/]+$/, operation: 'update_card' },
  { method: 'PATCH', pattern: /^\/api\/v1\/cards\/[^/]+\/move$/, operation: 'move_card' },
  { method: 'DELETE', pattern: /^\/api\/v1\/cards\/[^/]+$/, operation: 'delete_card' },
  { method: 'POST', pattern: /^\/api\/v1\/cards\/[^/]+\/claim$/, operation: 'claim_card' },
  { method: 'POST', pattern: /^\/api\/v1\/cards\/[^/]+\/assignees$/, operation: 'assign_card' },
  { method: 'DELETE', pattern: /^\/api\/v1\/cards\/[^/]+\/assignees\/[^/]+$/, operation: 'unassign_card' },
  { method: 'POST', pattern: /^\/api\/v1\/cards\/[^/]+\/labels$/, operation: 'add_label' },
  { method: 'DELETE', pattern: /^\/api\/v1\/cards\/[^/]+\/labels\/[^/]+$/, operation: 'remove_label' },
  { method: 'POST', pattern: /^\/api\/v1\/cards\/[^/]+\/comments$/, operation: 'add_comment' },
  { method: 'PUT', pattern: /^\/api\/v1\/cards\/[^/]+\/comments\/[^/]+$/, operation: 'update_comment' },
  { method: 'DELETE', pattern: /^\/api\/v1\/cards\/[^/]+\/comments\/[^/]+$/, operation: 'delete_comment' },
  { method: 'POST', pattern: /^\/api\/v1\/cards\/[^/]+\/documents$/, operation: 'link_document_to_card' },
  { method: 'DELETE', pattern: /^\/api\/v1\/cards\/[^/]+\/documents\/[^/]+$/, operation: 'unlink_document_from_card' },
  { method: 'POST', pattern: /^\/api\/v1\/cards\/[^/]+\/links$/, operation: 'link_card' },
  { method: 'DELETE', pattern: /^\/api\/v1\/cards\/[^/]+\/links\/[^/]+$/, operation: 'unlink_card' },
  { method: 'POST', pattern: /^\/api\/v1\/cards\/[^/]+\/work-links$/, operation: 'add_work_link' },
  { method: 'DELETE', pattern: /^\/api\/v1\/cards\/[^/]+\/work-links\/[^/]+$/, operation: 'remove_work_link' },

  // ── Documents ──
  { method: 'GET', pattern: /^\/api\/v1\/documents\/[^/]+\/versions$/, operation: 'get_document_history' },
  { method: 'GET', pattern: /^\/api\/v1\/documents\/[^/]+$/, operation: 'get_document' },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/documents$/, operation: 'list_documents' },
  { method: 'POST', pattern: /^\/api\/v1\/projects\/[^/]+\/documents$/, operation: 'create_document' },
  { method: 'PUT', pattern: /^\/api\/v1\/documents\/[^/]+$/, operation: 'update_document' },
  { method: 'DELETE', pattern: /^\/api\/v1\/documents\/[^/]+$/, operation: 'delete_document' },
  {
    method: 'PATCH',
    pattern: /^\/api\/v1\/documents\/[^/]+\/status$/,
    operation: 'set_document_status',
  },

  // ── Agents ──
  { method: 'GET', pattern: /^\/api\/v1\/agents$/, operation: 'list_agents' },

  // ── Users (MUS-32) — read-only workspace member list ──
  { method: 'GET', pattern: /^\/api\/v1\/users$/, operation: 'list_users' },

  // ── Members (MUS-26) — role change and removal ──
  { method: 'PUT', pattern: /^\/api\/v1\/workspaces\/[^/]+\/members\/[^/]+$/, operation: 'update_member' },
  { method: 'DELETE', pattern: /^\/api\/v1\/workspaces\/[^/]+\/members\/[^/]+$/, operation: 'remove_member' },
  { method: 'POST', pattern: /^\/api\/v1\/agents$/, operation: 'register_agent' },
  { method: 'POST', pattern: /^\/api\/v1\/agents\/[^/]+\/heartbeat$/, operation: 'heartbeat' },
  { method: 'PUT', pattern: /^\/api\/v1\/agents\/[^/]+$/, operation: 'update_agent' },
  { method: 'DELETE', pattern: /^\/api\/v1\/agents\/[^/]+$/, operation: 'unregister_agent' },

  // ── Roles ──
  { method: 'GET', pattern: /^\/api\/v1\/workspaces\/[^/]+\/roles$/, operation: 'list_roles' },
  { method: 'GET', pattern: /^\/api\/v1\/roles\/[^/]+$/, operation: 'get_role' },
  { method: 'POST', pattern: /^\/api\/v1\/workspaces\/[^/]+\/roles$/, operation: 'create_role' },
  { method: 'POST', pattern: /^\/api\/v1\/roles\/[^/]+\/clone$/, operation: 'clone_role' },
  { method: 'PUT', pattern: /^\/api\/v1\/roles\/[^/]+$/, operation: 'update_role' },
  { method: 'DELETE', pattern: /^\/api\/v1\/roles\/[^/]+$/, operation: 'delete_role' },

  // ── KB ──
  { method: 'GET', pattern: /^\/api\/v1\/kbs$/, operation: 'list_knowledge_bases' },
  { method: 'GET', pattern: /^\/api\/v1\/kbs\/search$/, operation: 'search_knowledge' },
  { method: 'GET', pattern: /^\/api\/v1\/kbs\/entity-knowledge$/, operation: 'get_entity_knowledge' },
  { method: 'GET', pattern: /^\/api\/v1\/kbs\/(?:graph|[^/]+(?:\/(?:entities|facts))?)$/, operation: 'get_entity_knowledge' },
  { method: 'POST', pattern: /^\/api\/v1\/kbs$/, operation: 'create_knowledge_base' },
  { method: 'POST', pattern: /^\/api\/v1\/kbs\/[^/]+\/link$/, operation: 'link_knowledge_base' },
  { method: 'POST', pattern: /^\/api\/v1\/kbs\/[^/]+\/unlink$/, operation: 'link_knowledge_base' },
  { method: 'POST', pattern: /^\/api\/v1\/kbs\/entities$/, operation: 'upsert_kb_entity' },
  { method: 'PUT', pattern: /^\/api\/v1\/kbs\/entities\/[^/]+$/, operation: 'update_kb_entity' },
  { method: 'DELETE', pattern: /^\/api\/v1\/kbs\/entities\/[^/]+$/, operation: 'update_kb_entity' },
  { method: 'POST', pattern: /^\/api\/v1\/kbs\/facts$/, operation: 'add_gained_knowledge' },
  { method: 'PUT', pattern: /^\/api\/v1\/kbs\/facts\/[^/]+$/, operation: 'update_gained_knowledge' },
  { method: 'DELETE', pattern: /^\/api\/v1\/kbs\/facts\/[^/]+$/, operation: 'update_gained_knowledge' },
  { method: 'POST', pattern: /^\/api\/v1\/kbs\/relations$/, operation: 'add_kb_relation' },
  { method: 'DELETE', pattern: /^\/api\/v1\/kbs\/relations\/[^/]+$/, operation: 'add_kb_relation' },
  { method: 'DELETE', pattern: /^\/api\/v1\/kbs\/[^/]+$/, operation: 'create_knowledge_base' },

  // ── Events ──
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/events(?:\/stream)?$/, operation: 'get_activity' },

  // ── Tokens (MUS-24) ──
  { method: 'GET', pattern: /^\/api\/v1\/tokens$/, operation: 'list_tokens' },
  { method: 'POST', pattern: /^\/api\/v1\/tokens$/, operation: 'create_token' },
  { method: 'DELETE', pattern: /^\/api\/v1\/tokens\/[^/]+$/, operation: 'revoke_token' },

  // ── Device Authorization Grant (MUS-28) — device/code and token are exempted in permissionGuard; these three run as the signed-in approver ──
  { method: 'GET', pattern: /^\/api\/v1\/oauth\/device\/lookup$/, operation: 'lookup_device_authorization' },
  { method: 'POST', pattern: /^\/api\/v1\/oauth\/device\/approve$/, operation: 'approve_device_authorization' },
  { method: 'POST', pattern: /^\/api\/v1\/oauth\/device\/deny$/, operation: 'deny_device_authorization' },

  // ── MCP-native OAuth (MUS-29) — register/authorize are exempted in permissionGuard; these two run as the signed-in approver ──
  { method: 'GET', pattern: /^\/api\/v1\/oauth\/authorize\/details$/, operation: 'get_oauth_authorization_details' },
  { method: 'POST', pattern: /^\/api\/v1\/oauth\/authorize\/consent$/, operation: 'consent_oauth_authorization' },

  // ── Audit log (MUS-30) — admin-only; a security record, not a collaboration feed ──
  { method: 'GET', pattern: /^\/api\/v1\/workspaces\/[^/]+\/audit-log$/, operation: 'get_audit_log' },

  // ── Invitations (MUS-25) — auth/login/callback/logout/me are exempted in permissionGuard ──
  { method: 'GET', pattern: /^\/api\/v1\/workspaces\/[^/]+\/invitations$/, operation: 'list_invitations' },
  { method: 'POST', pattern: /^\/api\/v1\/workspaces\/[^/]+\/invitations$/, operation: 'create_invitation' },
  { method: 'DELETE', pattern: /^\/api\/v1\/invitations\/[^/]+$/, operation: 'delete_invitation' },
];

// ============================================================
// resolvePermission — resolve a PermissionSpec against args
// ============================================================

export function resolvePermission(spec: PermissionSpec, args?: Record<string, unknown>): AccessRequirement {
  if (typeof spec === 'function') {
    return spec(args || {});
  }
  return spec;
}

// ============================================================
// getRoleNameForPrincipal — fetch the role name for an agent or user
// ============================================================

/**
 * Attempt to find the role name from the AuthContext's principal.
 * This is best-effort — returns null when the role is unknown.
 */
export function getRoleName(auth: AuthContext): string | null {
  return auth.role_name || null;
}

// ============================================================
// requirePermission — the core enforcement function
//
// Under MUSTER_AUTH_MODE=open all checks pass (local dev).
// Under enforced mode:
//   1. Look up the required permission for the tool/route.
//   2. If unmapped → DENY (default-deny).
//   3. If the auth context does not have the required permission → DENY.
//   4. Otherwise → ALLOW.
// ============================================================

export function requirePermission(
  toolName: string,
  auth: AuthContext,
  args?: Record<string, unknown>,
): void {
  // Open mode — everything permitted (local development)
  if (config.auth.mode === 'open') return;

  const spec = TOOL_PERMISSIONS[toolName];

  // Default-deny: unmapped tools are refused
  if (!spec) {
    throw new PermissionDeniedError('(unknown — unmapped tool)', auth.role_name || null);
  }

  const required = resolvePermission(spec, args);

  if (required === WORKSPACE_READ) {
    if (auth.is_workspace_member) return;
    throw new PermissionDeniedError(WORKSPACE_READ, auth.role_name || null);
  }

  // Admin (workspace.admin) can do anything
  if (auth.permissions.includes('workspace.admin')) return;

  if (!auth.permissions.includes(required)) {
    throw new PermissionDeniedError(required, auth.role_name || null);
  }
}

/**
 * requireRestPermission — same as above but for REST route patterns.
 */
export function requireRestPermission(
  method: string,
  path: string,
  auth: AuthContext,
  args?: Record<string, unknown>,
): void {
  if (config.auth.mode === 'open') return;

  for (const route of REST_ROUTE_PERMISSIONS) {
    if (route.method !== method) continue;

    const matches = route.pattern instanceof RegExp
      ? route.pattern.test(path)
      : path === route.pattern;

    if (!matches) continue;

    if (route.public) return;

    const required = resolvePermission(OPERATION_PERMISSIONS[route.operation], args);

    if (required === WORKSPACE_READ) {
      if (auth.is_workspace_member) return;
      throw new PermissionDeniedError(WORKSPACE_READ, auth.role_name || null);
    }

    // Admin can perform any mapped workspace operation, but public and
    // implicit-read decisions above remain explicit and auditable.
    if (auth.permissions.includes('workspace.admin')) return;

    if (auth.permissions.includes(required)) return;

    throw new PermissionDeniedError(required, auth.role_name || null);
  }

  // Every method, including GET, is default-denied when no explicit mapping
  // exists. This makes a newly added data endpoint fail closed.
  throw new PermissionDeniedError('(unknown — unmapped route)', auth.role_name || null);
}

// ============================================================
// MCP handler wrapper — wraps a tool handler with permission check
// ============================================================

/**
 * A principal can never grant a permission it does not itself hold — the
 * same "can't exceed yourself" rule the agent/operator intersection
 * enforces (design doc §4), applied to role editing and role assignment.
 * Open mode has no meaningful permission set to check against, so it is
 * exempt like every other enforcement path.
 */
export function assertPermissionsGrantable(auth: AuthContext, permissions: string[]): void {
  if (config.auth.mode === 'open') return;
  if (auth.permissions.includes('workspace.admin')) return;
  const held = new Set(auth.permissions);
  const ungranted = permissions.filter(p => !held.has(p));
  if (ungranted.length > 0) {
    throw new PermissionDeniedError(ungranted.join(', '), auth.role_name || null);
  }
}

export function withPermission<A extends Record<string, unknown>>(
  toolName: string,
  auth: AuthContext,
  handler: (args: A) => Promise<any>,
): (args: A) => Promise<any> {
  return async (args: A) => {
    requirePermission(toolName, auth, args);
    return handler(args);
  };
}
