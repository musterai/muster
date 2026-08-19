// Route-level deployment tests. These deliberately use Muster's real OIDC
// callback, session persistence, auth middleware, and permission boundary so
// proxy assertions cannot pass merely because of an isolated Express probe.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { OidcService } from '../src/services/oidc.service.js';
import { SessionService } from '../src/services/session.service.js';
import { UserService } from '../src/services/user.service.js';
import { InvitationService } from '../src/services/invitation.service.js';
import { RoleService } from '../src/services/role.service.js';
import { AgentService } from '../src/services/agent.service.js';
import { TokenService } from '../src/services/token.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { createAuthRouter } from '../src/api/routes/auth.routes.js';
import { createAuthMiddleware } from '../src/api/middleware/auth.js';
import { permissionGuard } from '../src/api/middleware/permission-guard.js';
import { config } from '../src/config/index.js';
import { FakeOidcProvider } from './helpers/fake-oidc-provider.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-deployment-auth-proxy.db');

interface ListeningServer {
  server: ReturnType<typeof express.application.listen>;
  url: string;
}

async function listen(app: express.Express): Promise<ListeningServer> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: ListeningServer): Promise<void> {
  await new Promise<void>((resolve) => server.server.close(() => resolve()));
}

function sessionToken(setCookie: string | null): string | null {
  return setCookie?.match(/muster_session=([^;]+)/)?.[1] || null;
}

