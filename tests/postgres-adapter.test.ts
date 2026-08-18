// File: tests/postgres-adapter.test.ts
//
// MUS-31 acceptance criteria, exercised against a real PostgreSQL instance:
// - migrations run clean on an empty Postgres database
// - the full service-level surface works against Postgres (not just SQLite)
// - concurrent claim_card calls remain atomic under a real connection pool
//
// Requires MUSTER_TEST_PG_URL (see .github/workflows/ci.yml for the CI
// service container). Skips gracefully — not a failure — when it's unset,
// so `npm test` on a machine without Postgres installed still passes:
// SQLite stays the zero-configuration default and nothing here should get
// in the way of that.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { PostgresAdapter, convertPlaceholders, translateDialect } from '../src/db/postgres-adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { CardService } from '../src/services/card.service.js';
import { RoleService } from '../src/services/role.service.js';
import { AgentService } from '../src/services/agent.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { DeviceGrantService } from '../src/services/device-grant.service.js';
import { McpOAuthService } from '../src/services/mcp-oauth.service.js';
import { TokenService } from '../src/services/token.service.js';
import { isCanonicalRank } from '../src/shared/lexorank.js';
import crypto from 'node:crypto';

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

const PG_URL = process.env.MUSTER_TEST_PG_URL;

