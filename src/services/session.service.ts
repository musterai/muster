// File: src/services/session.service.ts
//
// Browser session management for MUS-25. A session is an opaque, random
// token handed to the browser as an httpOnly cookie; only its SHA-256 hash
// is stored, mirroring the PAT design in token.service.ts. Logout deletes
// the row outright — there is no "revoked but visible" state to track for
// sessions the way there is for named, listable API tokens.

import crypto from 'node:crypto';
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';

const SECRET_BYTES = 32;
const LAST_SEEN_THROTTLE_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export interface CreatedSession {
  id: string;
  token: string;
  user_id: string;
  expires_at: string;
}

export interface SessionVerification {
  id: string;
  user_id: string;
}

export class SessionService {
  constructor(private db: DatabaseAdapter) {}

  async create(
    userId: string,
    opts?: { userAgent?: string | null; ip?: string | null; ttlMs?: number },
    adapter: DatabaseAdapter = this.db,
  ): Promise<CreatedSession> {
    const id = ulid();
    const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
    const tokenHash = hashSessionToken(secret);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (opts?.ttlMs ?? DEFAULT_SESSION_TTL_MS));

    await adapter.execute(
      `INSERT INTO session (id, user_id, token_hash, expires_at, last_seen_at, user_agent, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, tokenHash, expiresAt.toISOString(), null, opts?.userAgent || null, opts?.ip || null, now.toISOString()],
    );

    return { id, token: secret, user_id: userId, expires_at: expiresAt.toISOString() };
  }

  /** Verify a session token. Throttles last_seen_at the same way PAT last_used_at is throttled. */
  async verify(token: string): Promise<SessionVerification | null> {
    if (!token) return null;
    const hash = hashSessionToken(token);

    const rows = await this.db.query<any>(
      'SELECT id, user_id, token_hash, expires_at, last_seen_at FROM session WHERE token_hash = ?',
      [hash],
    );
    if (rows.length === 0) return null;

    const row = rows[0];
    if (!timingSafeEqual(hash, row.token_hash)) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;

    const now = new Date();
    const lastSeen = row.last_seen_at ? new Date(row.last_seen_at) : null;
    if (!lastSeen || now.getTime() - lastSeen.getTime() > LAST_SEEN_THROTTLE_MS) {
      await this.db.execute('UPDATE session SET last_seen_at = ? WHERE id = ?', [now.toISOString(), row.id]);
    }

    return { id: row.id, user_id: row.user_id };
  }

  /** Logout — invalidates the session server-side immediately. */
  async revokeByToken(token: string): Promise<void> {
    const hash = hashSessionToken(token);
    await this.db.execute('DELETE FROM session WHERE token_hash = ?', [hash]);
  }

  /** Invalidate one session after a membership/status recheck fails. */
  async revokeById(id: string): Promise<void> {
    await this.db.execute('DELETE FROM session WHERE id = ?', [id]);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.execute('DELETE FROM session WHERE user_id = ?', [userId]);
  }
}
