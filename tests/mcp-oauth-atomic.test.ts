import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter, ExecutionResult } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { AgentService } from '../src/services/agent.service.js';
import { McpOAuthService } from '../src/services/mcp-oauth.service.js';
import { RoleService } from '../src/services/role.service.js';
import { TokenService } from '../src/services/token.service.js';

const RESOURCE = 'https://muster.example.test/mcp';

class FailOnceAdapter implements DatabaseAdapter {
  readonly dialect: DatabaseAdapter['dialect'];

  constructor(
    private readonly inner: DatabaseAdapter,
    private readonly pattern: RegExp,
    private readonly state = { failed: false },
  ) {
    this.dialect = inner.dialect;
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.inner.query<T>(sql, params);
  }

  execute(sql: string, params?: unknown[]): Promise<ExecutionResult> {
    if (!this.state.failed && this.pattern.test(sql)) {
      this.state.failed = true;
      throw new Error(`injected failure for ${this.pattern.source}`);
    }
    return this.inner.execute(sql, params);
  }

  transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.inner.transaction(tx => fn(new FailOnceAdapter(tx, this.pattern, this.state)));
  }

  migrate(sql: string): Promise<void> {
    return this.inner.migrate(sql);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
  };
}

describe('MUS-62: atomic OAuth code exchange and refresh rotation', () => {
  let tempDir: string;
  let dbPath: string;
  let dbA: DatabaseAdapter;
  let dbB: DatabaseAdapter;
  let oauthA: McpOAuthService;
  let oauthB: McpOAuthService;
  let tokenA: TokenService;
  let agentId: string;
  let clientId: string;
  let code: string;
  let verifier: string;
  const workspaceId = 'oauth-atomic-workspace';
  const operatorId = 'oauth-atomic-operator';
  const redirectUri = 'http://127.0.0.1:5555/callback';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-oauth-atomic-'));
    dbPath = path.join(tempDir, 'muster.db');
    dbA = createDatabaseAdapter(dbPath);
    await new Migrator(dbA, path.join(process.cwd(), 'src/db/migrations')).run();

    const now = new Date().toISOString();
    await dbA.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'OAuth Atomic', 'oauth-atomic', now, now],
    );
    const roleService = new RoleService(dbA);
    const roles = await roleService.seedPreset(workspaceId);
    const seniorRole = roles.find(role => role.key === 'senior_engineer')!;
    await dbA.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [operatorId, 'user', now]);
    await dbA.execute(
      'INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)',
      [operatorId, 'OAuth Operator', 'active', now],
    );
    await dbA.execute(
      'INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)',
      [workspaceId, operatorId, seniorRole.id, now],
    );

    tokenA = new TokenService(dbA);
    const agentA = new AgentService(dbA);
    oauthA = new McpOAuthService(dbA, tokenA, agentA);
    const client = await oauthA.registerClient({ client_name: 'Atomic Client', redirect_uris: [redirectUri] });
    clientId = client.client_id;
    const agent = await agentA.register({ name: 'Atomic Agent' }, operatorId, seniorRole.id, workspaceId);
    agentId = agent.id;
    const pair = pkcePair();
    verifier = pair.verifier;
    code = await oauthA.createAuthorizationCode({
      clientId,
      redirectUri,
      codeChallenge: pair.challenge,
      codeChallengeMethod: 'S256',
      resource: RESOURCE,
      agentPrincipalId: agentId,
      operatorUserId: operatorId,
      workspaceId,
    });

    dbB = createDatabaseAdapter(dbPath);
    oauthB = new McpOAuthService(dbB, new TokenService(dbB), new AgentService(dbB));
  });

  afterEach(async () => {
    await dbB?.close();
    await dbA?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function exchange(service: McpOAuthService) {
    return service.exchangeAuthorizationCode({
      code,
      clientId,
      redirectUri,
      codeVerifier: verifier,
      resource: RESOURCE,
    });
  }

  it('allows exactly one of two concurrent authorization-code exchanges to mint a family', async () => {
    const results = await Promise.all([exchange(oauthA), exchange(oauthB)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.error === 'invalid_grant')).toHaveLength(1);
    expect(await dbA.query('SELECT id FROM api_token WHERE principal_id = ?', [agentId])).toHaveLength(1);
    expect(await dbA.query('SELECT token_hash FROM oauth_refresh_token')).toHaveLength(1);
    expect(await dbA.query('SELECT code_hash FROM oauth_authorization_code')).toHaveLength(0);
  });

  it('rolls back code consumption and partial token writes after an unexpected issuance failure', async () => {
    const failingDb = new FailOnceAdapter(dbA, /INSERT INTO oauth_refresh_token/);
    const failingService = new McpOAuthService(
      failingDb,
      new TokenService(failingDb),
      new AgentService(failingDb),
    );

    await expect(exchange(failingService)).rejects.toThrow('injected failure');
    expect(await dbA.query('SELECT code_hash FROM oauth_authorization_code')).toHaveLength(1);
    expect(await dbA.query('SELECT id FROM api_token WHERE principal_id = ?', [agentId])).toHaveLength(0);
    expect(await dbA.query('SELECT token_hash FROM oauth_refresh_token')).toHaveLength(0);

    const retried = await exchange(oauthA);
    expect(retried.ok).toBe(true);
  });

  it('serializes concurrent refreshes and treats the loser as replay of the family', async () => {
    const issued = await exchange(oauthA);
    if (!issued.ok) throw new Error('OAuth setup failed');

    const results = await Promise.all([
      oauthA.refreshToken({ refreshToken: issued.refreshToken, clientId, resource: RESOURCE }),
      oauthB.refreshToken({ refreshToken: issued.refreshToken, clientId, resource: RESOURCE }),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.error === 'invalid_grant')).toHaveLength(1);
    const rows = await dbA.query<{ revoked: number }>('SELECT revoked FROM oauth_refresh_token');
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.revoked === 1)).toBe(true);
  });

  it('rolls back refresh claim, access revocation, and partial writes on unexpected failure', async () => {
    const issued = await exchange(oauthA);
    if (!issued.ok) throw new Error('OAuth setup failed');
    const tokenCountBefore = (await dbA.query('SELECT id FROM api_token')).length;
    const failingDb = new FailOnceAdapter(dbA, /INSERT INTO oauth_refresh_token/);
    const failingService = new McpOAuthService(
      failingDb,
      new TokenService(failingDb),
      new AgentService(failingDb),
    );

    await expect(failingService.refreshToken({
      refreshToken: issued.refreshToken,
      clientId,
      resource: RESOURCE,
    })).rejects.toThrow('injected failure');

    expect(await tokenA.verify(issued.token.token)).not.toBeNull();
    expect(await dbA.query<{ used: number; revoked: number }>(
      'SELECT used, revoked FROM oauth_refresh_token',
    )).toEqual([{ used: 0, revoked: 0 }]);
    expect(await dbA.query('SELECT id FROM api_token')).toHaveLength(tokenCountBefore);

    const retried = await oauthA.refreshToken({ refreshToken: issued.refreshToken, clientId, resource: RESOURCE });
    expect(retried.ok).toBe(true);
  });
});
