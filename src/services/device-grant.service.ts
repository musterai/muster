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
import type { TransactionServiceProviders } from './transaction-service.factory.js';

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
  constructor(
    private db: DatabaseAdapter,
    private transactionServices: TransactionServiceProviders,
  ) {}

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

    return this.db.transaction(async tx => {
      const rows = await tx.query<{ id: string; status: string; expires_at: string }>(
        `SELECT id, status, expires_at FROM device_grant WHERE user_code = ?${this.lockClause(tx)}`,
        [this.normalizeCode(userCode)],
      );
      const row = rows[0];
      if (!row || row.status !== 'pending') return false;
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await tx.execute('DELETE FROM device_grant WHERE id = ? AND status = \'pending\'', [row.id]);
        return false;
      }

      try {
        await this.transactionServices.token(tx).authorize(auth, {
          principal_id: principalId,
          workspace_id: auth.workspace_id,
          name: 'muster login (device)',
        });
      } catch (error) {
        if (!this.isPolicyFailure(error)) throw error;
        await this.auditIssuanceRefusal(auth, error, this.transactionServices.audit(tx));
        return false;
      }

      const result = await tx.execute(
        `UPDATE device_grant
            SET status = 'approved', principal_id = ?, workspace_id = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?`,
        [principalId, auth.workspace_id, row.id, new Date().toISOString()],
      );
      return result.changes === 1;
    });
  }

  async deny(userCode: string): Promise<boolean> {
    return this.db.transaction(async tx => {
      const rows = await tx.query<{ id: string; status: string; expires_at: string }>(
        `SELECT id, status, expires_at FROM device_grant WHERE user_code = ?${this.lockClause(tx)}`,
        [this.normalizeCode(userCode)],
      );
      const row = rows[0];
      if (!row || row.status !== 'pending') return false;
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await tx.execute('DELETE FROM device_grant WHERE id = ? AND status = \'pending\'', [row.id]);
        return false;
      }
      const result = await tx.execute(
        `UPDATE device_grant
            SET status = 'denied'
          WHERE id = ? AND status = 'pending' AND expires_at > ?`,
        [row.id, new Date().toISOString()],
      );
      return result.changes === 1;
    });
  }

  /**
   * The CLI's poll. Every branch that terminates the grant (expired, denied,
   * successfully claimed) deletes the row — RFC 8628 requires a consumed or
   * lapsed device_code to never be revivable by polling again.
   */
  async poll(deviceCode: string): Promise<PollResult> {
    const hash = hashToken(deviceCode);
    return this.db.transaction(async tx => {
      const rows = await tx.query<any>(
        `SELECT * FROM device_grant WHERE device_code_hash = ?${this.lockClause(tx)}`,
        [hash],
      );
      const row = rows[0];
      if (!row) return { ok: false, error: 'expired_token' };

      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await tx.execute('DELETE FROM device_grant WHERE id = ?', [row.id]);
        return { ok: false, error: 'expired_token' };
      }

      if (row.status === 'denied') {
        const result = await tx.execute(
          `DELETE FROM device_grant WHERE id = ? AND status = 'denied'`,
          [row.id],
        );
        return result.changes === 1
          ? { ok: false, error: 'access_denied' }
          : { ok: false, error: 'expired_token' };
      }

      if (row.status === 'pending') {
        const now = Date.now();
        if (row.last_polled_at && now - new Date(row.last_polled_at).getTime() < row.interval_seconds * 1000) {
          return { ok: false, error: 'slow_down' };
        }

        const nowIso = new Date(now).toISOString();
        const cutoffIso = new Date(now - row.interval_seconds * 1000).toISOString();
        const result = await tx.execute(
          `UPDATE device_grant
              SET last_polled_at = ?
            WHERE id = ?
              AND status = 'pending'
              AND (last_polled_at IS NULL OR last_polled_at <= ?)`,
          [nowIso, row.id, cutoffIso],
        );
        return result.changes === 1
          ? { ok: false, error: 'authorization_pending' }
          : { ok: false, error: 'slow_down' };
      }

      if (row.status !== 'approved') return { ok: false, error: 'expired_token' };

      // Claim before minting.  The delete, token insert and audit row all
      // share this transaction: a second poll cannot deliver the same grant,
      // while an unexpected write failure rolls the claim back atomically.
      const claimed = await tx.execute(
        `DELETE FROM device_grant WHERE id = ? AND status = 'approved'`,
        [row.id],
      );
      if (claimed.changes !== 1) return { ok: false, error: 'expired_token' };

      let token: CreatedApiToken;
      try {
        token = await this.transactionServices.token(tx).issueForPrincipal(
          row.principal_id,
          row.workspace_id,
          { name: 'muster login (device)' },
          tx,
        );
      } catch (error) {
        if (!this.isPolicyFailure(error)) throw error;
        // Membership/principal policy changed after approval.  The grant was
        // already consumed, and the refusal audit is best effort by design.
        await this.auditIssuanceRefusalForStoredGrant(
          row.workspace_id,
          row.principal_id,
          error,
          this.transactionServices.audit(tx),
        );
        return { ok: false, error: 'access_denied' };
      }

      // Successful delivery is not complete until the audit write commits.
      // Let an unexpected audit failure escape so the transaction restores
      // both the grant and the token for a safe retry.
      await this.transactionServices.audit(tx)?.log({
        workspace_id: row.workspace_id,
        actor: { id: row.principal_id, kind: 'user' },
        action: 'token.create',
        target_type: 'api_token',
        target_id: token.id,
        payload: { via: 'device_grant' },
      });
      return { ok: true, token };
    });
  }

  private async auditIssuanceRefusal(auth: AuthContext, error: unknown, auditService = this.transactionServices.audit(this.db)): Promise<void> {
    if (!auditService || !auth.principal || !auth.workspace_id) return;
    if (!(error instanceof PermissionDeniedError) && !(error instanceof ValidationError)) return;
    try {
      await auditService.logAs(auth, {
        action: 'token.create_refused',
        target_type: 'api_token',
        target_id: undefined,
        payload: { via: 'device_grant', reason: error instanceof PermissionDeniedError ? 'forbidden' : 'invalid_request' },
      });
    } catch {
      // Refusal handling must remain safe if the audit sink is unavailable.
    }
  }

  private async auditIssuanceRefusalForStoredGrant(
    workspaceId: string,
    principalId: string,
    error: unknown,
    auditService = this.transactionServices.audit(this.db),
  ): Promise<void> {
    if (!auditService) return;
    if (!(error instanceof PermissionDeniedError) && !(error instanceof ValidationError)) return;
    try {
      await auditService.log({
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

  private normalizeCode(userCode: string): string {
    return userCode.trim().toUpperCase();
  }

  private lockClause(adapter: DatabaseAdapter): string {
    return adapter.dialect === 'postgres' ? ' FOR UPDATE' : '';
  }

  private isPolicyFailure(error: unknown): error is PermissionDeniedError | ValidationError {
    return error instanceof PermissionDeniedError || error instanceof ValidationError;
  }
}
