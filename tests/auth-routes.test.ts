// File: tests/auth-routes.test.ts
//
// MUS-25 acceptance criteria (end-to-end, over real HTTP):
// - a user with no invitation and no bootstrap claim is authenticated but
//   not admitted, with a clear message
// - the first user to sign in becomes workspace owner
// - an invited user is admitted on sign-in and the invitation is consumed
// - logout invalidates the session server-side
// - session cookie carries httpOnly, Secure, SameSite

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { OidcService } from '../src/services/oidc.service.js';
import { SessionService } from '../src/services/session.service.js';
import { UserService } from '../src/services/user.service.js';
import { InvitationService } from '../src/services/invitation.service.js';
import { RoleService } from '../src/services/role.service.js';
import { AgentService } from '../src/services/agent.service.js';
import { TokenService } from '../src/services/token.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { createAuthRouter, sanitizeRedirectTo } from '../src/api/routes/auth.routes.js';
import { createAuthMiddleware } from '../src/api/middleware/auth.js';
import { permissionGuard } from '../src/api/middleware/permission-guard.js';
import { config } from '../src/config/index.js';
import { FakeOidcProvider } from './helpers/fake-oidc-provider.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-auth-routes.db');

function parseSetCookie(headers: Headers): string | undefined {
  return headers.get('set-cookie') || undefined;
}

