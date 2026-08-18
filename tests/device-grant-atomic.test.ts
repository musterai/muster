// MUS-62 device-grant concurrency and rollback coverage.
//
// Every race uses two SQLiteAdapter instances against the same isolated file.
// This exercises the same WAL/BEGIN IMMEDIATE boundary that two server
// requests use, rather than merely calling one service twice on one adapter.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter, ExecutionResult } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { AuditService } from '../src/services/audit.service.js';
import { DeviceGrantService } from '../src/services/device-grant.service.js';
import { RoleService } from '../src/services/role.service.js';
import { TokenService } from '../src/services/token.service.js';
import type { AuthContext } from '../src/shared/auth-context.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-device-grant-atomic.db');
const WORKSPACE_ID = 'ws-device-grant-atomic';
const USER_ID = 'user-device-grant-atomic';

type Failure = {
  matcher: (sql: string) => boolean;
  remaining: number;
  message: string;
};

/**
 * Preserve the adapter boundary while injecting one deterministic write
 * failure.  transaction() wraps the transaction-bound adapter too, so a
 * DeviceGrantService-created TokenService/AuditService sees the injection.
 */
class FailOnceAdapter implements DatabaseAdapter {
  readonly dialect: 'sqlite' | 'postgres';

  constructor(private readonly delegate: DatabaseAdapter, private readonly failure: Failure) {
    this.dialect = delegate.dialect;
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.delegate.query<T>(sql, params);
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecutionResult> {
    if (this.failure.remaining > 0 && this.failure.matcher(sql)) {
      this.failure.remaining -= 1;
      throw new Error(this.failure.message);
    }
    return this.delegate.execute(sql, params);
  }

  transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.delegate.transaction(tx => fn(new FailOnceAdapter(tx, this.failure)));
  }

  migrate(sql: string): Promise<void> {
    return this.delegate.migrate(sql);
  }

  close(): Promise<void> {
    return this.delegate.close();
  }
}

class DelayOnceAdapter implements DatabaseAdapter {
  readonly dialect: 'sqlite' | 'postgres';
  private delayed = false;

  constructor(
    private readonly delegate: DatabaseAdapter,
    private readonly matcher: (sql: string) => boolean,
    private readonly delayMs: number,
  ) {
    this.dialect = delegate.dialect;
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!this.delayed && this.matcher(sql)) {
      this.delayed = true;
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
    return this.delegate.query<T>(sql, params);
  }

  execute(sql: string, params?: unknown[]): Promise<ExecutionResult> {
    return this.delegate.execute(sql, params);
  }

  transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.delegate.transaction(tx => fn(new DelayOnceAdapter(tx, this.matcher, this.delayMs)));
  }

  migrate(sql: string): Promise<void> { return this.delegate.migrate(sql); }
  close(): Promise<void> { return this.delegate.close(); }
}

async function seedDatabase(db: DatabaseAdapter): Promise<AuthContext> {
  const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
  await migrator.run();

  const now = new Date().toISOString();
  await db.execute(
    'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [WORKSPACE_ID, 'Device Atomicity', 'device-atomicity', now, now],
  );
  await db.execute(
    'INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)',
    [USER_ID, 'user', now],
  );
  await db.execute(
    'INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)',
    [USER_ID, 'Device Approver', 'active', now],
  );

  const roles = await new RoleService(db).seedPreset(WORKSPACE_ID);
  const ownerRole = roles.find(role => role.key === 'owner');
  if (!ownerRole) throw new Error('owner preset role was not seeded');
  await db.execute(
    'INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)',
    [WORKSPACE_ID, USER_ID, ownerRole.id, now],
  );

  return {
    principal: { kind: 'user', id: USER_ID },
    workspace_id: WORKSPACE_ID,
    is_workspace_member: true,
    permissions: ownerRole.permissions,
    is_operator_override: true,
    role_name: ownerRole.name,
  };
}

async function countRows(db: DatabaseAdapter, table: string): Promise<number> {
  const rows = await db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(rows[0]?.count || 0);
}

async function raceAtBarrier<T>(operations: Array<() => Promise<T>>): Promise<T[]> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let ready = 0;
  return Promise.all(operations.map(async operation => {
    ready += 1;
    if (ready === operations.length) release();
    await gate;
    return operation();
  }));
}

