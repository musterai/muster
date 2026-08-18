// File: src/services/device-grant.service.ts
//
// OAuth 2.0 Device Authorization Grant (RFC 8628) for `muster login`
// (MUS-28) — purely additive to the PAT path (MUS-24): a successful poll
// mints the exact same kind of api_token row, verified the exact same way.

import crypto from 'node:crypto';
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { TokenService, hashToken } from './token.service.js';
import { AuditService } from './audit.service.js';
import { CreatedApiToken } from '../shared/types.js';
import { AuthContext } from '../shared/auth-context.js';
import { PermissionDeniedError } from '../shared/permission-enforcer.js';
import { ValidationError } from '../shared/errors.js';

const DEVICE_CODE_BYTES = 32;
const EXPIRES_IN_SECONDS = 600; // 10 minutes
const DEFAULT_INTERVAL_SECONDS = 5;
/** Excludes 0/O and 1/I — short enough to read aloud, unambiguous when heard. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface DeviceCodeResult {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval: number;
}

export interface DeviceGrantSummary {
  user_code: string;
  status: 'pending' | 'approved' | 'denied';
  expires_at: string;
}

export type PollResult =
  | { ok: true; token: CreatedApiToken }
  | { ok: false; error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' };

function randomUserCode(): string {
  const pick = (n: number) => Array.from({ length: n }, () => USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)]).join('');
  return `${pick(4)}-${pick(4)}`;
}

export class DeviceGrantService {
  constructor(private db: DatabaseAdapter, private tokenService: TokenService, private auditService?: AuditService) {}

  async createDeviceCode(): Promise<DeviceCodeResult> {
    const deviceCode = crypto.randomBytes(DEVICE_CODE_BYTES).toString('hex');
    const deviceCodeHash = hashToken(deviceCode);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRES_IN_SECONDS * 1000);

    // user_code collisions are astronomically unlikely (33^8 space) but the
    // column is UNIQUE — retry on the rare conflict rather than fail the request.
    let userCode = randomUserCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.db.query<{ id: string }>('SELECT id FROM device_grant WHERE user_code = ?', [userCode]);
      if (existing.length === 0) break;
      userCode = randomUserCode();
    }

    await this.db.execute(
      `INSERT INTO device_grant (id, device_code_hash, user_code, status, interval_seconds, expires_at, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [ulid(), deviceCodeHash, userCode, DEFAULT_INTERVAL_SECONDS, expiresAt.toISOString(), now.toISOString()],
    );

    return { device_code: deviceCode, user_code: userCode, expires_in: EXPIRES_IN_SECONDS, interval: DEFAULT_INTERVAL_SECONDS };
  }

  /** For the verification page — never exposes device_code_hash. */
  async findByUserCode(userCode: string): Promise<DeviceGrantSummary | null> {
    const rows = await this.db.query<any>(
      `SELECT user_code, status, expires_at FROM device_grant WHERE user_code = ?`,
      [userCode.toUpperCase()],
    );
    if (rows.length === 0) return null;
    if (new Date(rows[0].expires_at).getTime() <= Date.now()) {
      await this.db.execute('DELETE FROM device_grant WHERE user_code = ?', [userCode.toUpperCase()]);
      return null;
    }
    return rows[0];
  }

  /**
   * Binds the grant to the approving principal's own identity.  Authorization
   * is checked here and again at poll time so removing membership between the
   * two steps cannot leave a mintable grant behind.
   */
  async approve(userCode: string, principalOrAuth: string | AuthContext, workspaceId?: string): Promise<boolean> {
    const auth: AuthContext = typeof principalOrAuth === 'string'
      ? {
          principal: { kind: 'user', id: principalOrAuth },
          workspace_id: workspaceId || null,
          is_workspace_member: false,
          permissions: [],
          is_operator_override: false,
          role_name: null,
        }
      : principalOrAuth;
    if (!auth.principal || auth.principal.kind !== 'user' || !auth.workspace_id) return false;
    const principalId = auth.principal.id;

    const rows = await this.db.query<{ id: string; status: string; expires_at: string }>(
      'SELECT id, status, expires_at FROM device_grant WHERE user_code = ?',
      [userCode.toUpperCase()],
    );
    const row = rows[0];
    if (!row || row.status !== 'pending' || new Date(row.expires_at).getTime() <= Date.now()) return false;

    try {
      await this.tokenService.authorize(auth, {
        principal_id: principalId,
        workspace_id: auth.workspace_id,
        name: 'muster login (device)',
      });
    } catch (error) {
      await this.auditIssuanceRefusal(auth, error);
      return false;
    }

    await this.db.execute(
      `UPDATE device_grant SET status = 'approved', principal_id = ?, workspace_id = ? WHERE id = ?`,
      [principalId, auth.workspace_id, row.id],
    );
    return true;
  }

  async deny(userCode: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string; status: string }>('SELECT id, status FROM device_grant WHERE user_code = ?', [userCode.toUpperCase()]);
    const row = rows[0];
    if (!row || row.status !== 'pending') return false;
    await this.db.execute(`UPDATE device_grant SET status = 'denied' WHERE id = ?`, [row.id]);
    return true;
  }

  /**
   * The CLI's poll. Every branch that terminates the grant (expired, denied,
   * successfully claimed) deletes the row — RFC 8628 requires a consumed or
   * lapsed device_code to never be revivable by polling again.
   */
  async poll(deviceCode: string): Promise<PollResult> {
    const hash = hashToken(deviceCode);
    const rows = await this.db.query<any>('SELECT * FROM device_grant WHERE device_code_hash = ?', [hash]);
    const row = rows[0];
    if (!row) return { ok: false, error: 'expired_token' };

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await this.db.execute('DELETE FROM device_grant WHERE id = ?', [row.id]);
      return { ok: false, error: 'expired_token' };
    }

    const now = Date.now();
    if (row.last_polled_at && now - new Date(row.last_polled_at).getTime() < row.interval_seconds * 1000) {
      return { ok: false, error: 'slow_down' };
    }
    await this.db.execute('UPDATE device_grant SET last_polled_at = ? WHERE id = ?', [new Date(now).toISOString(), row.id]);

    if (row.status === 'denied') {
      await this.db.execute('DELETE FROM device_grant WHERE id = ?', [row.id]);
      return { ok: false, error: 'access_denied' };
    }

    if (row.status === 'pending') {
      return { ok: false, error: 'authorization_pending' };
    }

    // approved — mint the token now, exactly once, then the grant is gone.
    let token: CreatedApiToken;
    try {
      token = await this.tokenService.issueForPrincipal(
        row.principal_id,
        row.workspace_id,
        { name: 'muster login (device)' },
      );
    } catch (error) {
      // Consume a grant that can no longer be authorized; it must never be
      // retryable after membership or principal state changes.
      await this.db.execute('DELETE FROM device_grant WHERE id = ?', [row.id]);
      await this.auditIssuanceRefusalForStoredGrant(row.workspace_id, row.principal_id, error);
      return { ok: false, error: 'access_denied' };
    }
    await this.db.execute('DELETE FROM device_grant WHERE id = ?', [row.id]);
    await this.auditService?.log({
      workspace_id: row.workspace_id,
      actor: { id: row.principal_id, kind: 'user' },
      action: 'token.create',
      target_type: 'api_token',
      target_id: token.id,
      payload: { via: 'device_grant' },
    });
    return { ok: true, token };
  }

  private async auditIssuanceRefusal(auth: AuthContext, error: unknown): Promise<void> {
    if (!this.auditService || !auth.principal || !auth.workspace_id) return;
    if (!(error instanceof PermissionDeniedError) && !(error instanceof ValidationError)) return;
    try {
      await this.auditService.logAs(auth, {
        action: 'token.create_refused',
        target_type: 'api_token',
        target_id: undefined,
        payload: { via: 'device_grant', reason: error instanceof PermissionDeniedError ? 'forbidden' : 'invalid_request' },
      });
    } catch {
      // Refusal handling must remain safe if the audit sink is unavailable.
    }
  }

  private async auditIssuanceRefusalForStoredGrant(workspaceId: string, principalId: string, error: unknown): Promise<void> {
    if (!this.auditService) return;
    if (!(error instanceof PermissionDeniedError) && !(error instanceof ValidationError)) return;
    try {
      await this.auditService.log({
        workspace_id: workspaceId,
        actor: { id: principalId, kind: 'user' },
        action: 'token.create_refused',
        target_type: 'api_token',
        target_id: undefined,
        payload: { via: 'device_grant', reason: 'authorization_changed' },
      });
    } catch {
      // The grant has already been consumed; do not expose audit failures.
    }
  }
}
