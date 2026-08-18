import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { Migrator } from '../src/db/migrator.js';

type Fixture = { db: DatabaseAdapter; dir: string };
const fixtures: Fixture[] = [];
const migrationsDir = path.join(process.cwd(), 'src/db/migrations');

function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-credential-indexes-'));
  const db = createDatabaseAdapter(path.join(dir, 'muster.db'));
  const value = { db, dir };
  fixtures.push(value);
  return value;
}

async function migratedFixture(): Promise<Fixture> {
  const value = fixture();
  await new Migrator(value.db, migrationsDir).run();
  return value;
}

async function seedIdentity(db: DatabaseAdapter): Promise<{ now: string; workspaceId: string; principalId: string; userId: string; roleId: string }> {
  const now = new Date().toISOString();
  const workspaceId = 'credential-index-workspace';
  const principalId = 'credential-index-principal';
  const userId = principalId;
  const roleId = 'credential-index-role';

  await db.execute(
    'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [workspaceId, 'Credential Index Workspace', 'credential-index', now, now],
  );
  await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [principalId, 'user', now]);
  await db.execute(
    'INSERT INTO app_user (id, email, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, 'credential-index@example.com', 'Credential Index User', 'active', now],
  );
  await db.execute(
    'INSERT INTO role (id, workspace_id, key, name, permissions_json, is_system, rank) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [roleId, workspaceId, 'credential-index', 'Credential Index', '[]', 0, 0],
  );

  return { now, workspaceId, principalId, userId, roleId };
}

async function indexList(db: DatabaseAdapter, table: string): Promise<Array<{ name: string; unique: number; partial: number }>> {
  return db.query(`PRAGMA index_list("${table}")`);
}

async function explain(db: DatabaseAdapter, sql: string, params: unknown[] = []): Promise<string> {
  const rows = await db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
  return rows.map(row => row.detail).join('\n');
}

afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    await value.db.close();
    fs.rmSync(value.dir, { recursive: true, force: true });
  }
});