describe('MUS-72: proxied authentication routes', () => {
  let provider: FakeOidcProvider;
  let db: DatabaseAdapter;
  let roleService: RoleService;
  let oidcService: OidcService;
  let sessionService: SessionService;
  let userService: UserService;
  let invitationService: InvitationService;
  let auditService: AuditService;
  let tokenService: TokenService;
  let agentService: AgentService;
  let originalOidc: typeof config.oidc;
  let originalMode: typeof config.auth.mode;
  const servers: ListeningServer[] = [];

  beforeAll(async () => {
    provider = await FakeOidcProvider.start();
    originalOidc = { ...config.oidc };
    originalMode = config.auth.mode;
  });

  afterAll(async () => {
    await provider.stop();
    Object.assign(config.oidc, originalOidc);
    (config.auth as { mode: typeof config.auth.mode }).mode = originalMode;
  });

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();

    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['ws-deployment-proxy', 'Deployment Proxy Test', 'deployment-proxy-test', now, now],
    );

    roleService = new RoleService(db);
    await roleService.seedPreset('ws-deployment-proxy');
    oidcService = new OidcService(db);
    sessionService = new SessionService(db);
    userService = new UserService(db);
    invitationService = new InvitationService(db);
    auditService = new AuditService(db);
    tokenService = new TokenService(db);
    agentService = new AgentService(db);
    provider.overrideNonce = null;
    provider.useForeignKeyForNextToken = false;
  });

  afterEach(async () => {
    while (servers.length > 0) await close(servers.pop()!);
    if (db) await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* test cleanup */ }
    }
  });

  function configureRuntime(publicUrl: string, bootstrapSubject: string): void {
    (config.auth as { mode: typeof config.auth.mode }).mode = 'enforced';
    Object.assign(config.oidc, {
      issuer: provider.issuer,
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      publicUrl,
      bootstrapOwnerSubject: bootstrapSubject,
    });
  }

  function createMusterRouteApp(trustedProxies: string[]): express.Express {
    const app = express();
    app.set('trust proxy', trustedProxies);
    app.use(express.json());
    app.use(createAuthMiddleware(db, tokenService, roleService, agentService, sessionService));

    const v1 = express.Router();
    v1.use(permissionGuard);
    v1.use(createAuthRouter(
      db,
      oidcService,
      sessionService,
      userService,
      invitationService,
      roleService,
      auditService,
    ));
    app.use('/api/v1', v1);
    return app;
  }

  async function signIn(
    baseUrl: string,
    sub: string,
    callbackHeaders: HeadersInit = {},
  ): Promise<{ authorizationUrl: URL; callback: Response }> {
    provider.setNextIdentity(sub, `${sub}@example.test`);
    const login = await fetch(`${baseUrl}/api/v1/auth/login`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    const authorizationUrl = new URL(login.headers.get('location')!);
    const callbackUrl = provider.authorize(authorizationUrl.searchParams);
    const callback = await fetch(`${baseUrl}${callbackUrl.pathname}${callbackUrl.search}`, {
      redirect: 'manual',
      headers: callbackHeaders,
    });
    return { authorizationUrl, callback };
  }

  function createSanitizingProxy(upstreamUrl: string): express.Express {
    const proxy = express();
    proxy.use(async (req, res, next) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (name.toLowerCase().startsWith('x-forwarded-') || name === 'host' || typeof value !== 'string') continue;
          headers.set(name, value);
        }

        // This is the equivalent of the checked-in Caddy edge: do not append
        // a client-supplied chain; derive the only forwarding hop from the
        // peer connection and the proxy's TLS boundary.
        headers.set('x-forwarded-for', req.socket.remoteAddress?.replace(/^::ffff:/, '') || '127.0.0.1');
        headers.set('x-forwarded-proto', 'https');
        headers.set('x-forwarded-host', 'muster.test');
        headers.set('host', 'muster.test');

        const upstream = await fetch(`${upstreamUrl}${req.originalUrl}`, {
          method: req.method,
          headers,
          redirect: 'manual',
        });
        const setCookie = upstream.headers.get('set-cookie');
        for (const [name, value] of upstream.headers) {
          if (name !== 'set-cookie' && name !== 'transfer-encoding') res.setHeader(name, value);
        }
        if (setCookie) res.setHeader('set-cookie', setCookie);
        res.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        next(error);
      }
    });
    return proxy;
  }

  it('ignores direct spoofed forwarding headers on the real callback route', async () => {
    configureRuntime('http://muster.test', 'direct-owner');
    const backend = await listen(createMusterRouteApp([]));
    servers.push(backend);

    const { callback } = await signIn(backend.url, 'direct-owner', {
      'X-Forwarded-For': '198.51.100.44',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'attacker.example',
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('set-cookie')).not.toContain('Secure');
    const sessions = await db.query<{ ip: string | null }>('SELECT ip FROM session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ip).not.toBe('198.51.100.44');
  });

  it('accepts only the proxy-generated headers for secure cookies and client IP on the real callback route', async () => {
    configureRuntime('http://muster.test', 'proxied-owner');
    const backend = await listen(createMusterRouteApp(['127.0.0.1']));
    servers.push(backend);
    const proxy = await listen(createSanitizingProxy(backend.url));
    servers.push(proxy);

    const { callback } = await signIn(proxy.url, 'proxied-owner', {
      'X-Forwarded-For': '198.51.100.44',
      'X-Forwarded-Proto': 'http',
      'X-Forwarded-Host': 'attacker.example',
    });

    expect(callback.status).toBe(302);
    const cookie = callback.headers.get('set-cookie');
    expect(cookie).toContain('Secure');
    expect(sessionToken(cookie)).toBeTruthy();

    const sessions = await db.query<{ ip: string | null }>('SELECT ip FROM session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ip).toBe('127.0.0.1');
    expect(sessions[0].ip).not.toBe('198.51.100.44');
  });

  it('uses the configured public HTTPS origin rather than forwarded host input for the login redirect URI', async () => {
    configureRuntime('https://muster.example.test', 'origin-owner');
    const backend = await listen(createMusterRouteApp([]));
    servers.push(backend);

    const login = await fetch(`${backend.url}/api/v1/auth/login`, {
      redirect: 'manual',
      headers: {
        Host: 'attacker.example',
        'X-Forwarded-Host': 'attacker.example',
      },
    });
    expect(login.status).toBe(302);
    const authorization = new URL(login.headers.get('location')!);
    expect(authorization.searchParams.get('redirect_uri'))
      .toBe('https://muster.example.test/api/v1/auth/callback');
  });
});
