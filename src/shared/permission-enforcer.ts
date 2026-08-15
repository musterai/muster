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
export type PermissionSpec = Permission | ((args: Record<string, unknown>) => Permission);

export const TOOL_PERMISSIONS: Record<string, PermissionSpec> = {
  // ── Project Tools ──
  list_projects: 'project.create', // reading project list requires workspace membership
  create_project: 'project.create',
  get_project_summary: 'project.create',
  update_project: 'project.update',
  delete_project: 'project.delete',

  // ── Board & Column Tools ──
  list_boards: 'project.create', // reading board list requires workspace membership
  get_board: 'project.create',   // reading a board requires workspace membership
  create_board: 'board.manage',
  update_board: 'board.manage',
  delete_board: 'board.manage',
  create_column: 'board.manage',
  update_column: 'board.manage',
  move_column: 'board.manage',
  delete_column: 'board.manage',

  // ── Card Tools ──
  list_cards: 'project.create', // reading card list requires workspace membership
  search_cards: 'project.create', // searching cards requires workspace membership
  get_card: 'project.create',   // reading card details requires workspace membership
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
  list_work_links: 'project.create',
  link_document_to_card: 'card.update',
  unlink_document_from_card: 'card.update',

  // ── Label Tools ──
  create_label: 'label.manage',
  list_labels: 'project.create',

  // ── Comment Tools ──
  add_comment: 'comment.create',
  update_comment: 'comment.update',
  delete_comment: 'comment.delete',

  // ── Document Tools ──
  list_documents: 'project.create',
  create_document: 'doc.create',
  get_document: 'project.create',
  update_document: 'doc.update',
  delete_document: 'doc.delete',
  set_document_status: (args) => {
    return args.status === 'approved' ? 'doc.approve' : 'doc.submit_review';
  },
  get_document_history: 'project.create',

  // ── Agent Management Tools ──
  register_agent: 'agent.register',
  update_agent: 'agent.register',
  unregister_agent: 'agent.manage_others',
  heartbeat: 'project.create',
  list_agents: 'project.create',

  // ── KB Tools ──
  list_knowledge_bases: 'kb.read',
  create_knowledge_base: 'kb.write',
  link_knowledge_base: 'kb.write',
  search_knowledge: 'kb.read',
  get_entity_knowledge: 'kb.read',
  add_gained_knowledge: 'kb.write',
  upsert_kb_entity: 'kb.write',
  update_gained_knowledge: 'kb.write',
  update_kb_entity: 'kb.write',
  add_kb_relation: 'kb.write',

  // ── Role Management Tools ──
  list_roles: 'role.manage',
  get_role: 'role.manage',
  create_role: 'role.manage',
  update_role: 'role.manage',
  delete_role: 'role.manage',
  clone_role: 'role.manage',

  // ── Event Tools ──
  get_activity: 'project.create',

  };

// ============================================================
// REST ROUTE PERMISSIONS — map HTTP method + path pattern to permission
// ============================================================

export interface RoutePattern {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pattern: RegExp | string;
  permission: PermissionSpec;
  /** When true, the method+path pattern check is skipped (allow read-always) */
  readOnly?: boolean;
}

/**
 * Route permission map for REST endpoints.
 * Patterns are checked in order; first match wins.
 * Read operations (GET with no side effects on the main entity) use the
 * workspace-read permission rather than a full write verb.
 */