describe('MUS-70 credential lookup indexes', () => {
  it('adds unique constraints for missing hashed credential classes without changing existing invariants', async () => {
    const { db } = await migratedFixture();
    const { now, workspaceId, principalId, userId, roleId } = await seedIdentity(db);

    const apiIndexes = await indexList(db, 'api_token');
    const sessionIndexes = await indexList(db, 'session');
    const invitationIndexes = await indexList(db, 'invitation');
    const deviceIndexes = await indexList(db, 'device_grant');
    const oauthCodeIndexes = await indexList(db, 'oauth_authorization_code');
    const oauthRefreshIndexes = await indexList(db, 'oauth_refresh_token');

    expect(apiIndexes.find(index => index.name === 'idx_api_token_token_hash')?.unique).toBe(1);
    expect(sessionIndexes.find(index => index.name === 'idx_session_token_hash')?.unique).toBe(1);
    expect(invitationIndexes.find(index => index.name === 'idx_invitation_token_hash')?.unique).toBe(1);
    expect(invitationIndexes.find(index => index.name === 'idx_invitation_pending_email')?.partial).toBe(1);
    // These are deliberately not duplicated by MUS-70: the introducing
    // migrations already provide the required unique/lookup indexes.
    expect(deviceIndexes.find(index => index.name === 'idx_device_grant_code_hash')?.unique).toBe(1);
    expect(oauthCodeIndexes.some(index => index.unique === 1)).toBe(true);
    expect(oauthRefreshIndexes.some(index => index.unique === 1)).toBe(true);
    expect(oauthRefreshIndexes.filter(index => index.name === 'idx_oauth_refresh_family')).toHaveLength(1);

    await db.execute(
      `INSERT INTO api_token (id, principal_id, workspace_id, name, token_hash, prefix, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['api-token-1', principalId, workspaceId, 'one', 'api-hash-1', 'prefix1', null, now],
    );
    await expect(db.execute(
      `INSERT INTO api_token (id, principal_id, workspace_id, name, token_hash, prefix, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['api-token-2', principalId, workspaceId, 'two', 'api-hash-1', 'prefix2', null, now],
    )).rejects.toThrow(/unique/i);

    await db.execute(
      `INSERT INTO session (id, user_id, token_hash, expires_at, last_seen_at, user_agent, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['session-1', userId, 'session-hash-1', new Date(Date.now() + 60_000).toISOString(), null, null, null, now],
    );
    await expect(db.execute(
      `INSERT INTO session (id, user_id, token_hash, expires_at, last_seen_at, user_agent, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['session-2', userId, 'session-hash-1', new Date(Date.now() + 60_000).toISOString(), null, null, null, now],
    )).rejects.toThrow(/unique/i);

    await db.execute(
      `INSERT INTO invitation (id, workspace_id, email, role_id, token_hash, expires_at, accepted_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['invitation-1', workspaceId, 'one@example.com', roleId, 'invitation-hash-1', new Date(Date.now() + 60_000).toISOString(), null, null, now],
    );
    await expect(db.execute(
      `INSERT INTO invitation (id, workspace_id, email, role_id, token_hash, expires_at, accepted_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['invitation-2', workspaceId, 'two@example.com', roleId, 'invitation-hash-1', new Date(Date.now() + 60_000).toISOString(), null, null, now],
    )).rejects.toThrow(/unique/i);
  });

  it('uses the intended indexes for active, revoked, pending, device, and rotated credential paths', async () => {
    const { db } = await migratedFixture();

    const apiPlan = await explain(db, 'SELECT id FROM api_token WHERE token_hash = ? AND revoked_at IS NULL', ['api-hash']);
    const sessionPlan = await explain(db, 'SELECT id FROM session WHERE token_hash = ?', ['session-hash']);
    const invitationPlan = await explain(
      db,
      `SELECT id FROM invitation
       WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL
       ORDER BY created_at DESC`,
      ['workspace', 'user@example.com'],
    );
    const devicePlan = await explain(db, 'SELECT id FROM device_grant WHERE device_code_hash = ?', ['device-hash']);
    const oauthCodePlan = await explain(db, 'SELECT * FROM oauth_authorization_code WHERE code_hash = ?', ['code-hash']);
    const oauthRefreshPlan = await explain(db, 'SELECT * FROM oauth_refresh_token WHERE token_hash = ?', ['refresh-hash']);
    const oauthFamilyPlan = await explain(
      db,
      'SELECT current_api_token_id FROM oauth_refresh_token WHERE family_id = ? AND revoked = 0',
      ['family-id'],
    );

    expect(apiPlan).toContain('idx_api_token_token_hash');
    expect(sessionPlan).toContain('idx_session_token_hash');
    expect(invitationPlan).toContain('idx_invitation_pending_email');
    expect(devicePlan).toContain('idx_device_grant_code_hash');
    expect(oauthCodePlan).toMatch(/(code_hash|sqlite_autoindex_oauth_authorization_code)/i);
    expect(oauthRefreshPlan).toMatch(/(token_hash|sqlite_autoindex_oauth_refresh_token)/i);
    expect(oauthFamilyPlan).toContain('idx_oauth_refresh_family');
  });

  it('keeps accepted/revoked rows addressable while the partial pending index excludes them', async () => {
    const { db } = await migratedFixture();
    const { now, workspaceId, principalId, roleId } = await seedIdentity(db);
    const future = new Date(Date.now() + 60_000).toISOString();

    await db.execute(
      `INSERT INTO api_token (id, principal_id, workspace_id, name, token_hash, prefix, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['revoked-api-token', principalId, workspaceId, 'revoked', 'revoked-api-hash', 'revoked', null, now, now],
    );
    expect(await db.query('SELECT id FROM api_token WHERE token_hash = ?', ['revoked-api-hash'])).toEqual([{ id: 'revoked-api-token' }]);

    await db.execute(
      `INSERT INTO invitation (id, workspace_id, email, role_id, token_hash, expires_at, accepted_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['accepted-invitation', workspaceId, 'same@example.com', roleId, 'accepted-hash', future, now, null, now],
    );
    await db.execute(
      `INSERT INTO invitation (id, workspace_id, email, role_id, token_hash, expires_at, accepted_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pending-invitation', workspaceId, 'same@example.com', roleId, 'pending-hash', future, null, null, future],
    );

    const pending = await db.query<{ id: string }>(
      `SELECT id FROM invitation
       WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL
       ORDER BY created_at DESC`,
      [workspaceId, 'same@example.com'],
    );
    expect(pending).toEqual([{ id: 'pending-invitation' }]);
    expect(await explain(
      db,
      `SELECT id FROM invitation
       WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL
       ORDER BY created_at DESC`,
      [workspaceId, 'same@example.com'],
    )).toContain('idx_invitation_pending_email');
  });

  it('proves indexed lookup on a large fixture instead of relying on timing alone', async () => {
    const { db } = await migratedFixture();
    const { now, workspaceId, principalId } = await seedIdentity(db);
    const rowCount = 10_000;
    const targetHash = 'benchmark-target-hash';

    await db.transaction(async tx => {
      for (let i = 0; i < rowCount; i += 1) {
        await tx.execute(
          `INSERT INTO api_token (id, principal_id, workspace_id, name, token_hash, prefix, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [`benchmark-token-${i}`, principalId, workspaceId, 'benchmark', `benchmark-hash-${i}`, 'benchmark', null, now],
        );
      }
      await tx.execute(
        `INSERT INTO api_token (id, principal_id, workspace_id, name, token_hash, prefix, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['benchmark-target', principalId, workspaceId, 'benchmark', targetHash, 'benchmark', null, now],
      );
    });

    const plan = await explain(db, 'SELECT id FROM api_token WHERE token_hash = ?', [targetHash]);
    expect(plan).toContain('idx_api_token_token_hash');

    const startedAt = performance.now();
    const rows = await db.query<{ id: string }>('SELECT id FROM api_token WHERE token_hash = ?', [targetHash]);
    const elapsedMs = performance.now() - startedAt;
    expect(rows).toEqual([{ id: 'benchmark-target' }]);
    // This is intentionally a generous smoke threshold; the query plan is
    // the assertion that rules out a table scan, not machine speed.
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
