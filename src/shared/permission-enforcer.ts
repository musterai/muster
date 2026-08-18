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

export const TOOL_PERMISSIONS: Record<string, PermissionSpec> = {
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

  };

// ============================================================
// REST ROUTE PERMISSIONS — map HTTP method + path pattern to permission
// ============================================================

export interface RoutePattern {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pattern: RegExp | string;
  permission: PermissionSpec;
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
  { method: 'GET', pattern: /^\/api\/v1\/health$/, permission: WORKSPACE_READ, public: true },

  // ── Projects ──
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/summary$/, permission: WORKSPACE_READ },
  { method: 'GET', pattern: /^\/api\/v1\/projects(?:\/[^/]+)?$/, permission: WORKSPACE_READ },
  { method: 'POST', pattern: /^\/api\/v1\/projects$/, permission: 'project.create' },
  { method: 'PUT', pattern: /^\/api\/v1\/projects\/[^/]+$/, permission: 'project.update' },
  { method: 'DELETE', pattern: /^\/api\/v1\/projects\/[^/]+$/, permission: 'project.delete' },

  // ── Boards ──
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/(?:boards|all-boards)$/, permission: WORKSPACE_READ },
  { method: 'GET', pattern: /^\/api\/v1\/boards\/[^/]+$/, permission: WORKSPACE_READ },
  { method: 'POST', pattern: /^\/api\/v1\/projects\/[^/]+\/boards$/, permission: 'board.manage' },
  { method: 'PUT', pattern: /^\/api\/v1\/boards\/[^/]+$/, permission: 'board.manage' },
  { method: 'DELETE', pattern: /^\/api\/v1\/boards\/[^/]+$/, permission: 'board.manage' },

  // ── Columns ──
  { method: 'POST', pattern: /^\/api\/v1\/boards\/[^/]+\/columns$/, permission: 'board.manage' },
  { method: 'PUT', pattern: /^\/api\/v1\/columns\/[^/]+$/, permission: 'board.manage' },
  { method: 'DELETE', pattern: /^\/api\/v1\/columns\/[^/]+$/, permission: 'board.manage' },

  // ── Cards ──
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/cards\/search$/, permission: WORKSPACE_READ },
  { method: 'GET', pattern: /^\/api\/v1\/(?:projects\/[^/]+|boards\/[^/]+)\/cards$/, permission: WORKSPACE_READ },
  { method: 'GET', pattern: /^\/api\/v1\/cards\/[^/]+(?:\/work-links)?$/, permission: WORKSPACE_READ },
  { method: 'POST', pattern: /\/columns\/[^/]+\/cards$/, permission: 'card.create' },
  { method: 'PUT', pattern: /\/cards\/[^/]+$/, permission: 'card.update' },
  { method: 'PATCH', pattern: /\/cards\/[^/]+\/move$/, permission: 'card.move' },
  { method: 'DELETE', pattern: /\/cards\/[^/]+$/, permission: 'card.delete' },
  { method: 'POST', pattern: /\/cards\/[^/]+\/claim$/, permission: 'card.claim' },
  { method: 'POST', pattern: /\/cards\/[^/]+\/assignees$/, permission: 'card.assign_others' },
  { method: 'DELETE', pattern: /\/cards\/[^/]+\/assignees\/[^/]+$/, permission: 'card.assign_others' },
  { method: 'POST', pattern: /\/cards\/[^/]+\/labels$/, permission: 'card.update' },
  { method: 'DELETE', pattern: /\/cards\/[^/]+\/labels\/[^/]+$/, permission: 'card.update' },
  { method: 'POST', pattern: /\/cards\/[^/]+\/comments$/, permission: 'comment.create' },
  { method: 'PUT', pattern: /\/cards\/[^/]+\/comments\/[^/]+$/, permission: 'comment.update' },
  { method: 'DELETE', pattern: /\/cards\/[^/]+\/comments\/[^/]+$/, permission: 'comment.delete' },
  { method: 'POST', pattern: /\/cards\/[^/]+\/documents$/, permission: 'card.update' },
  { method: 'DELETE', pattern: /\/cards\/[^/]+\/documents\/[^/]+$/, permission: 'card.update' },
  { method: 'POST', pattern: /\/cards\/[^/]+\/links$/, permission: 'card.update' },
  { method: 'DELETE', pattern: /\/cards\/[^/]+\/links\/[^/]+$/, permission: 'card.update' },
  { method: 'POST', pattern: /\/cards\/[^/]+\/work-links$/, permission: 'card.update' },
  { method: 'DELETE', pattern: /\/cards\/[^/]+\/work-links\/[^/]+$/, permission: 'card.update' },

  // ── Documents ──
  { method: 'GET', pattern: /^\/api\/v1\/documents\/[^/]+\/versions$/, permission: WORKSPACE_READ },
  { method: 'GET', pattern: /^\/api\/v1\/documents\/[^/]+$/, permission: WORKSPACE_READ },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/documents$/, permission: WORKSPACE_READ },
  { method: 'POST', pattern: /\/projects\/[^/]+\/documents$/, permission: 'doc.create' },
  { method: 'PUT', pattern: /\/documents\/[^/]+$/, permission: 'doc.update' },
  { method: 'DELETE', pattern: /\/documents\/[^/]+$/, permission: 'doc.delete' },
  {
    method: 'PATCH',
    pattern: /^\/api\/v1\/documents\/[^/]+\/status$/,
    permission: args => args.status === 'approved' ? 'doc.approve' : 'doc.submit_review',
  },

  // ── Agents ──
  { method: 'GET', pattern: /^\/api\/v1\/agents$/, permission: WORKSPACE_READ },

  // ── Users (MUS-32) — read-only workspace member list ──
  { method: 'GET', pattern: /^\/api\/v1\/users$/, permission: WORKSPACE_READ },

  // ── Members (MUS-26) — role change and removal ──
  { method: 'PUT', pattern: /\/workspaces\/[^/]+\/members\/[^/]+$/, permission: 'member.manage' },
  { method: 'DELETE', pattern: /\/workspaces\/[^/]+\/members\/[^/]+$/, permission: 'member.manage' },
  { method: 'POST', pattern: /^\/api\/v1\/agents$/, permission: 'agent.register' },
  { method: 'POST', pattern: /\/agents\/[^/]+\/heartbeat$/, permission: WORKSPACE_READ },
  { method: 'PUT', pattern: /\/agents\/[^/]+$/, permission: 'agent.register' },
  { method: 'DELETE', pattern: /\/agents\/[^/]+$/, permission: 'agent.manage_others' },

  // ── Roles ──
  { method: 'GET', pattern: /\/workspaces\/[^/]+\/roles/, permission: 'role.manage' },
  { method: 'GET', pattern: /\/roles\/[^/]+$/, permission: 'role.manage' },
  { method: 'POST', pattern: /\/workspaces\/[^/]+\/roles$/, permission: 'role.manage' },
  { method: 'POST', pattern: /\/roles\/[^/]+\/clone$/, permission: 'role.manage' },
  { method: 'PUT', pattern: /\/roles\/[^/]+$/, permission: 'role.manage' },
  { method: 'DELETE', pattern: /\/roles\/[^/]+$/, permission: 'role.manage' },

  // ── KB ──
  { method: 'GET', pattern: /^\/api\/v1\/kbs(?:\/[^/]+(?:\/(?:entities|facts))?|\/(?:graph|search|entity-knowledge))?$/, permission: WORKSPACE_READ },
  { method: 'POST', pattern: /\/kbs$/, permission: 'kb.write' },
  { method: 'POST', pattern: /\/kbs\/[^/]+\/link$/, permission: 'kb.write' },
  { method: 'POST', pattern: /\/kbs\/[^/]+\/unlink$/, permission: 'kb.write' },
  { method: 'POST', pattern: /\/kbs\/entities$/, permission: 'kb.write' },
  { method: 'PUT', pattern: /\/kbs\/entities\/[^/]+$/, permission: 'kb.write' },
  { method: 'DELETE', pattern: /\/kbs\/entities\/[^/]+$/, permission: 'kb.write' },
  { method: 'POST', pattern: /\/kbs\/facts$/, permission: 'kb.write' },
  { method: 'PUT', pattern: /\/kbs\/facts\/[^/]+$/, permission: 'kb.write' },
  { method: 'DELETE', pattern: /\/kbs\/facts\/[^/]+$/, permission: 'kb.write' },
  { method: 'POST', pattern: /\/kbs\/relations$/, permission: 'kb.write' },
  { method: 'DELETE', pattern: /\/kbs\/relations\/[^/]+$/, permission: 'kb.write' },
  { method: 'DELETE', pattern: /\/kbs\/[^/]+$/, permission: 'kb.write' },

  // ── Events ──
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/events(?:\/stream)?$/, permission: WORKSPACE_READ },

  // ── Tokens (MUS-24) ──
  { method: 'GET', pattern: /^\/api\/v1\/tokens$/, permission: WORKSPACE_READ },
  { method: 'POST', pattern: /^\/api\/v1\/tokens$/, permission: WORKSPACE_READ },
  { method: 'DELETE', pattern: /^\/api\/v1\/tokens\/[^/]+$/, permission: WORKSPACE_READ },

  // ── Device Authorization Grant (MUS-28) — device/code and token are exempted in permissionGuard; these three run as the signed-in approver ──
  { method: 'GET', pattern: /^\/api\/v1\/oauth\/device\/lookup$/, permission: WORKSPACE_READ },
  { method: 'POST', pattern: /^\/api\/v1\/oauth\/device\/approve$/, permission: 'project.create' },
  { method: 'POST', pattern: /^\/api\/v1\/oauth\/device\/deny$/, permission: 'project.create' },

  // ── MCP-native OAuth (MUS-29) — register/authorize are exempted in permissionGuard; these two run as the signed-in approver ──
  { method: 'GET', pattern: /^\/api\/v1\/oauth\/authorize\/details$/, permission: WORKSPACE_READ },
  { method: 'POST', pattern: /^\/api\/v1\/oauth\/authorize\/consent$/, permission: 'project.create' },

  // ── Audit log (MUS-30) — admin-only; a security record, not a collaboration feed ──
  { method: 'GET', pattern: /^\/api\/v1\/workspaces\/[^/]+\/audit-log$/, permission: 'workspace.admin' },

  // ── Invitations (MUS-25) — auth/login/callback/logout/me are exempted in permissionGuard ──
  { method: 'GET', pattern: /\/workspaces\/[^/]+\/invitations$/, permission: 'member.invite' },
  { method: 'POST', pattern: /\/workspaces\/[^/]+\/invitations$/, permission: 'member.invite' },
  { method: 'DELETE', pattern: /\/invitations\/[^/]+$/, permission: 'member.invite' },
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

    const required = resolvePermission(route.permission, args);

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
