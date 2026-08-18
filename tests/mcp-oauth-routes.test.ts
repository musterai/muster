// File: tests/mcp-oauth-routes.test.ts
//
// MUS-29 acceptance criteria (HTTP-level):
// - GET /.well-known/oauth-protected-resource and
//   /.well-known/oauth-authorization-server advertise the right endpoints
// - an unauthenticated request to /mcp returns 401 with a WWW-Authenticate
//   header naming the resource metadata URL
// - the full register -> authorize -> consent -> token HTTP round-trip
//   produces a token that authenticates against a real protected route

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { TokenService } from '../src/services/token.service.js';
import { AgentService } from '../src/services/agent.service.js';
import { RoleService } from '../src/services/role.service.js';
import { SessionService } from '../src/services/session.service.js';
import { McpOAuthService } from '../src/services/mcp-oauth.service.js';
import { DeviceGrantService } from '../src/services/device-grant.service.js';
import { createAuthMiddleware } from '../src/api/middleware/auth.js';
import { createDeviceRouter } from '../src/api/routes/device.routes.js';
import { createMcpOAuthRouter, createWellKnownRouter } from '../src/api/routes/mcp-oauth.routes.js';
import { config } from '../src/config/index.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-mcp-oauth-routes.db');
const REDIRECT_URI = 'http://127.0.0.1:5555/callback';

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof express.application.listen>; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('MUS-29: MCP OAuth over real HTTP', () => {
  let db: DatabaseAdapter;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let approverToken = '';
  let originalPublicUrl: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    const wsId = 'ws-mcp-oauth-routes';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [wsId, 'WS', 'ws-mcp-r', now, now]);

    const roleService = new RoleService(db);
    const roles = await roleService.seedPreset(wsId);
    const ownerRole = roles.find(r => r.key === 'owner')!;

    const approverId = 'approver-http-1';
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [approverId, 'user', now]);
    await db.execute('INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)', [approverId, 'Approver', 'active', now]);
    await db.execute('INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)', [wsId, approverId, ownerRole.id, now]);

    const tokenService = new TokenService(db);
    const agentService = new AgentService(db);
    const sessionService = new SessionService(db);
    const deviceGrantService = new DeviceGrantService(db, tokenService);
    const oauthService = new McpOAuthService(db, tokenService, agentService);

    // The approver authenticates the same way any REST client does — a bearer PAT.
    const approverCreated = await tokenService.create({ principal_id: approverId, workspace_id: wsId, name: 'approver-http-pat' });
    approverToken = approverCreated.token;

    const authMiddleware = createAuthMiddleware(db, tokenService, roleService, agentService, sessionService);

    const app = express();
    app.use(express.json());
    app.use(createWellKnownRouter());
    // Mirrors server.ts's real scoping: auth only for /api and /mcp.
    app.use((req, res, next) => {
      if (!req.path.startsWith('/api/') && req.path !== '/mcp') { next(); return; }
      authMiddleware(req, res, next);
    });
    const v1 = express.Router();
    v1.use(createDeviceRouter(db, deviceGrantService, oauthService));
    v1.use(createMcpOAuthRouter(db, oauthService, agentService, roleService));
    v1.get('/agents', (req: any, res) => res.json({ authenticated_as: req.authContext?.principal || null }));
    app.use('/api/v1', v1);
    // Stand-in for the real /mcp handler — the behavior under test (401 +
    // WWW-Authenticate) happens entirely in authMiddleware before this runs.
    app.post('/mcp', (req: any, res) => res.json({ authenticated_as: req.authContext?.principal || null }));

    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;

    originalPublicUrl = config.oidc.publicUrl;
    (config.oidc as any).publicUrl = baseUrl;
    (config.auth as any).mode = 'enforced';
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (db) await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* ok */ }
    }
    (config.oidc as any).publicUrl = originalPublicUrl;
    (config.auth as any).mode = 'open';
  });

  it('advertises protected resource and authorization server metadata', async () => {
    const prm = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`).then(r => r.json());
    expect(prm.resource).toBe(`${baseUrl}/mcp`);
    expect(prm.authorization_servers).toEqual([baseUrl]);

    const asMeta = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`).then(r => r.json());
    expect(asMeta.issuer).toBe(baseUrl);
    expect(asMeta.authorization_endpoint).toBe(`${baseUrl}/api/v1/oauth/authorize`);
    expect(asMeta.token_endpoint).toBe(`${baseUrl}/api/v1/oauth/token`);
    expect(asMeta.registration_endpoint).toBe(`${baseUrl}/api/v1/oauth/register`);
    expect(asMeta.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('an unauthenticated /mcp request gets 401 with a WWW-Authenticate header naming the resource metadata URL', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate');
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
  });

  it('an /mcp request with a valid access token from the full OAuth flow succeeds', async () => {
    const resource = `${baseUrl}/mcp`;
    // 1. Dynamic client registration.
    const registerRes = await fetch(`${baseUrl}/api/v1/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test MCP Client', redirect_uris: [REDIRECT_URI] }),
    });
    expect(registerRes.status).toBe(201);
    const client = await registerRes.json();
    expect(client.client_id).toBeTruthy();

    // 2. Authorize hand-off — unauthenticated GET still succeeds since it
    //    only validates client/redirect_uri and never checks a session.
    const { verifier, challenge } = pkcePair();
    const authorizeQs = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
      state: 'xyz',
    });
    const authorizeRes = await fetch(`${baseUrl}/api/v1/oauth/authorize?${authorizeQs.toString()}`, { redirect: 'manual' });
    expect(authorizeRes.status).toBe(302);
    expect(authorizeRes.headers.get('location')).toContain('/mcp/authorize?');

    // 3. Consent — as the signed-in approver (bearer PAT, same as any REST call).
    const consentRes = await fetch(`${baseUrl}/api/v1/oauth/authorize/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${approverToken}` },
      body: JSON.stringify({
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource,
        state: 'xyz',
        decision: 'approve',
        new_agent_name: 'Claude via MCP',
        role_id: (await (await fetch(`${baseUrl}/api/v1/oauth/authorize/details?client_id=${client.client_id}`, {
          headers: { Authorization: `Bearer ${approverToken}` },
        })).json()).roles[0].id,
      }),
    });
    expect(consentRes.status).toBe(200);
    const { redirect_uri } = await consentRes.json();
    const redirectUrl = new URL(redirect_uri);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(REDIRECT_URI);
    const code = redirectUrl.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get('state')).toBe('xyz');
    expect(redirectUrl.searchParams.get('iss')).toBe(baseUrl);

    // 4. Token exchange.
    const tokenRes = await fetch(`${baseUrl}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        resource,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json();
    expect(tokenBody.access_token.startsWith('muster_pat_')).toBe(true);
    expect(tokenBody.refresh_token).toBeTruthy();

    // 5. The issued token authenticates against /mcp, and the principal
    //    behind it is an agent — never the approving user's own session.
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenBody.access_token}` },
      body: '{}',
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = await mcpRes.json();
    expect(mcpBody.authenticated_as.kind).toBe('agent');
  });

  it('rejects an authorize request with an unregistered redirect_uri without redirecting anywhere', async () => {
    const resource = `${baseUrl}/mcp`;
    const registerRes = await fetch(`${baseUrl}/api/v1/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [REDIRECT_URI] }),
    });
    const client = await registerRes.json();

    const { challenge } = pkcePair();
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://evil.example.com/steal',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
    });
    const res = await fetch(`${baseUrl}/api/v1/oauth/authorize?${qs.toString()}`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('preserves registered redirect query parameters when returning consent errors', async () => {
    const redirectUri = 'http://127.0.0.1:5555/callback?channel=stable';
    const registerRes = await fetch(`${baseUrl}/api/v1/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Query Client', redirect_uris: [redirectUri] }),
    });
    const client = await registerRes.json();
    const response = await fetch(`${baseUrl}/api/v1/oauth/authorize/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${approverToken}` },
      body: JSON.stringify({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        resource: `${baseUrl}/mcp`,
        state: 'state-value',
        decision: 'deny',
      }),
    });
    expect(response.status).toBe(200);
    const location = new URL((await response.json()).redirect_uri);
    expect(location.searchParams.get('channel')).toBe('stable');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('state-value');
    expect(location.search).not.toContain('stable?error');
  });
});