describe('MUS-62: device-grant atomicity', () => {
  let dbA: DatabaseAdapter;
  let dbB: DatabaseAdapter;
  let serviceA: DeviceGrantService;
  let serviceB: DeviceGrantService;
  let auth: AuthContext;

  beforeEach(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* isolated test file may not exist */ }
    }

    dbA = createDatabaseAdapter(TEST_DB);
    auth = await seedDatabase(dbA);
    dbB = createDatabaseAdapter(TEST_DB);
    serviceA = new DeviceGrantService(dbA, new TokenService(dbA), new AuditService(dbA));
    serviceB = new DeviceGrantService(dbB, new TokenService(dbB), new AuditService(dbB));
  });

  afterEach(async () => {
    await dbB?.close();
    await dbA?.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* cleanup is best effort */ }
    }
  });

  it('delivers an approved grant to exactly one concurrent poller', async () => {
    const grant = await serviceA.createDeviceCode();
    expect(await serviceA.approve(grant.user_code, auth)).toBe(true);

    const [resultA, resultB] = await raceAtBarrier([
      () => serviceA.poll(grant.device_code),
      () => serviceB.poll(grant.device_code),
    ]);
    const results = [resultA, resultB];

    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.error === 'expired_token')).toHaveLength(1);
    expect(await countRows(dbA, 'api_token')).toBe(1);
    expect(await countRows(dbA, 'device_grant')).toBe(0);

    const audits = await dbA.query<{ action: string; payload: string }>(
      "SELECT action, payload FROM audit_log WHERE action = 'token.create'",
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].payload)).toEqual({ via: 'device_grant' });
  });

  it('serializes concurrent pending polls: one records the poll and the other slows down', async () => {
    const grant = await serviceA.createDeviceCode();

    const [resultA, resultB] = await raceAtBarrier([
      () => serviceA.poll(grant.device_code),
      () => serviceB.poll(grant.device_code),
    ]);
    const errors = [resultA, resultB]
      .filter((result): result is { ok: false; error: string } => !result.ok)
      .map(result => result.error)
      .sort();

    expect(errors).toEqual(['authorization_pending', 'slow_down']);
    expect(await countRows(dbA, 'api_token')).toBe(0);
    const rows = await dbA.query<{ status: string; last_polled_at: string | null }>(
      'SELECT status, last_polled_at FROM device_grant',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].last_polled_at).toEqual(expect.any(String));
  });

  it('makes concurrent approval and denial a one-winner CAS', async () => {
    const grant = await serviceA.createDeviceCode();

    const [approved, denied] = await raceAtBarrier([
      () => serviceA.approve(grant.user_code, auth),
      () => serviceB.deny(grant.user_code),
    ]);

    expect([approved, denied].filter(Boolean)).toHaveLength(1);
    const rows = await dbA.query<{ status: string }>('SELECT status FROM device_grant');
    expect(rows).toHaveLength(1);
    expect(['approved', 'denied']).toContain(rows[0].status);
    if (approved) {
      const bound = await dbA.query<{ principal_id: string; workspace_id: string }>(
        'SELECT principal_id, workspace_id FROM device_grant',
      );
      expect(bound[0]).toEqual({ principal_id: USER_ID, workspace_id: WORKSPACE_ID });
    }
  });

  it('does not approve a grant that expires during authorization work', async () => {
    const grant = await serviceA.createDeviceCode();
    await dbA.execute(
      'UPDATE device_grant SET expires_at = ? WHERE user_code = ?',
      [new Date(Date.now() + 20).toISOString(), grant.user_code],
    );
    const delayedDb = new DelayOnceAdapter(dbA, sql => /SELECT kind FROM principal/i.test(sql), 50);
    const delayedService = new DeviceGrantService(
      delayedDb,
      new TokenService(delayedDb),
      new AuditService(delayedDb),
    );

    expect(await delayedService.approve(grant.user_code, auth)).toBe(false);
    expect(await dbA.query<{ status: string }>('SELECT status FROM device_grant'))
      .toEqual([{ status: 'pending' }]);
  });

  it('consumes an approved grant when live membership policy changes before polling', async () => {
    const grant = await serviceA.createDeviceCode();
    expect(await serviceA.approve(grant.user_code, auth)).toBe(true);
    await dbA.execute(
      'DELETE FROM workspace_member WHERE workspace_id = ? AND user_id = ?',
      [WORKSPACE_ID, USER_ID],
    );

    const result = await serviceA.poll(grant.device_code);
    expect(result).toEqual({ ok: false, error: 'access_denied' });
    expect(await countRows(dbA, 'device_grant')).toBe(0);
    expect(await countRows(dbA, 'api_token')).toBe(0);
    const audits = await dbA.query<{ action: string; payload: string }>(
      "SELECT action, payload FROM audit_log WHERE action = 'token.create_refused'",
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].payload)).toMatchObject({ via: 'device_grant' });
  });

  it('rolls back the grant when token persistence fails unexpectedly', async () => {
    const grant = await serviceA.createDeviceCode();
    expect(await serviceA.approve(grant.user_code, auth)).toBe(true);

    const failingDb = new FailOnceAdapter(dbA, {
      matcher: sql => /INSERT\s+INTO\s+api_token/i.test(sql),
      remaining: 1,
      message: 'injected api_token failure',
    });
    const failingService = new DeviceGrantService(
      failingDb,
      new TokenService(failingDb),
      new AuditService(failingDb),
    );

    await expect(failingService.poll(grant.device_code)).rejects.toThrow('injected api_token failure');
    expect(await countRows(dbA, 'api_token')).toBe(0);
    expect(await countRows(dbA, 'device_grant')).toBe(1);

    const retry = await serviceA.poll(grant.device_code);
    expect(retry.ok).toBe(true);
    expect(await countRows(dbA, 'api_token')).toBe(1);
    expect(await countRows(dbA, 'device_grant')).toBe(0);
  });

  it('rolls back both token and grant when the winning audit write fails', async () => {
    const grant = await serviceA.createDeviceCode();
    expect(await serviceA.approve(grant.user_code, auth)).toBe(true);

    const failingDb = new FailOnceAdapter(dbA, {
      matcher: sql => /INSERT\s+INTO\s+audit_log/i.test(sql),
      remaining: 1,
      message: 'injected audit failure',
    });
    const failingService = new DeviceGrantService(
      failingDb,
      new TokenService(failingDb),
      new AuditService(failingDb),
    );

    await expect(failingService.poll(grant.device_code)).rejects.toThrow('injected audit failure');
    expect(await countRows(dbA, 'api_token')).toBe(0);
    expect(await countRows(dbA, 'device_grant')).toBe(1);

    const retry = await serviceA.poll(grant.device_code);
    expect(retry.ok).toBe(true);
    expect(await countRows(dbA, 'api_token')).toBe(1);
    expect(await countRows(dbA, 'device_grant')).toBe(0);
  });
});
