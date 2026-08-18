// File: src/services/audit.service.ts
//
// Audit log for privileged actions (MUS-30). Every row is written by the
// server as a side effect of the action it records — there is no route
// that accepts an audit_log row as input. See design doc §13.

import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { AuthContext } from '../shared/auth-context.js';

export interface AuditRecord {
  id: string;
  workspace_id: string | null;
  actor_id: string | null;
  actor_kind: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}

export interface LogAuditEntry {
  workspace_id: string | null;
  /** Usually req.authContext — kept loose so callers outside a request (e.g. the OIDC callback before a session exists) can still log. */
  actor?: { id: string; kind: string } | null;
  action: string;
  target_type?: string;
  target_id?: string;
  payload?: Record<string, unknown>;
  ip?: string | null;
}

export class AuditService {
  constructor(private db: DatabaseAdapter) {}

  async log(entry: LogAuditEntry, adapter: DatabaseAdapter = this.db): Promise<void> {
    // audit_log.workspace_id is NOT NULL (001-initial.sql) — deliberately:
    // an audit trail with a dangling unscoped row is worse than one entry
    // short. Open mode has no session-derived workspace, so fall back to
    // the sole workspace (v1 never has more than one) rather than fail the
    // privileged action the audit call is a side effect of.
    let workspaceId = entry.workspace_id;
    if (!workspaceId) {
      const rows = await adapter.query<{ id: string }>('SELECT id FROM workspace LIMIT 1');
      workspaceId = rows[0]?.id || null;
    }
    if (!workspaceId) return; // no workspace exists yet (first boot) — nothing to scope this to

    const id = ulid();
    const now = new Date().toISOString();
    await adapter.execute(
      `INSERT INTO audit_log (id, workspace_id, actor_id, actor_kind, action, target_type, target_id, payload, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        entry.actor?.id || null,
        entry.actor?.kind || null,
        entry.action,
        entry.target_type || null,
        entry.target_id || null,
        entry.payload ? JSON.stringify(entry.payload) : null,
        entry.ip || null,
        now,
      ],
    );
  }

  /** Convenience — most call sites have an AuthContext, not a bare {id, kind}. */
  logAs(
    auth: AuthContext | undefined,
    entry: Omit<LogAuditEntry, 'actor' | 'workspace_id'> & { workspace_id?: string | null },
    adapter: DatabaseAdapter = this.db,
  ): Promise<void> {
    return this.log({
      ...entry,
      workspace_id: entry.workspace_id ?? auth?.workspace_id ?? null,
      actor: auth?.principal ? { id: auth.principal.id, kind: auth.principal.kind } : null,
    }, adapter);
  }

  async list(workspaceId: string, filters: { actor_id?: string; action?: string; limit?: number } = {}): Promise<AuditRecord[]> {
    let sql = 'SELECT * FROM audit_log WHERE workspace_id = ?';
    const params: unknown[] = [workspaceId];

    if (filters.actor_id) {
      sql += ' AND actor_id = ?';
      params.push(filters.actor_id);
    }
    if (filters.action) {
      sql += ' AND action = ?';
      params.push(filters.action);
    }
    sql += ' ORDER BY created_at DESC';
    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }

    const rows = await this.db.query<any>(sql, params);
    return rows.map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
  }
}
