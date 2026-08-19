import type { DatabaseAdapter } from '../db/adapter.js';
import type { AuthContext } from '../shared/auth-context.js';
import { config } from '../config/index.js';
import { PermissionDeniedError, WORKSPACE_READ } from '../shared/permission-enforcer.js';
import { resolveCardId } from './helpers/card-id.helper.js';
import { assertActiveWorkspacePrincipal } from './agent-scope.authorization.js';

/**
 * Card row/workspace authorization shared by every mutation entry point.
 * Transport handlers inject AuthContext; this policy owns the non-enumerating
 * lookup and assignment rules so REST and MCP cannot drift.
 */
export class CardAccessPolicy {
  constructor(private readonly db: DatabaseAdapter) {}

  private deny(auth: AuthContext): never {
    throw new PermissionDeniedError('card.assign_others', auth.role_name);
  }

  async assertCardWorkspaceScope(
    cardIdOrKey: string,
    auth: AuthContext | undefined,
    adapter: DatabaseAdapter = this.db,
  ): Promise<string> {
    if (config.auth.mode === 'open') return resolveCardId(adapter, cardIdOrKey);
    auth = await assertActiveWorkspacePrincipal(adapter, auth);

    const rows = await adapter.query<{ id: string; workspace_id: string }>(
      `SELECT c.id, p.workspace_id
       FROM card c
       JOIN "column" col ON col.id = c.column_id
       JOIN board b ON b.id = col.board_id
       JOIN project p ON p.id = b.project_id
       WHERE c.id = ? OR c.key = ?
       LIMIT 1`,
      [cardIdOrKey, cardIdOrKey],
    );
    if (rows.length === 0 || rows[0].workspace_id !== auth.workspace_id) return this.deny(auth);
    return rows[0].id;
  }

  async assertColumnWorkspaceScope(
    columnId: string,
    auth: AuthContext | undefined,
    adapter: DatabaseAdapter = this.db,
  ): Promise<string> {
    if (config.auth.mode === 'open') return columnId;
    auth = await assertActiveWorkspacePrincipal(adapter, auth);

    const rows = await adapter.query<{ id: string; workspace_id: string }>(
      `SELECT col.id, p.workspace_id
       FROM "column" col
       JOIN board b ON b.id = col.board_id
       JOIN project p ON p.id = b.project_id
       WHERE col.id = ?
       LIMIT 1`,
      [columnId],
    );
    if (rows.length === 0 || rows[0].workspace_id !== auth.workspace_id) return this.deny(auth);
    return rows[0].id;
  }

  async assertCardMutationScope(
    cardIdOrKey: string,
    auth: AuthContext | undefined,
    adapter: DatabaseAdapter = this.db,
  ): Promise<string> {
    const cardId = await this.assertCardWorkspaceScope(cardIdOrKey, auth, adapter);
    if (config.auth.mode === 'open') return cardId;
    if (!auth?.principal) throw new PermissionDeniedError(WORKSPACE_READ, auth?.role_name || null);
    if (auth.permissions.includes('card.assign_others')) return cardId;

    let scopedPrincipalIds: string[];
    if (auth.principal.kind === 'user') {
      const operated = await adapter.query<{ id: string }>(
        `SELECT id FROM agent
         WHERE operator_user_id = ? AND workspace_id = ?`,
        [auth.principal.id, auth.workspace_id],
      );
      scopedPrincipalIds = [auth.principal.id, ...operated.map((row) => row.id)];
    } else {
      scopedPrincipalIds = [auth.principal.id];
    }

    const placeholders = scopedPrincipalIds.map(() => '?').join(',');
    const assignments = await adapter.query<{ card_id: string }>(
      `SELECT card_id FROM card_assignee
       WHERE card_id = ? AND principal_id IN (${placeholders})
       LIMIT 1`,
      [cardId, ...scopedPrincipalIds],
    );
    if (assignments.length === 0) return this.deny(auth);
    return cardId;
  }
}
