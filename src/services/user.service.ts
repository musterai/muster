// File: src/services/user.service.ts
//
// Human user accounts and OIDC identity binding for MUS-25.
// A user is matched on (provider, sub) — never on email, which is mutable
// and can be reassigned by the identity provider. See design doc §7.1.

import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { ValidationError } from '../shared/errors.js';
import type { AuthContext } from '../shared/auth-context.js';
import { assertResourceWorkspace, assertWorkspace } from './helpers/workspace-scope.helper.js';

export interface AppUser {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  status: 'active' | 'idle' | 'offline';
  created_at: string;
}

export interface WorkspaceMember {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  role_id: string;
  role_name: string;
  joined_at: string;
}

export class UserService {
  constructor(private db: DatabaseAdapter) {}

  /**
   * Resolve a user from an OIDC (provider, sub) pair, creating both the
   * identity link and the app_user on first sign-in. The identity's stored
   * email is refreshed on every login so a provider-side email change is
   * reflected, but the match is always on (provider, sub) — never on email.
   */
  async findOrCreateBySubject(
    provider: string,
    subject: string,
    email: string | null,
    displayName?: string | null,
    adapter?: DatabaseAdapter,
  ): Promise<{ user: AppUser; isNewUser: boolean }> {
    if (!adapter) return this.db.transaction(tx => this.findOrCreateBySubject(provider, subject, email, displayName, tx));
    const existing = await adapter.query<any>(
      `SELECT u.id, u.email, u.display_name, u.avatar_url, u.status, u.created_at
       FROM identity i JOIN app_user u ON u.id = i.user_id
       WHERE i.provider = ? AND i.subject = ?`,
      [provider, subject],
    );

    if (existing.length > 0) {
      if (email) {
        await adapter.execute('UPDATE identity SET email = ? WHERE provider = ? AND subject = ?', [email, provider, subject]);
        await adapter.execute('UPDATE app_user SET email = ? WHERE id = ?', [email, existing[0].id]);
      }
      return { user: { ...existing[0], email: email || existing[0].email }, isNewUser: false };
    }

    const now = new Date().toISOString();
    const userId = ulid();
    const identityId = ulid();

    await adapter.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [userId, 'user', now]);
    await adapter.execute(
      'INSERT INTO app_user (id, email, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, email, displayName || email || 'New User', 'active', now],
    );
    await adapter.execute(
      'INSERT INTO identity (id, user_id, provider, subject, email) VALUES (?, ?, ?, ?, ?)',
      [identityId, userId, provider, subject, email],
    );

