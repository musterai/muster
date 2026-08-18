import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { TokenService } from '../src/services/token.service.js';
import { RoleService } from '../src/services/role.service.js';
import { AgentService } from '../src/services/agent.service.js';
import { SessionService } from '../src/services/session.service.js';
import { createAuthMiddleware } from '../src/api/middleware/auth.js';
import { permissionGuard } from '../src/api/middleware/permission-guard.js';
import { config } from '../src/config/index.js';
import { PUBLIC_ROUTE_INVENTORY } from '../src/shared/public-routes.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-public-route-http.db');

describe('MUS-58: enforced public-route boundary (HTTP)', () => {
  let db: DatabaseAdapter;
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;
  let priorMode: typeof config.auth.mode;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();

    const tokenService = new TokenService(db);
    const roleService = new RoleService(db);
    const agentService = new AgentService(db);
    const sessionService = new SessionService(db);
    const app = express();
    app.use(express.json());
    app.use(createAuthMiddleware(db, tokenService, roleService, agentService, sessionService));
    app.use(permissionGuard);

    // Stub each exact public handler so this test exercises the enforced
    // middleware boundary for the complete inventory without coupling it to
    // the implementation details of every protocol service.
    for (const route of PUBLIC_ROUTE_INVENTORY) {
      const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      app[method](route.path, (_req, res) => res.status(204).end());
    }

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    priorMode = config.auth.mode;
    (config.auth as any).mode = 'enforced';
  });

  afterEach(async () => {
    (config.auth as any).mode = priorMode;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* test cleanup */ }
    }
  });

  it('allows every exact inventory route without an anonymous credential', async () => {
    for (const route of PUBLIC_ROUTE_INVENTORY) {
      const response = await fetch(`${baseUrl}${route.path}`, { method: route.method });
      expect(response.status, `${route.method} ${route.path}`).toBe(204);
    }
  });

  it('keeps near-miss routes protected in enforced mode', async () => {
    const response = await fetch(`${baseUrl}/api/v1/auth/login/extra`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized', message: 'Authentication required.' });
  });
});