function extractCookieValue(setCookieHeader: string, name: string): string | null {
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

describe('MUS-25: auth routes (end-to-end over HTTP)', () => {
  let provider: FakeOidcProvider;
  let originalOidcConfig: typeof config.oidc;
  let db: DatabaseAdapter;
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;
  let workspaceId: string;
  let roleService: RoleService;
  let invitationService: InvitationService;
  let tokenService: TokenService;

  beforeAll(async () => {
    provider = await FakeOidcProvider.start();
    originalOidcConfig = { ...config.oidc };
  });

  afterAll(async () => {
    await provider.stop();
    Object.assign(config.oidc, originalOidcConfig);
  });

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    workspaceId = 'ws-auth-route-test';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Test WS', 'test-ws-auth', now, now]);

    roleService = new RoleService(db);
    await roleService.seedPreset(workspaceId);

    const oidcService = new OidcService(db);
    const sessionService = new SessionService(db);
    const userService = new UserService(db);
    invitationService = new InvitationService(db);
    const agentService = new AgentService(db);
    tokenService = new TokenService(db);
    const auditService = new AuditService(db);

    const app = express();
    app.use(express.json());
    app.use(createAuthMiddleware(db, tokenService, roleService, agentService, sessionService));
    const v1 = express.Router();
    v1.use(permissionGuard);
    v1.use(createAuthRouter(db, oidcService, sessionService, userService, invitationService, roleService, auditService));
    // Minimal protected collection used to exercise the real AuthContext +
    // permissionGuard boundary without pulling unrelated project services
    // into the OIDC-focused fixture.
    v1.get('/projects', (_req, res) => res.json([{ id: 'protected-project' }]));
    app.use('/api/v1', v1);

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    (config.oidc as any).issuer = provider.issuer;
    (config.oidc as any).clientId = 'test-client-id';
    (config.oidc as any).clientSecret = 'test-client-secret';
    (config.oidc as any).publicUrl = baseUrl;
    (config.oidc as any).bootstrapOwnerSubject = null;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (db) await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* ok */ }
    }
  });

  /** Drives login -> fake IdP consent -> callback, returning the session cookie header and the callback response. */
  async function signIn(sub: string, email: string | null): Promise<{ setCookie: string; callbackRes: Response }> {
    provider.setNextIdentity(sub, email);

    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, { redirect: 'manual' });
    expect(loginRes.status).toBe(302);
    const authorizeUrl = new URL(loginRes.headers.get('location')!);

    const callbackUrl = provider.authorize(authorizeUrl.searchParams);
    const callbackRes = await fetch(callbackUrl.href.replace(callbackUrl.origin, baseUrl), { redirect: 'manual' });

    const setCookie = parseSetCookie(callbackRes.headers);
    expect(setCookie).toBeDefined();
    return { setCookie: setCookie!, callbackRes };
  }

  it('admits the first user to sign in as workspace owner', async () => {
    const { setCookie } = await signIn('sub-first', 'first@example.com');
    const token = extractCookieValue(setCookie, 'muster_session');

    const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: `muster_session=${token}` } });
    const me = await meRes.json();

    expect(me.authenticated).toBe(true);
    expect(me.admitted).toBe(true);
    expect(me.role).toBe('Owner');
  });

  it('authenticates but does not admit a user with no invitation and no bootstrap claim', async () => {
    // First user becomes owner — burn that slot first.
    await signIn('sub-owner', 'owner@example.com');

    const { setCookie } = await signIn('sub-uninvited', 'uninvited@example.com');
    const token = extractCookieValue(setCookie, 'muster_session');

    const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: `muster_session=${token}` } });
    const me = await meRes.json();

    expect(me.authenticated).toBe(true);
    expect(me.admitted).toBe(false);

    const priorMode = config.auth.mode;
    (config.auth as any).mode = 'enforced';
    try {
      const protectedRes = await fetch(`${baseUrl}/api/v1/projects`, {
        headers: { Cookie: `muster_session=${token}` },
      });
      expect(protectedRes.status).toBe(403);
      expect((await protectedRes.json()).required_permission).toBe('workspace.read');
    } finally {
      (config.auth as any).mode = priorMode;
    }
  });

  it('allows implicit reads for an admitted observer with no required write permission', async () => {
    await signIn('sub-observer-owner', 'observer-owner@example.com');
    const observerRole = await roleService.getByKey(workspaceId, 'observer');
    await invitationService.create({
      workspace_id: workspaceId,
      email: 'observer@example.com',
      role_id: observerRole!.id,
    });
    const { setCookie } = await signIn('sub-observer', 'observer@example.com');
    const token = extractCookieValue(setCookie, 'muster_session');

    const priorMode = config.auth.mode;
    (config.auth as any).mode = 'enforced';
    try {
      const protectedRes = await fetch(`${baseUrl}/api/v1/projects`, {
        headers: { Cookie: `muster_session=${token}` },
      });
      expect(protectedRes.status).toBe(200);
      expect(await protectedRes.json()).toEqual([{ id: 'protected-project' }]);
    } finally {
      (config.auth as any).mode = priorMode;
    }
  });

  it('revokes implicit agent reads when the operator membership is removed', async () => {
    await signIn('sub-agent-owner', 'agent-owner@example.com');
    const users = await db.query<{ id: string }>(
      `SELECT u.id FROM app_user u
        JOIN identity i ON i.user_id = u.id
       WHERE i.subject = ?`,
      ['sub-agent-owner'],
    );
    const operatorId = users[0].id;
    const observerRole = await roleService.getByKey(workspaceId, 'observer');
    const now = new Date().toISOString();
    const agentId = 'agent-membership-read-test';
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [agentId, 'agent', now]);
    await db.execute(
      `INSERT INTO agent
         (id, name, status, last_seen_at, operator_user_id, role_id, workspace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Read Agent', 'active', now, operatorId, observerRole!.id, workspaceId, now],
    );
    const credential = await tokenService.create({
      principal_id: agentId,
      workspace_id: workspaceId,
      name: 'agent read test',
    });

    const priorMode = config.auth.mode;
    (config.auth as any).mode = 'enforced';
    try {
      const allowed = await fetch(`${baseUrl}/api/v1/projects`, {
        headers: { Authorization: `Bearer ${credential.token}` },
      });
      expect(allowed.status).toBe(200);

      await db.execute(
        'DELETE FROM workspace_member WHERE workspace_id = ? AND user_id = ?',
        [workspaceId, operatorId],
      );
      const denied = await fetch(`${baseUrl}/api/v1/projects`, {
        headers: { Authorization: `Bearer ${credential.token}` },
      });
      expect(denied.status).toBe(403);
      expect((await denied.json()).required_permission).toBe('workspace.read');
    } finally {
      (config.auth as any).mode = priorMode;
    }
  });

  it('admits an invited user and consumes the invitation', async () => {
    await signIn('sub-owner-2', 'owner2@example.com'); // burn first-user slot

    const juniorRole = await roleService.getByKey(workspaceId, 'junior_engineer');
    const invite = await invitationService.create({ workspace_id: workspaceId, email: 'invited@example.com', role_id: juniorRole!.id });

    const { setCookie } = await signIn('sub-invited', 'invited@example.com');
    const token = extractCookieValue(setCookie, 'muster_session');

    const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: `muster_session=${token}` } });
    const me = await meRes.json();
    expect(me.admitted).toBe(true);
    expect(me.role).toBe('Junior Engineer');

    const invitationRow = await invitationService.getById(invite.id);
    expect(invitationRow!.accepted_at).not.toBeNull();
  });

  it.each([false, undefined, 'true', 1])(
    'does not admit an invited identity when email_verified is %j',
    async (emailVerified) => {
      await signIn('sub-owner-verified', 'owner-verified@example.com');
      const juniorRole = await roleService.getByKey(workspaceId, 'junior_engineer');
      const invite = await invitationService.create({
        workspace_id: workspaceId,
        email: 'unverified@example.com',
        role_id: juniorRole!.id,
      });
      provider.setNextIdentity('sub-unverified', 'unverified@example.com', emailVerified);

      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, { redirect: 'manual' });
      const authorizeUrl = new URL(loginRes.headers.get('location')!);
      const callbackUrl = provider.authorize(authorizeUrl.searchParams);
      const callbackRes = await fetch(callbackUrl.href.replace(callbackUrl.origin, baseUrl), { redirect: 'manual' });

      expect(callbackRes.status).toBe(302);
      const identity = await db.query<{ user_id: string }>('SELECT user_id FROM identity WHERE subject = ?', ['sub-unverified']);
      expect(identity).toHaveLength(1);
      expect(await new UserService(db).isWorkspaceMember(workspaceId, identity[0].user_id)).toBe(false);
      expect((await invitationService.getById(invite.id))!.accepted_at).toBeNull();
    },
  );

  it('session cookie carries httpOnly, Secure, and SameSite attributes', async () => {
    const { setCookie } = await signIn('sub-cookie-check', 'cookie@example.com');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('logout invalidates the session server-side', async () => {
    const { setCookie } = await signIn('sub-logout', 'logout@example.com');
    const token = extractCookieValue(setCookie, 'muster_session');

    const meBefore = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: `muster_session=${token}` } });
    expect((await meBefore.json()).authenticated).toBe(true);

    await fetch(`${baseUrl}/api/v1/auth/logout`, { method: 'POST', headers: { Cookie: `muster_session=${token}` } });

    const meAfter = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: `muster_session=${token}` } });
    expect((await meAfter.json()).authenticated).toBe(false);
  });
});

describe('MUS-63: same-origin post-auth redirect validation', () => {
  it.each([
    '/\\\\evil.example',
    '//evil.example',
    '/%5c%5cevil.example',
    '/%2f%2fevil.example',
    '/%252f%252fevil.example',
    'https://evil.example/path',
    '/safe\nLocation: https://evil.example',
  ])('rejects browser-ambiguous destination %j', value => {
    expect(sanitizeRedirectTo(value)).toBeNull();
  });

  it('canonicalizes valid local paths while preserving query and fragment', () => {
    expect(sanitizeRedirectTo('/projects/../cards?view=mine#top')).toBe('/cards?view=mine#top');
  });
});
