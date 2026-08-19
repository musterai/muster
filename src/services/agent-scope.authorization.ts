import type { DatabaseAdapter } from '../db/adapter.js';
import type { AuthContext } from '../shared/auth-context.js';
import { config } from '../config/index.js';
import { PermissionDeniedError, WORKSPACE_READ } from '../shared/permission-enforcer.js';

/** Revalidate admission at the mutation boundary; never trust a stale context alone. */
export async function assertActiveWorkspacePrincipal(
  adapter: DatabaseAdapter,
  auth: AuthContext | undefined,
): Promise<AuthContext & { principal: NonNullable<AuthContext['principal']>; workspace_id: string }> {
  if (config.auth.mode === 'open' && auth?.principal && auth.workspace_id) {
    return auth as AuthContext & { principal: NonNullable<AuthContext['principal']>; workspace_id: string };
  }
  if (!auth?.principal || !auth.workspace_id || !auth.is_workspace_member) {
    throw new PermissionDeniedError(WORKSPACE_READ, auth?.role_name || null);
  }
  const active = auth.principal.kind === 'user'
    ? await adapter.query<{ id: string }>(
        'SELECT user_id AS id FROM workspace_member WHERE workspace_id = ? AND user_id = ?',
        [auth.workspace_id, auth.principal.id],
      )
    : await adapter.query<{ id: string }>(
        `SELECT a.id
         FROM agent a
         JOIN workspace_member wm
           ON wm.user_id = a.operator_user_id AND wm.workspace_id = a.workspace_id
         WHERE a.id = ? AND a.workspace_id = ? AND a.operator_user_id IS NOT NULL`,
        [auth.principal.id, auth.workspace_id],
      );
  if (active.length === 0) {
    throw new PermissionDeniedError(WORKSPACE_READ, auth.role_name);
  }
  return auth as AuthContext & { principal: NonNullable<AuthContext['principal']>; workspace_id: string };
}

/**
 * Transport-neutral authorization for any caller-supplied agent selector.
 * The selector never establishes identity: authority comes exclusively from
 * AuthContext, which is derived from the request credential.
 */
export async function assertAgentSelectorScope(
  adapter: DatabaseAdapter,
  agentId: string,
  auth: AuthContext | undefined,
  bypassPermission = 'agent.manage_others',
): Promise<void> {
  if (config.auth.mode === 'open') return;
  const activeAuth = await assertActiveWorkspacePrincipal(adapter, auth);

  const targets = await adapter.query<{
    id: string;
    operator_user_id: string | null;
    workspace_id: string | null;
  }>(
    'SELECT id, operator_user_id, workspace_id FROM agent WHERE id = ?',
    [agentId],
  );
  const target = targets[0];
  if (!target || target.workspace_id !== activeAuth.workspace_id) {
    throw new PermissionDeniedError(bypassPermission, activeAuth.role_name);
  }
  if (activeAuth.permissions.includes(bypassPermission)) return;

  if (activeAuth.principal.kind === 'agent') {
    if (target.id === activeAuth.principal.id && target.operator_user_id) return;
  } else if (target.operator_user_id === activeAuth.principal.id) {
    return;
  }

  throw new PermissionDeniedError(bypassPermission, activeAuth.role_name);
}