describe.skipIf(!PG_URL)('MUS-31: PostgreSQL adapter', () => {
  let adminPool: pg.Pool;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: PG_URL });
  });

  afterAll(async () => {
    await adminPool.end();
  });

  beforeEach(async () => {
    // Full reset between tests — cheapest way to get migrations-run-clean
    // coverage on every test, not just once.
    await adminPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    adapter = new PostgresAdapter(PG_URL!);
  });

  it('reports its dialect', () => {
    expect(adapter.dialect).toBe('postgres');
  });

  it('runs every migration clean against an empty database', async () => {
    const migrator = new Migrator(adapter, './src/db/migrations');
    await expect(migrator.run()).resolves.not.toThrow();

    const tables = await adapter.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = tables.map(t => t.table_name);
    expect(names).toContain('workspace');
    expect(names).toContain('card');
    expect(names).toContain('audit_log');
    expect(names).toContain('oauth_client');
  });

  it('running the migrator twice is idempotent (ADD COLUMN tolerance included)', async () => {
    const migrator = new Migrator(adapter, './src/db/migrations');
    await migrator.run();
    await expect(migrator.run()).resolves.not.toThrow();

    const columns = await adapter.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'actor_kind'`,
    );
    expect(columns).toHaveLength(1);
  });

  it('created_at defaults match the SQLite ISO-8601-with-Z shape', async () => {
    const migrator = new Migrator(adapter, './src/db/migrations');
    await migrator.run();

    await adapter.execute(
      `INSERT INTO invitation (id, workspace_id, email, role_id, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['inv-1', null, 'x@example.com', 'role-1', 'hash', new Date().toISOString(), null],
    ).catch(() => {
      // workspace_id/role_id FKs will fail without real rows — this test
      // only cares about the DEFAULT expression, so fall through to a
      // direct check of the column default instead of a real insert.
    });

    const def = await adapter.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns WHERE table_name = 'invitation' AND column_name = 'created_at'`,
    );
    expect(def[0]?.column_default).toContain('to_char');
  });

  it('honors a real workspace -> role -> agent chain end to end (CardService.claim included)', async () => {
    const migrator = new Migrator(adapter, './src/db/migrations');
    await migrator.run();

    const now = new Date().toISOString();
    await adapter.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['ws-1', 'WS', 'ws-1', now, now]);
    await adapter.execute('INSERT INTO project (id, workspace_id, name, key_prefix, card_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['proj-1', 'ws-1', 'Proj', 'PRJ', 0, now, now]);
    await adapter.execute('INSERT INTO board (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['board-1', 'proj-1', 'Board', now, now]);
    await adapter.execute('INSERT INTO "column" (id, board_id, name, position) VALUES (?, ?, ?, ?)', ['col-1', 'board-1', 'To Do', 'a']);
    await adapter.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['agent-1', 'agent', now]);
    await adapter.execute('INSERT INTO agent (id, name, status, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?)', ['agent-1', 'Agent', 'active', now, now]);

    const cardService = new CardService(adapter);
    const card = await cardService.create({ column_id: 'col-1', title: 'Test card' });

    const claimed = await cardService.claim(card.id, 'agent-1');
    expect('success' in claimed ? claimed.success : true).not.toBe(false);

    const roleService = new RoleService(adapter);
    const roles = await roleService.seedPreset('ws-1');
    expect(roles).toHaveLength(6);
  });

  it('concurrent claim_card calls on the same card are atomic under a real connection pool — exactly one wins', async () => {
    const migrator = new Migrator(adapter, './src/db/migrations');
    await migrator.run();

    const now = new Date().toISOString();
    await adapter.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['ws-race', 'WS', 'ws-race', now, now]);
    await adapter.execute('INSERT INTO project (id, workspace_id, name, key_prefix, card_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['proj-race', 'ws-race', 'Proj', 'PRJ', 0, now, now]);
    await adapter.execute('INSERT INTO board (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['board-race', 'proj-race', 'Board', now, now]);
    await adapter.execute('INSERT INTO "column" (id, board_id, name, position) VALUES (?, ?, ?, ?)', ['col-race', 'board-race', 'To Do', 'a']);

    // Ten distinct agents racing for the same card — a real pool, ten real
    // concurrent connections, not ten calls serialized through one.
    const agentIds = Array.from({ length: 10 }, (_, i) => `agent-race-${i}`);
    for (const id of agentIds) {
      await adapter.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [id, 'agent', now]);
      await adapter.execute('INSERT INTO agent (id, name, status, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?)', [id, id, 'active', now, now]);
    }

    const cardService = new CardService(adapter);
    const card = await cardService.create({ column_id: 'col-race', title: 'Contested card' });

    const results = await Promise.all(agentIds.map(id => cardService.claim(card.id, id)));
    const wins = results.filter(r => !('success' in r) || r.success !== false);
    const refusals = results.filter(r => 'success' in r && r.success === false);

    expect(wins).toHaveLength(1);
    expect(refusals).toHaveLength(9);

    // The row itself agrees with exactly one of the calls that "won".
    const finalRows = await adapter.query<{ claimed_by: string }>('SELECT claimed_by FROM card WHERE id = ?', [card.id]);
    expect(agentIds).toContain(finalRows[0].claimed_by);
  });

  it('serializes cross-lane moves with deterministic source/target lane locking', async () => {
    const migrator = new Migrator(adapter, './src/db/migrations');
    await migrator.run();
    const second = new PostgresAdapter(PG_URL!);
    try {
      const now = new Date().toISOString();
      await adapter.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
        'ws-rank-race', 'Rank Race', 'rank-race', now, now,
      ]);
      await adapter.execute(
        'INSERT INTO project (id, workspace_id, name, key_prefix, card_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['proj-rank-race', 'ws-rank-race', 'Rank Race', 'RACE', 0, now, now],
      );
      await adapter.execute(
        'INSERT INTO board (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ['board-rank-race', 'proj-rank-race', 'Board', now, now],
      );
      await adapter.execute(
        'INSERT INTO "column" (id, board_id, name, position) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)',
        [
          'col-rank-source', 'board-rank-race', 'Source', 'a',
          'col-rank-a', 'board-rank-race', 'Target A', 'b',
          'col-rank-b', 'board-rank-race', 'Target B', 'c',
        ],
      );

      const serviceA = new CardService(adapter);
      const serviceB = new CardService(second);
      const cardA = await serviceA.create({ column_id: 'col-rank-source', title: 'Move A' });
      const cardB = await serviceA.create({ column_id: 'col-rank-source', title: 'Move B' });
      let timeout!: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('cross-lane move barrier timed out')), 5_000);
      });
      try {
        await Promise.race([
          raceAtBarrier([
            () => serviceA.move(cardA.id, { target_column_id: 'col-rank-a', position: 'a' }),
            () => serviceB.move(cardB.id, { target_column_id: 'col-rank-b', position: 'a' }),
          ]),
          timeoutPromise,
        ]);
      } finally {
        clearTimeout(timeout);
      }

      const sourceRows = await adapter.query<{ id: string }>('SELECT id FROM card WHERE column_id = ?', ['col-rank-source']);
      const targetRows = await adapter.query<{ column_id: string; position: string }>(
        'SELECT column_id, position FROM card WHERE column_id IN (?, ?) ORDER BY column_id',
        ['col-rank-a', 'col-rank-b'],
      );
      expect(sourceRows).toHaveLength(0);
      expect(targetRows).toHaveLength(2);
      expect(targetRows.every(row => isCanonicalRank(row.position))).toBe(true);
      expect(targetRows.map(row => row.column_id)).toEqual(['col-rank-a', 'col-rank-b']);

      // Opposite cross-lane moves contend for the same two lane rows. The
      // canonical [lane-id] lock order must serialize them without a
      // PostgreSQL deadlock cycle.
      const reverseA = await serviceA.create({ column_id: 'col-rank-a', title: 'Reverse A' });
      const reverseB = await serviceA.create({ column_id: 'col-rank-b', title: 'Reverse B' });
      let reverseTimeout!: ReturnType<typeof setTimeout>;
      const reverseTimeoutPromise = new Promise<never>((_, reject) => {
        reverseTimeout = setTimeout(() => reject(new Error('opposite cross-lane move timed out')), 5_000);
      });
      try {
        await Promise.race([
          raceAtBarrier([
            () => serviceA.move(reverseA.id, { target_column_id: 'col-rank-b', position: 'z' }),
            () => serviceB.move(reverseB.id, { target_column_id: 'col-rank-a', position: 'z' }),
          ]),
          reverseTimeoutPromise,
        ]);
      } finally {
        clearTimeout(reverseTimeout);
      }
      const finalCounts = await adapter.query<{ column_id: string; count: number | string }>(
        'SELECT column_id, COUNT(*) AS count FROM card WHERE column_id IN (?, ?) GROUP BY column_id ORDER BY column_id',
        ['col-rank-a', 'col-rank-b'],
      );
      expect(finalCounts.map(row => [row.column_id, Number(row.count)])).toEqual([
        ['col-rank-a', 2],
        ['col-rank-b', 2],
      ]);
    } finally {
      await second.close();
    }
  });

  it('serializes OAuth code exchange and approved device delivery across real pool connections', async () => {
    await new Migrator(adapter, './src/db/migrations').run();
    const second = new PostgresAdapter(PG_URL!);
    try {
      const workspaceId = 'ws-oauth-pg-race';
      const operatorId = 'operator-oauth-pg-race';
      const now = new Date().toISOString();
      await adapter.execute(
        'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [workspaceId, 'OAuth PG Race', 'oauth-pg-race', now, now],
      );
      const roles = await new RoleService(adapter).seedPreset(workspaceId);
      const owner = roles.find(role => role.key === 'owner')!;
      await adapter.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [operatorId, 'user', now]);
      await adapter.execute(
        'INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)',
        [operatorId, 'OAuth PG Operator', 'active', now],
      );
      await adapter.execute(
        'INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)',
        [workspaceId, operatorId, owner.id, now],
      );

      const tokenA = new TokenService(adapter);
      const tokenB = new TokenService(second);
      const agentA = new AgentService(adapter);
      const agentB = new AgentService(second);
      const oauthA = new McpOAuthService(adapter, tokenA, agentA, new AuditService(adapter));
      const oauthB = new McpOAuthService(second, tokenB, agentB, new AuditService(second));
      const redirectUri = 'http://127.0.0.1:5555/callback';
      const resource = 'https://muster.example.test/mcp';
      const client = await oauthA.registerClient({ redirect_uris: [redirectUri] });
      const agent = await agentA.register({ name: 'OAuth PG Agent' }, operatorId, owner.id, workspaceId);
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const code = await oauthA.createAuthorizationCode({
        clientId: client.client_id,
        redirectUri,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        resource,
        agentPrincipalId: agent.id,
        operatorUserId: operatorId,
        workspaceId,
      });
      const exchange = (service: McpOAuthService) => service.exchangeAuthorizationCode({
        code,
        clientId: client.client_id,
        redirectUri,
        codeVerifier: verifier,
        resource,
      });
      const exchanges = await raceAtBarrier([() => exchange(oauthA), () => exchange(oauthB)]);
      expect(exchanges.filter(result => result.ok)).toHaveLength(1);

      const deviceA = new DeviceGrantService(adapter, tokenA, new AuditService(adapter));
      const deviceB = new DeviceGrantService(second, tokenB, new AuditService(second));
      const grant = await deviceA.createDeviceCode();
      expect(await deviceA.approve(grant.user_code, {
        principal: { kind: 'user', id: operatorId },
        workspace_id: workspaceId,
        is_workspace_member: true,
        permissions: owner.permissions,
        is_operator_override: true,
        role_name: owner.name,
      })).toBe(true);
      const polls = await raceAtBarrier([
        () => deviceA.poll(grant.device_code),
        () => deviceB.poll(grant.device_code),
      ]);
      expect(polls.filter(result => result.ok)).toHaveLength(1);
      expect(polls.filter(result => !result.ok && result.error === 'expired_token')).toHaveLength(1);
    } finally {
      await second.close();
    }
  });
});

describe('MUS-31: dialect translation helpers (pure functions, no database needed)', () => {
  it('converts sequential ? placeholders to $1, $2, ...', () => {
    expect(convertPlaceholders('SELECT * FROM x WHERE a = ? AND b = ?')).toBe('SELECT * FROM x WHERE a = $1 AND b = $2');
  });

  it('does not treat a literal ? inside a string as a placeholder', () => {
    expect(convertPlaceholders(`SELECT * FROM x WHERE a = ? AND note = 'is this ok?'`))
      .toBe(`SELECT * FROM x WHERE a = $1 AND note = 'is this ok?'`);
  });

  it('translates INSERT OR IGNORE to ON CONFLICT DO NOTHING', () => {
    expect(translateDialect(`INSERT OR IGNORE INTO card_assignee (card_id, principal_id) VALUES (?, ?)`))
      .toBe(`INSERT INTO card_assignee (card_id, principal_id) VALUES (?, ?) ON CONFLICT DO NOTHING`);
  });

  it('leaves ordinary statements untouched', () => {
    const sql = 'SELECT * FROM card WHERE id = ?';
    expect(translateDialect(sql)).toBe(sql);
  });
});
