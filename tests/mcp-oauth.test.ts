// File: tests/mcp-oauth.test.ts
//
// MUS-29 acceptance criteria:
// - dynamic client registration issues credentials and the full code
//   exchange succeeds
// - the issued token's principal is an agent, not the approving user, and
//   its permissions are the intersected set
// - a replayed refresh token revokes the token family
// - an authorization code cannot be exchanged twice
// - redirect_uri validation (exact match; loopback port-flexible per RFC 8252)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { TokenService } from '../src/services/token.service.js';
import { AgentService } from '../src/services/agent.service.js';
import { RoleService } from '../src/services/role.service.js';
import { McpOAuthService, isSecureOAuthRedirectUri, redirectUriMatches, verifyPkce } from '../src/services/mcp-oauth.service.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-mcp-oauth.db');
const RESOURCE = 'https://muster.example.com/mcp';

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('MUS-29: McpOAuthService', () => {
  let db: DatabaseAdapter;
  let tokenService: TokenService;
  let agentService: AgentService;
  let roleService: RoleService;
  let oauthService: McpOAuthService;
  let wsId: string;
  let approverId: string;
  let seniorRoleId: string;
  let observerRoleId: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    wsId = 'ws-mcp-oauth';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [wsId, 'WS', 'ws-mcp-oauth', now, now]);

    roleService = new RoleService(db);
    const roles = await roleService.seedPreset(wsId);
    seniorRoleId = roles.find(r => r.key === 'senior_engineer')!.id;
    observerRoleId = roles.find(r => r.key === 'observer')!.id;

    approverId = 'approver-1';
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [approverId, 'user', now]);
    await db.execute('INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)', [approverId, 'Approver', 'active', now]);
    await db.execute('INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)', [wsId, approverId, seniorRoleId, now]);

    tokenService = new TokenService(db);
    agentService = new AgentService(db);
    oauthService = createMcpOAuthServiceForTest(db, tokenService, agentService);
  });

  afterEach(async () => {
    if (db) await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* ok */ }
    }
  });

  async function registerAgentAndCode(roleId: string, redirectUri = 'http://127.0.0.1:5555/callback') {
    const client = await oauthService.registerClient({ client_name: 'Test Client', redirect_uris: [redirectUri] });
    const agent = await agentService.register({ name: 'Claude via MCP' }, approverId, roleId);
    const { verifier, challenge } = pkcePair();
    const code = await oauthService.createAuthorizationCode({
      clientId: client.client_id,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      resource: RESOURCE,
      agentPrincipalId: agent.id,
      operatorUserId: approverId,
      workspaceId: wsId,
    });
    return { client, agent, code, verifier, redirectUri };
  }

  it('registers a client and issues credentials', async () => {
    const client = await oauthService.registerClient({ client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:4200/callback'] });
    expect(client.client_id).toMatch(/^mcp_/);
    expect(client.redirect_uris).toEqual(['http://127.0.0.1:4200/callback']);
    expect(client.token_endpoint_auth_method).toBe('none');

    const fetched = await oauthService.getClient(client.client_id);
    expect(fetched?.client_id).toBe(client.client_id);
  });

  it('registration rejects an empty or malformed redirect_uris list', async () => {
    await expect(oauthService.registerClient({ redirect_uris: [] })).rejects.toThrow();
    await expect(oauthService.registerClient({ redirect_uris: ['not-a-url'] })).rejects.toThrow();
  });

  it.each([
    'http://remote.example/callback',
    'http://localhost:5555/callback',
    'https://user:password@example.com/callback',
    'https://example.com/callback#fragment',
    'custom-scheme:/callback',
  ])('registration rejects unsafe redirect URI %s', async redirectUri => {
    await expect(oauthService.registerClient({ redirect_uris: [redirectUri] })).rejects.toThrow('Invalid redirect_uri');
  });

  it('registration validates duplicates and declared grant/response metadata', async () => {
    await expect(oauthService.registerClient({
      redirect_uris: ['https://client.example/callback', 'https://client.example/callback'],
    })).rejects.toThrow('duplicates');
    await expect(oauthService.registerClient({
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['client_credentials'],
    })).rejects.toThrow('grant_types');
    await expect(oauthService.registerClient({
      redirect_uris: ['https://client.example/callback'],
      response_types: ['token'],
    })).rejects.toThrow('response_types');

    const client = await oauthService.registerClient({
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(client.redirect_uris).toEqual(['https://client.example/callback']);
  });

  it('completes the full code exchange end-to-end', async () => {
    const { client, agent, code, verifier, redirectUri } = await registerAgentAndCode(seniorRoleId);

    const result = await oauthService.exchangeAuthorizationCode({
      code, clientId: client.client_id, redirectUri, codeVerifier: verifier, resource: RESOURCE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.token.startsWith('muster_pat_')).toBe(true);
      expect(result.refreshToken).toBeTruthy();

      // The issued token's principal is the AGENT, never the approving user.
      const verified = await tokenService.verify(result.token.token);
      expect(verified?.principal_id).toBe(agent.id);
      expect(verified?.principal_id).not.toBe(approverId);
    }
  });

  it("the agent's effective permissions are intersected with the operator's — never exceed the human who runs it", async () => {
    // Approver holds senior_engineer; agent is registered under observer.
    const { client, agent, code, verifier, redirectUri } = await registerAgentAndCode(observerRoleId);
    await oauthService.exchangeAuthorizationCode({ code, clientId: client.client_id, redirectUri, codeVerifier: verifier, resource: RESOURCE });

    const effective = await roleService.getEffectivePermissions(agent.id);
    const observerRole = await roleService.getById(observerRoleId);
    // observer's permissions are a strict subset of senior_engineer's, so
    // the intersection equals the (already narrower) agent role exactly —
    // this is the "no reduction visible" case; the reduction case is
    // covered by role.test.ts's existing intersection test.
    expect(effective.sort()).toEqual(observerRole!.permissions.sort());
  });

  it('an authorization code cannot be exchanged twice', async () => {
    const { client, code, verifier, redirectUri } = await registerAgentAndCode(seniorRoleId);

    const first = await oauthService.exchangeAuthorizationCode({ code, clientId: client.client_id, redirectUri, codeVerifier: verifier, resource: RESOURCE });
    expect(first.ok).toBe(true);

    const second = await oauthService.exchangeAuthorizationCode({ code, clientId: client.client_id, redirectUri, codeVerifier: verifier, resource: RESOURCE });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('invalid_grant');
  });

  it('rejects a code exchange with the wrong PKCE verifier', async () => {
    const { client, code, redirectUri } = await registerAgentAndCode(seniorRoleId);
    const result = await oauthService.exchangeAuthorizationCode({
      code, clientId: client.client_id, redirectUri, codeVerifier: 'wrong-verifier', resource: RESOURCE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_grant');
  });

  it('rejects a code exchange against a mismatched resource', async () => {
    const { client, code, verifier, redirectUri } = await registerAgentAndCode(seniorRoleId);
    const result = await oauthService.exchangeAuthorizationCode({
      code, clientId: client.client_id, redirectUri, codeVerifier: verifier, resource: 'https://someone-else.example.com/mcp',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_target');
  });

  it('a replayed (already-rotated) refresh token revokes the whole family', async () => {
    const { client, code, verifier, redirectUri } = await registerAgentAndCode(seniorRoleId);
    const issued = await oauthService.exchangeAuthorizationCode({ code, clientId: client.client_id, redirectUri, codeVerifier: verifier, resource: RESOURCE });
    if (!issued.ok) throw new Error('setup failed');

    // Normal rotation: refreshing once succeeds and yields a new access + refresh token.
    const rotated = await oauthService.refreshToken({ refreshToken: issued.refreshToken, clientId: client.client_id, resource: RESOURCE });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error('rotation failed');

    // The rotated-away access token is no longer valid.
    expect(await tokenService.verify(issued.token.token)).toBeNull();
    // The new one is.
    expect(await tokenService.verify(rotated.token.token)).not.toBeNull();

    // Replaying the OLD (already-used) refresh token is theft-signal — it
    // must revoke the family, including the currently-active access token.
    const replay = await oauthService.refreshToken({ refreshToken: issued.refreshToken, clientId: client.client_id, resource: RESOURCE });
    expect(replay.ok).toBe(false);
    expect(await tokenService.verify(rotated.token.token)).toBeNull();

    // And the new refresh token from the rotation is also dead now.
    const afterRevocation = await oauthService.refreshToken({ refreshToken: rotated.refreshToken, clientId: client.client_id, resource: RESOURCE });
    expect(afterRevocation.ok).toBe(false);
  });
});

describe('MUS-29: redirect_uri validation (RFC 8252 loopback flexibility)', () => {
  it('exact non-loopback URIs must match exactly', () => {
    expect(redirectUriMatches('https://app.example.com/callback', 'https://app.example.com/callback')).toBe(true);
    expect(redirectUriMatches('https://app.example.com/callback', 'https://app.example.com/other')).toBe(false);
    expect(redirectUriMatches('https://app.example.com/callback', 'https://evil.com/callback')).toBe(false);
  });

  it('loopback redirect URIs may vary in port even if not pre-registered with that exact port', () => {
    expect(redirectUriMatches('http://127.0.0.1:5555/callback', 'http://127.0.0.1:63412/callback')).toBe(true);
    expect(redirectUriMatches('http://[::1]:5555/callback', 'http://[::1]:9999/callback')).toBe(true);
  });

  it('loopback flexibility does not relax the path or scheme', () => {
    expect(redirectUriMatches('http://127.0.0.1:5555/callback', 'http://127.0.0.1:9999/other')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1:5555/callback', 'https://127.0.0.1:5555/callback')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1:5555/callback', 'http://127.0.0.2:5555/callback')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1:5555/callback', 'http://[::1]:5555/callback')).toBe(false);
  });

  it('a loopback registration cannot be satisfied by a non-loopback request', () => {
    expect(redirectUriMatches('http://127.0.0.1:5555/callback', 'http://evil.com:5555/callback')).toBe(false);
  });
});

describe('MUS-63: OAuth redirect transport validation', () => {
  it('allows HTTPS and literal loopback HTTP only', () => {
    expect(isSecureOAuthRedirectUri('https://client.example/callback')).toBe(true);
    expect(isSecureOAuthRedirectUri('http://127.0.0.1:49152/callback')).toBe(true);
    expect(isSecureOAuthRedirectUri('http://[::1]:49152/callback')).toBe(true);
    expect(isSecureOAuthRedirectUri('http://localhost:49152/callback')).toBe(false);
    expect(isSecureOAuthRedirectUri('http://client.example/callback')).toBe(false);
  });
});

describe('MUS-29: PKCE S256 verification', () => {
  it('accepts a correctly derived verifier/challenge pair', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it('rejects a mismatched pair', () => {
    const { challenge } = pkcePair();
    expect(verifyPkce('some-other-verifier', challenge)).toBe(false);
  });
});
import { createMcpOAuthServiceForTest } from './support/transaction-services.js';
