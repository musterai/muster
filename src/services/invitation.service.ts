// File: src/services/invitation.service.ts
//
// Workspace invitations for MUS-25. An invitation admits a specific email
// address into a workspace with a specific role. It is single-use — accepting
// stamps accepted_at and a second accept attempt is refused — and expires.
//
// The invite-management UI (list/revoke) is MUS-26's scope; this service
// provides the primitives that both MUS-25's OIDC admission gate and MUS-26's
// UI consume.

import crypto from 'node:crypto';
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';

const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashInvitationToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex');
}

export interface Invitation {
  id: string;
  workspace_id: string;
  email: string;
  role_id: string;
  expires_at: string;
  accepted_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface CreatedInvitation extends Invitation {
  /** Plaintext invite token — shown once, at creation. */
  token: string;
}

export class InvitationService {
  constructor(private db: DatabaseAdapter) {}

  async create(data: {
    workspace_id: string;
    email: string;
    role_id: string;
    created_by?: string | null;
    ttlMs?: number;
  }, adapter?: DatabaseAdapter): Promise<CreatedInvitation> {
    if (!adapter) return this.db.transaction(tx => this.create(data, tx));
    const id = ulid();
    const token = crypto.randomBytes(24).toString('hex');
    const tokenHash = hashInvitationToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (data.ttlMs ?? DEFAULT_INVITATION_TTL_MS));

    await adapter.execute(
      `INSERT INTO invitation (id, workspace_id, email, role_id, token_hash, expires_at, accepted_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [id, data.workspace_id, data.email.toLowerCase(), data.role_id, tokenHash, expiresAt.toISOString(), data.created_by || null, now.toISOString()],
    );

    return {
      id,
      workspace_id: data.workspace_id,
      email: data.email.toLowerCase(),
      role_id: data.role_id,
      expires_at: expiresAt.toISOString(),
      accepted_at: null,
      created_by: data.created_by || null,
      created_at: now.toISOString(),
      token,
    };
  }

  async list(workspaceId: string): Promise<Invitation[]> {
    const rows = await this.db.query<any>(
      `SELECT id, workspace_id, email, role_id, expires_at, accepted_at, created_by, created_at
       FROM invitation WHERE workspace_id = ? ORDER BY created_at DESC`,
      [workspaceId],
    );
    return rows;
  }

  async getById(id: string): Promise<Invitation | null> {
    const rows = await this.db.query<any>(
      `SELECT id, workspace_id, email, role_id, expires_at, accepted_at, created_by, created_at
       FROM invitation WHERE id = ?`,
      [id],
    );
    return rows[0] || null;
  }

  /** Revoking deletes the row outright — a revoked invitation can never be replayed or accepted. */
  async revoke(id: string, adapter?: DatabaseAdapter): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.revoke(id, tx));
    await adapter.execute('DELETE FROM invitation WHERE id = ?', [id]);
  }

  /** The most recent pending (unaccepted, unexpired) invitation for this email in this workspace, if any. */
  async findPendingByEmail(workspaceId: string, email: string): Promise<Invitation | null> {
    const rows = await this.db.query<any>(
      `SELECT id, workspace_id, email, role_id, expires_at, accepted_at, created_by, created_at
       FROM invitation
       WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL
       ORDER BY created_at DESC`,
      [workspaceId, email.toLowerCase()],
    );
    const now = Date.now();
    return rows.find((r: Invitation) => new Date(r.expires_at).getTime() > now) || null;
  }

  /**
   * Accept an invitation and create the workspace_member row.
   * Refuses if already accepted or expired — an invitation is single-use.
   */
  async accept(invitationId: string, userId: string, adapter?: DatabaseAdapter): Promise<Invitation> {
    if (!adapter) return this.db.transaction(tx => this.accept(invitationId, userId, tx));
    const lockClause = adapter.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const invitationRows = await adapter.query<any>(
      `SELECT id, workspace_id, email, role_id, expires_at, accepted_at, created_by, created_at
       FROM invitation WHERE id = ?${lockClause}`,
      [invitationId],
    );
    const invitation = invitationRows[0] as Invitation | undefined;
    if (!invitation) throw new Error('Invitation not found');
    if (invitation.accepted_at) throw new Error('Invitation has already been accepted');
    if (new Date(invitation.expires_at).getTime() <= Date.now()) throw new Error('Invitation has expired');

    const now = new Date().toISOString();

    await adapter.execute('UPDATE invitation SET accepted_at = ? WHERE id = ?', [now, invitationId]);
    await adapter.execute(
      `INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at, invited_by)
       VALUES (?, ?, ?, ?, ?)`,
      [invitation.workspace_id, userId, invitation.role_id, now, invitation.created_by],
    );

    return { ...invitation, accepted_at: now };
  }
}