export const REST_ROUTE_PERMISSIONS: RoutePattern[] = [
  // ── Health (always public) ──
  { method: 'GET', pattern: /^\/api\/v1\/health/, permission: 'project.create', readOnly: true },

  // ── Projects ──
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/summary/, permission: 'project.create', readOnly: true },
  { method: 'GET', pattern: /^\/api\/v1\/projects(?:\/[^/]+)?$/, permission: 'project.create', readOnly: true },
  { method: 'POST', pattern: /^\/api\/v1\/projects$/, permission: 'project.create' },
  { method: 'PUT', pattern: /^\/api\/v1\/projects\/[^/]+$/, permission: 'project.update' },
  { method: 'DELETE', pattern: /^\/api\/v1\/projects\/[^/]+$/, permission: 'project.delete' },

  // ── Boards ──
  { method: 'GET', pattern: /^\/api\/v1\/projects\/[^/]+\/boards/, permission: 'project.create', readOnly: true },
  { method: 'GET', pattern: /^\/api\/v1\/boards\/[^/]+$/, permission: 'project.create', readOnly: true },
  { method: 'POST', pattern: /^\/api\/v1\/projects\/[^/]+\/boards$/, permission: 'board.manage' },
  { method: 'PUT', pattern: /^\/api\/v1\/boards\/[^/]+$/, permission: 'board.manage' },
  { method: 'DELETE', pattern: /^\/api\/v1\/boards\/[^/]+$/, permission: 'board.manage' },

  // ── Columns ──
  { method: 'POST', pattern: /^\/api\/v1\/boards\/[^/]+\/columns$/, permission: 'board.manage' },
  { method: 'PUT', pattern: /^\/api\/v1\/columns\/[^/]+$/, permission: 'board.manage' },
  { method: 'DELETE', pattern: /^\/api\/v1\/columns\/[^/]+$/, permission: 'board.manage' },

  // ── Cards ──
  { method: 'GET', pattern: /\/cards\/search/, permission: 'project.create', readOnly: true },
  { method: 'GET', pattern: /\/cards(?:\/[^/]+)?(?:\/work-links)?$/, permission: 'project.create', readOnly: true },
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
  { method: 'GET', pattern: /\/documents\/[^/]+\/versions$/, permission: 'project.create', readOnly: true },
  { method: 'GET', pattern: /\/documents\/[^/]+$/, permission: 'project.create', readOnly: true },
  { method: 'GET', pattern: /\/projects\/[^/]+\/documents/, permission: 'project.create', readOnly: true },
  { method: 'POST', pattern: /\/projects\/[^/]+\/documents$/, permission: 'doc.create' },
  { method: 'PUT', pattern: /\/documents\/[^/]+$/, permission: 'doc.update' },
  { method: 'DELETE', pattern: /\/documents\/[^/]+$/, permission: 'doc.delete' },
  { method: 'PATCH', pattern: /\/documents\/[^/]+\/status$/, permission: 'doc.submit_review' },

  // ── Agents ──
  { method: 'GET', pattern: /^\/api\/v1\/agents$/, permission: 'project.create', readOnly: true },

  // ── Users (MUS-32) — read-only workspace member list ──
  { method: 'GET', pattern: /^\/api\/v1\/users$/, permission: 'project.create', readOnly: true },

  // ── Members (MUS-26) — role change and removal ──
  { method: 'PUT', pattern: /\/workspaces\/[^/]+\/members\/[^/]+$/, permission: 'member.manage' },
  { method: 'DELETE', pattern: /\/workspaces\/[^/]+\/members\/[^/]+$/, permission: 'member.manage' },
  { method: 'POST', pattern: /^\/api\/v1\/agents$/, permission: 'agent.register' },
  { method: 'POST', pattern: /\/agents\/[^/]+\/heartbeat$/, permission: 'project.create' },
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
  { method: 'GET', pattern: /\/kbs(?:\/\d+)?(?:\/entities|\/facts|\/graph|\/search|\/entity-knowledge)?$/, permission: 'kb.read', readOnly: true },
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
  { method: 'GET', pattern: /\/events/, permission: 'project.create', readOnly: true },

  // ── Tokens (MUS-24) ──
  { method: 'GET', pattern: /\/tokens$/, permission: 'project.create', readOnly: true },
  { method: 'POST', pattern: /\/tokens$/, permission: 'project.create' },
  { method: 'DELETE', pattern: /\/tokens\/[^/]+$/, permission: 'project.create' },

  // ── Device Authorization Grant (MUS-28) — device/code and token are exempted in permissionGuard; these three run as the signed-in approver ──
  { method: 'GET', pattern: /^\/api\/v1\/oauth\/device\/lookup$/, permission: 'project.create', readOnly: true },
  { method: 'POST', pattern: /^\/api\/v1\/oauth\/device\/approve$/, permission: 'project.create' },
  { method: 'POST', pattern: /^\/api\/v1\/oauth\/device\/deny$/, permission: 'project.create' },

  // ── MCP-native OAuth (MUS-29) — register/authorize are exempted in permissionGuard; these two run as the signed-in approver ──
  { method: 'GET', pattern: /^\/api\/v1\/oauth\/authorize\/details$/, permission: 'project.create', readOnly: true },
  { method: 'POST', pattern: /^\/api\/v1\/oauth\/authorize\/consent$/, permission: 'project.create' },

  // ── Audit log (MUS-30) — admin-only; a security record, not a collaboration feed ──
  { method: 'GET', pattern: /^\/api\/v1\/workspaces\/[^/]+\/audit-log$/, permission: 'workspace.admin', readOnly: false },

  // ── Invitations (MUS-25) — auth/login/callback/logout/me are exempted in permissionGuard ──
  { method: 'GET', pattern: /\/workspaces\/[^/]+\/invitations$/, permission: 'member.invite', readOnly: true },
  { method: 'POST', pattern: /\/workspaces\/[^/]+\/invitations$/, permission: 'member.invite' },
  { method: 'DELETE', pattern: /\/invitations\/[^/]+$/, permission: 'member.invite' },
];

// ============================================================
// resolvePermission — resolve a PermissionSpec against args
// ============================================================

export function resolvePermission(spec: PermissionSpec, args?: Record<string, unknown>): Permission {
  if (typeof spec === 'function') {
    return spec(args || {}) as Permission;
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
): void {
  if (config.auth.mode === 'open') return;

  // Admin can do anything
  if (auth.permissions.includes('workspace.admin')) return;

  for (const route of REST_ROUTE_PERMISSIONS) {
    if (route.method !== method) continue;

    const matches = route.pattern instanceof RegExp
      ? route.pattern.test(path)
      : path === route.pattern;

    if (!matches) continue;

    // Read-only routes always pass on GET
    if (route.readOnly && method === 'GET') return;

    const required = resolvePermission(route.permission);

    if (auth.permissions.includes(required)) return;

    throw new PermissionDeniedError(required, auth.role_name || null);
  }

  // No match found — default-deny for mutation operations
  if (method !== 'GET') {
    throw new PermissionDeniedError('(unknown — unmapped route)', auth.role_name || null);
  }
  // Unmapped GET is allowed (read access)
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
