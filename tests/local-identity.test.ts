import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { Migrator } from '../src/db/migrator.js';
import { createAuthMiddleware } from '../src/api/middleware/auth.js';
import { errorHandler } from '../src/api/middleware/error-handler.js';
import { permissionGuard } from '../src/api/middleware/permission-guard.js';
import { createAuthRouter } from '../src/api/routes/auth.routes.js';
import { config } from '../src/config/index.js';
import { AgentService } from '../src/services/agent.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { InvitationService } from '../src/services/invitation.service.js';
import { OidcService } from '../src/services/oidc.service.js';
import { RoleService } from '../src/services/role.service.js';
import { SessionService } from '../src/services/session.service.js';
import { TokenService } from '../src/services/token.service.js';
import { UserService } from '../src/services/user.service.js';

describe('MUS-81: atomic first-use local identity', () => {
  let tempDir: string;
  let db: DatabaseAdapter;
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;
  let workspaceId: string;
  let userService: UserService;
  let auditService: AuditService;
  let originalMode: typeof config.auth.mode;

  beforeEach(async () => {
    originalMode = config.auth.mode;
    (config.auth as { mode: string }).mode = 'open';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-local-identity-'));
    db = createDatabaseAdapter(path.join(tempDir, 'muster.db'));
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();

    workspaceId = 'local-identity-workspace';
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Local Identity', 'local-identity', now, now],
    );
    const roleService = new RoleService(db);
    await roleService.seedPreset(workspaceId);
    const sessionService = new SessionService(db);
    userService = new UserService(db);
    auditService = new AuditService(db);

    const app = express();
    app.use(express.json());
    app.use(createAuthMiddleware(db, new TokenService(db), roleService, new AgentService(db), sessionService));
    const v1 = express.Router();
    v1.use(permissionGuard);
    v1.use(createAuthRouter(
      db,
      new OidcService(db),
      sessionService,
      userService,
      new InvitationService(db),
      roleService,
      auditService,
    ));
    app.use('/api/v1', v1);
    app.use((err: Error, req: Request, res: Response, next: NextFunction) => errorHandler(err, req, res, next));

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  afterEach(async () => {
    (config.auth as { mode: string }).mode = originalMode;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function localIdentity(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/auth/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const rows = await db.query<{ count: number }>(sql, params);
    return Number(rows[0]?.count || 0);
  }

  it('creates, admits, audits, and binds a new valid display name in one request', async () => {
    const response = await localIdentity({ display_name: 'First Local Operator' });
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toMatch(/muster_session=[^;]+;.*HttpOnly.*SameSite=Lax/i);
    const { user } = await response.json() as { user: { id: string; display_name: string } };
    expect(user.display_name).toBe('First Local Operator');

    expect(await count('SELECT COUNT(*) AS count FROM principal WHERE id = ? AND kind = ?', [user.id, 'user'])).toBe(1);
    expect(await count('SELECT COUNT(*) AS count FROM app_user WHERE id = ?', [user.id])).toBe(1);
    expect(await count('SELECT COUNT(*) AS count FROM workspace_member WHERE workspace_id = ? AND user_id = ?', [workspaceId, user.id])).toBe(1);
    expect(await count('SELECT COUNT(*) AS count FROM session WHERE user_id = ?', [user.id])).toBe(1);
    expect(await count("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ? AND action = 'user.local_identity_create'", [user.id])).toBe(1);

    const owner = await db.query<{ role_key: string }>(
      `SELECT r.key AS role_key FROM workspace_member wm
       JOIN role r ON r.id = wm.role_id
       WHERE wm.workspace_id = ? AND wm.user_id = ?`,
      [workspaceId, user.id],
    );
    expect(owner).toEqual([{ role_key: 'owner' }]);
  });

  it('reuses an existing name or stable user selector without duplicating membership', async () => {
    const created = await localIdentity({ display_name: 'Existing Local Operator' });
    const createdUser = (await created.json() as { user: { id: string } }).user;

    const byName = await localIdentity({ display_name: ' existing local operator ' });
    const byId = await localIdentity({ user_id: createdUser.id, display_name: 'ignored selector label' });
    expect(byName.status).toBe(201);
    expect(byId.status).toBe(201);
    expect((await byName.json() as { user: { id: string } }).user.id).toBe(createdUser.id);
    expect((await byId.json() as { user: { id: string } }).user.id).toBe(createdUser.id);
    expect(await count('SELECT COUNT(*) AS count FROM app_user WHERE LOWER(display_name) = LOWER(?)', ['Existing Local Operator'])).toBe(1);
    expect(await count('SELECT COUNT(*) AS count FROM workspace_member WHERE workspace_id = ? AND user_id = ?', [workspaceId, createdUser.id])).toBe(1);
    expect(await count('SELECT COUNT(*) AS count FROM session WHERE user_id = ?', [createdUser.id])).toBe(3);
  });

  it('serializes concurrent same-name service and route requests without duplicate users', async () => {
    const [serviceA, serviceB] = await Promise.all([
      userService.findOrCreateLocalUser('Direct Concurrent Operator', workspaceId),
      userService.findOrCreateLocalUser('direct concurrent operator', workspaceId),
    ]);
    expect(serviceA.user.id).toBe(serviceB.user.id);
    expect([serviceA.isNewUser, serviceB.isNewUser].sort()).toEqual([false, true]);
    expect(await count('SELECT COUNT(*) AS count FROM app_user WHERE LOWER(display_name) = LOWER(?)', ['Direct Concurrent Operator'])).toBe(1);

    const [routeA, routeB] = await Promise.all([
      localIdentity({ display_name: 'Route Concurrent Operator' }),
      localIdentity({ display_name: 'route concurrent operator' }),
    ]);
    expect(routeA.status).toBe(201);
    expect(routeB.status).toBe(201);
    const userA = (await routeA.json() as { user: { id: string } }).user;
    const userB = (await routeB.json() as { user: { id: string } }).user;
    expect(userA.id).toBe(userB.id);
    expect(await count('SELECT COUNT(*) AS count FROM app_user WHERE LOWER(display_name) = LOWER(?)', ['Route Concurrent Operator'])).toBe(1);
    expect(await count('SELECT COUNT(*) AS count FROM workspace_member WHERE workspace_id = ? AND user_id = ?', [workspaceId, userA.id])).toBe(1);
    expect(await count('SELECT COUNT(*) AS count FROM session WHERE user_id = ?', [userA.id])).toBe(2);
  });

  it('rejects missing, blank, oversized, unknown-key, and missing-user selectors without writes', async () => {
    await expect(userService.findOrCreateLocalUser('   ', workspaceId)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(userService.findOrCreateLocalUser('x'.repeat(81), workspaceId)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    for (const body of [
      {},
      { display_name: '   ' },
      { display_name: 'x'.repeat(81) },
      { display_name: 'Canary', unexpected: true },
      { user_id: 'missing-local-user' },
    ]) {
      const response = await localIdentity(body);
      expect(response.status).toBe(400);
    }
    expect(await count('SELECT COUNT(*) AS count FROM app_user')).toBe(0);
    expect(await count('SELECT COUNT(*) AS count FROM workspace_member')).toBe(0);
    expect(await count('SELECT COUNT(*) AS count FROM session')).toBe(0);
    expect(await count('SELECT COUNT(*) AS count FROM audit_log')).toBe(0);
  });

  it('keeps caller-selected local identity creation unavailable in enforced mode', async () => {
    (config.auth as { mode: string }).mode = 'enforced';
    const response = await localIdentity({ display_name: 'Forbidden Local Operator' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found', message: 'Not available outside open mode.' });
    expect(await count('SELECT COUNT(*) AS count FROM app_user')).toBe(0);
  });

  it('rolls back user, membership, audit, and session when the atomic audit write fails', async () => {
    const realLog = auditService.log.bind(auditService);
    auditService.log = async () => { throw new Error('injected local identity audit failure'); };
    try {
      const response = await localIdentity({ display_name: 'Rolled Back Operator' });
      expect(response.status).toBe(500);
      expect(await count('SELECT COUNT(*) AS count FROM app_user')).toBe(0);
      expect(await count('SELECT COUNT(*) AS count FROM principal WHERE kind = ?', ['user'])).toBe(0);
      expect(await count('SELECT COUNT(*) AS count FROM workspace_member')).toBe(0);
      expect(await count('SELECT COUNT(*) AS count FROM session')).toBe(0);
      expect(await count('SELECT COUNT(*) AS count FROM audit_log')).toBe(0);
    } finally {
      auditService.log = realLog;
    }
  });
});