    return {
      user: { id: userId, email, display_name: displayName || email || 'New User', avatar_url: null, status: 'active', created_at: now },
      isNewUser: true,
    };
  }

  async findById(id: string): Promise<AppUser | null> {
    const rows = await this.db.query<AppUser>(
      'SELECT id, email, display_name, avatar_url, status, created_at FROM app_user WHERE id = ?',
      [id],
    );
    return rows[0] || null;
  }

  async findByDisplayName(displayName: string): Promise<AppUser | null> {
    const rows = await this.db.query<AppUser>(
      'SELECT id, email, display_name, avatar_url, status, created_at FROM app_user WHERE LOWER(display_name) = LOWER(?) LIMIT 1',
      [displayName.trim()],
    );
    return rows[0] || null;
  }

  /**
   * Create a human principal directly, with no OIDC identity behind it —
   * the open-mode "who are you" self-service flow. Only ever called when
   * config.auth.mode === 'open': every request there already carries full
   * trust, so this just gives that trust a name and a real app_user row
   * (so the person shows up in Members, can be @assigned, etc.) instead of
   * leaving them unable to appear as anyone at all.
   */
  async createLocalUser(displayName: string, adapter?: DatabaseAdapter): Promise<AppUser> {
    if (!adapter) return this.db.transaction(tx => this.createLocalUser(displayName, tx));
    const db = adapter;
    const now = new Date().toISOString();
    const userId = ulid();

    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [userId, 'user', now]);
    await db.execute(
      'INSERT INTO app_user (id, email, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, null, displayName, 'active', now],
    );

    return { id: userId, email: null, display_name: displayName, avatar_url: null, status: 'active', created_at: now };
  }

  async isWorkspaceEmpty(workspaceId: string): Promise<boolean> {
    const rows = await this.db.query<any>('SELECT 1 FROM workspace_member WHERE workspace_id = ? LIMIT 1', [workspaceId]);
    return rows.length === 0;
  }

  async isWorkspaceMember(workspaceId: string, userId: string, adapter: DatabaseAdapter = this.db): Promise<boolean> {
    const rows = await adapter.query<any>(
      'SELECT 1 FROM workspace_member WHERE workspace_id = ? AND user_id = ? LIMIT 1',
      [workspaceId, userId],
    );
    return rows.length > 0;
  }

  async addWorkspaceMember(workspaceId: string, userId: string, roleId: string, invitedBy?: string | null, adapter: DatabaseAdapter = this.db): Promise<void> {
    const now = new Date().toISOString();
    await adapter.execute(
      'INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at, invited_by) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, userId, roleId, now, invitedBy || null],
    );
  }

  /**
   * List the human members of a workspace — the "Members" surface (MUS-26)
   * and the agent roster's operator lookup (MUS-32) both read this. No
   * liveness/status column: that telemetry is agent-only, see design §4.1.
   */
  async listMembers(workspaceId: string, auth?: AuthContext): Promise<WorkspaceMember[]> {
    if (auth) assertWorkspace(auth, workspaceId);
    return this.db.query<WorkspaceMember>(
      `SELECT u.id, u.email, u.display_name, u.avatar_url, wm.role_id, r.name as role_name, wm.joined_at
       FROM workspace_member wm
       JOIN app_user u ON u.id = wm.user_id
       JOIN role r ON r.id = wm.role_id
       WHERE wm.workspace_id = ?
       ORDER BY u.display_name ASC`,
      [workspaceId],
    );
  }

  /**
   * Number of members currently holding a role that grants workspace.admin —
   * the "owner" rank, regardless of whether that role is still named/keyed
   * "owner" after editing. Used to refuse leaving a workspace ownerless.
   */
  async countAdmins(workspaceId: string, adapter: DatabaseAdapter = this.db): Promise<number> {
    const rows = await adapter.query<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM workspace_member wm
       JOIN role r ON r.id = wm.role_id
       WHERE wm.workspace_id = ? AND r.permissions_json LIKE '%"workspace.admin"%'`,
      [workspaceId],
    );
    return rows[0]?.count ?? 0;
  }

  private async isSoleAdmin(
    workspaceId: string,
    userId: string,
    roleId: string,
    adapter: DatabaseAdapter = this.db,
  ): Promise<boolean> {
    const roleRows = await adapter.query<{ permissions_json: string }>('SELECT permissions_json FROM role WHERE id = ?', [roleId]);
    const permissions: string[] = roleRows[0] ? JSON.parse(roleRows[0].permissions_json) : [];
    if (!permissions.includes('workspace.admin')) return false;
    return (await this.countAdmins(workspaceId, adapter)) <= 1;
  }

  /** Serialize membership/admin decisions on PostgreSQL before counting. */
  private async lockWorkspaceMembers(workspaceId: string, adapter: DatabaseAdapter): Promise<void> {
    if (adapter.dialect !== 'postgres') return;
    await adapter.query(
      'SELECT user_id FROM workspace_member WHERE workspace_id = ? FOR UPDATE',
      [workspaceId],
    );
  }

  private async operatedAgentIds(
    adapter: DatabaseAdapter,
    workspaceId: string,
    userId: string,
  ): Promise<string[]> {
    const rows = await adapter.query<{ id: string }>(
      'SELECT id FROM agent WHERE workspace_id = ? AND operator_user_id = ?',
      [workspaceId, userId],
    );
    return rows.map(row => row.id);
  }

  private async revokeWorkspaceCredentials(
    adapter: DatabaseAdapter,
    workspaceId: string,
    userId: string,
    agentIds: string[],
  ): Promise<void> {
    const principalIds = [userId, ...agentIds];
    const placeholders = principalIds.map(() => '?').join(', ');
    const now = new Date().toISOString();

    await adapter.execute(
      `UPDATE api_token SET revoked_at = ?
       WHERE workspace_id = ? AND principal_id IN (${placeholders}) AND revoked_at IS NULL`,
      [now, workspaceId, ...principalIds],
    );
    // Browser sessions are not workspace-bound. Force a fresh admission and
    // role lookup on the next sign-in instead of retaining a stale session.
    await adapter.execute('DELETE FROM session WHERE user_id = ?', [userId]);
    await adapter.execute(
      `DELETE FROM device_grant
       WHERE workspace_id = ? AND principal_id IN (${placeholders})`,
      [workspaceId, ...principalIds],
    );

    if (agentIds.length === 0) return;
    const agentPlaceholders = agentIds.map(() => '?').join(', ');
    await adapter.execute(
      `DELETE FROM oauth_authorization_code
       WHERE workspace_id = ? AND agent_principal_id IN (${agentPlaceholders})`,
      [workspaceId, ...agentIds],
    );
    await adapter.execute(
      `UPDATE oauth_refresh_token SET revoked = 1
       WHERE workspace_id = ? AND agent_principal_id IN (${agentPlaceholders})`,
      [workspaceId, ...agentIds],
    );
  }

  /** Change a member's role. Refuses to demote the last remaining admin — a workspace must always keep an owner. */
  async changeMemberRole(workspaceId: string, userId: string, newRoleId: string, adapter?: DatabaseAdapter, auth?: AuthContext): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.changeMemberRole(workspaceId, userId, newRoleId, tx, auth));
    if (auth) {
      assertWorkspace(auth, workspaceId);
      await assertResourceWorkspace(adapter, auth, 'role', newRoleId);
    }
    await (async tx => {
      await this.lockWorkspaceMembers(workspaceId, tx);
      const memberRows = await tx.query<{ role_id: string }>(
        'SELECT role_id FROM workspace_member WHERE workspace_id = ? AND user_id = ?',
        [workspaceId, userId],
      );
      if (memberRows.length === 0) throw new ValidationError('User is not a member of this workspace');
      const currentRoleId = memberRows[0].role_id;

      const targetRoles = await tx.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM role WHERE id = ?',
        [newRoleId],
      );
      if (targetRoles.length === 0 || targetRoles[0].workspace_id !== workspaceId) {
        throw new ValidationError('Target role does not belong to this workspace');
      }

      if (currentRoleId !== newRoleId && await this.isSoleAdmin(workspaceId, userId, currentRoleId, tx)) {
        throw new ValidationError('Cannot change the role of the last owner — promote another member first');
      }
      if (currentRoleId === newRoleId) return;

      await tx.execute(
        'UPDATE workspace_member SET role_id = ? WHERE workspace_id = ? AND user_id = ?',
        [newRoleId, workspaceId, userId],
      );
      const agentIds = await this.operatedAgentIds(tx, workspaceId, userId);
      await this.revokeWorkspaceCredentials(tx, workspaceId, userId, agentIds);
    })(adapter);
  }

  /**
   * Remove a member from the workspace. Refuses to remove the last admin.
   * Agents the member operates are never orphaned silently — they are
   * unassigned (operator_user_id = NULL) and surface in the roster's
   * "Unassigned" group rather than being deleted or left pointing at a
   * principal no longer in the workspace.
   */
  async removeMember(workspaceId: string, userId: string, adapter?: DatabaseAdapter, auth?: AuthContext): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.removeMember(workspaceId, userId, tx, auth));
    if (auth) assertWorkspace(auth, workspaceId);
    await (async tx => {
      await this.lockWorkspaceMembers(workspaceId, tx);
      const memberRows = await tx.query<{ role_id: string }>(
        'SELECT role_id FROM workspace_member WHERE workspace_id = ? AND user_id = ?',
        [workspaceId, userId],
      );
      if (memberRows.length === 0) {
        throw new ValidationError('User is not a member of this workspace');
      }
      if (await this.isSoleAdmin(workspaceId, userId, memberRows[0].role_id, tx)) {
        throw new ValidationError('Cannot remove the last owner — promote another member first');
      }

      const agentIds = await this.operatedAgentIds(tx, workspaceId, userId);
      await this.revokeWorkspaceCredentials(tx, workspaceId, userId, agentIds);

      if (agentIds.length > 0) {
        const placeholders = agentIds.map(() => '?').join(', ');
        await tx.execute(
          `UPDATE card SET claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL
           WHERE claimed_by IN (${placeholders})
             AND column_id IN (
               SELECT c.id FROM "column" c
               JOIN board b ON b.id = c.board_id
               JOIN project p ON p.id = b.project_id
               WHERE p.workspace_id = ?
             )`,
          [...agentIds, workspaceId],
        );
        await tx.execute(
          `UPDATE agent
           SET status = 'offline', operator_user_id = NULL, role_id = NULL
           WHERE id IN (${placeholders})`,
          agentIds,
        );
      }

      await tx.execute(
        'DELETE FROM workspace_member WHERE workspace_id = ? AND user_id = ?',
        [workspaceId, userId],
      );
      // Keep the global principal, app_user and identity rows. They may belong
      // to other workspaces, and historical comments require the principal FK
      // to remain intact. With no membership or live credentials, this
      // workspace becomes inaccessible immediately.
    })(adapter);
  }
}
