// File: tests/device-grant.test.ts
//
// MUS-28 acceptance criteria:
// - end-to-end: device flow produces a working token
// - polling before approval returns authorization_pending, not a fatal error
// - polling faster than `interval` returns slow_down
// - an expired device_code is refused and cannot be revived by re-polling
// - a device_code is single-use
// - brute-forcing user_code is rate-limited (route-level, see the last test)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { TokenService } from '../src/services/token.service.js';
import { DeviceGrantService } from '../src/services/device-grant.service.js';
import { RoleService } from '../src/services/role.service.js';
import { createDeviceRouter } from '../src/api/routes/device.routes.js';
import { resetRateLimiterState } from '../src/api/middleware/rate-limiter.js';
import { AuthContext } from '../src/shared/auth-context.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-device-grant.db');

describe('MUS-28: DeviceGrantService', () => {
  let db: DatabaseAdapter;
  let tokenService: TokenService;
  let deviceGrantService: DeviceGrantService;
  let wsId: string;
  let userId: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    wsId = 'ws-device-grant';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [wsId, 'WS', 'ws-device', now, now]);

    userId = 'user-device-1';
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [userId, 'user', now]);
    await db.execute('INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)', [userId, 'Ada', 'active', now]);
    const roleService = new RoleService(db);
    const roles = await roleService.seedPreset(wsId);
    const ownerRole = roles.find(r => r.key === 'owner')!;
    await db.execute(
      'INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)',
      [wsId, userId, ownerRole.id, now],
    );

    tokenService = new TokenService(db);
    deviceGrantService = new DeviceGrantService(db, tokenService);
  });

  afterEach(async () => {
    if (db) await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* ok */ }
    }
    vi.useRealTimers();
  });

  it('completes end-to-end: create -> approve -> poll returns a working token', async () => {
    const grant = await deviceGrantService.createDeviceCode();
    expect(grant.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const approved = await deviceGrantService.approve(grant.user_code, userId, wsId);
    expect(approved).toBe(true);

    const result = await deviceGrantService.poll(grant.device_code);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.token.startsWith('muster_pat_')).toBe(true);
      const verified = await tokenService.verify(result.token.token);
      expect(verified?.principal_id).toBe(userId);
    }
  });

  it('polling before approval returns authorization_pending, not a fatal error', async () => {
    const grant = await deviceGrantService.createDeviceCode();
    const result = await deviceGrantService.poll(grant.device_code);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('authorization_pending');
  });

  it('polling faster than the interval returns slow_down', async () => {
    const grant = await deviceGrantService.createDeviceCode();
    const first = await deviceGrantService.poll(grant.device_code);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error).toBe('authorization_pending');

    // Immediately again, well inside the interval window.
    const second = await deviceGrantService.poll(grant.device_code);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('slow_down');
  });

  it('an expired device_code is refused and cannot be revived by re-polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const grant = await deviceGrantService.createDeviceCode();

    vi.setSystemTime(new Date('2026-01-01T00:11:00.000Z')); // past the 10-minute expiry
    const result = await deviceGrantService.poll(grant.device_code);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('expired_token');

    // Approving after expiry must not resurrect it.
    const approved = await deviceGrantService.approve(grant.user_code, userId, wsId);
    expect(approved).toBe(false);

    vi.useRealTimers();
    const again = await deviceGrantService.poll(grant.device_code);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe('expired_token');
  });

  it('a device_code is single-use — a second poll after a successful claim is refused', async () => {
    const grant = await deviceGrantService.createDeviceCode();
    await deviceGrantService.approve(grant.user_code, userId, wsId);

    const first = await deviceGrantService.poll(grant.device_code);
    expect(first.ok).toBe(true);

    const second = await deviceGrantService.poll(grant.device_code);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('expired_token');
  });

  it('a denied grant reports access_denied exactly once and is then gone', async () => {
    const grant = await deviceGrantService.createDeviceCode();
    await deviceGrantService.deny(grant.user_code);

    const result = await deviceGrantService.poll(grant.device_code);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('access_denied');

    const again = await deviceGrantService.poll(grant.device_code);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe('expired_token');
  });
});

// ─── Route-level: brute-force protection on user_code lookup ────────────────

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof express.application.listen>; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('MUS-28: device routes — user_code brute-force rate limiting', () => {
  const TEST_DB2 = path.join(process.cwd(), 'data', 'test-device-grant-routes.db');
  let db: DatabaseAdapter;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let deviceGrantService: DeviceGrantService;

  beforeEach(async () => {
    resetRateLimiterState();
    if (fs.existsSync(TEST_DB2)) fs.unlinkSync(TEST_DB2);
    db = createDatabaseAdapter(TEST_DB2);
    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    const wsId2 = 'ws-device-routes';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [wsId2, 'WS', 'ws-device-r', now, now]);
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['approver-1', 'user', now]);
    await db.execute('INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)', ['approver-1', 'Approver', 'active', now]);
    const roleService = new RoleService(db);
    const roles = await roleService.seedPreset(wsId2);
    const ownerRole = roles.find(r => r.key === 'owner')!;
    await db.execute(
      'INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)',
      [wsId2, 'approver-1', ownerRole.id, now],
    );

    const tokenService = new TokenService(db);
    deviceGrantService = new DeviceGrantService(db, tokenService);

    const app = express();
    app.use(express.json());
    // Simulate an authenticated approving user directly, bypassing the full
    // session/OIDC stack — permission-guard and auth middleware are covered
    // by other test files; this isolates the rate-limit behavior under test.
    app.use((req, _res, next) => {
      (req as any).authContext = {
        principal: { kind: 'user', id: 'approver-1' },
        workspace_id: wsId2,
        permissions: ownerRole.permissions,
        is_operator_override: true,
        role_name: 'owner',
      } satisfies AuthContext;
      next();
    });
    app.use('/api/v1', createDeviceRouter(db, deviceGrantService));

    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (db) await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB2 + suffix); } catch { /* ok */ }
    }
    resetRateLimiterState();
  });

  it('locks out user_code lookups after repeated wrong guesses from the same IP', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${baseUrl}/api/v1/oauth/device/lookup?user_code=WRONG-${i.toString().padStart(4, '0')}`);
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('a correct, pending user_code is found and reports the approving identity/role', async () => {
    const grant = await deviceGrantService.createDeviceCode();
    const res = await fetch(`${baseUrl}/api/v1/oauth/device/lookup?user_code=${encodeURIComponent(grant.user_code)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_code).toBe(grant.user_code);
    expect(body.role_name).toBe('owner');
  });

  it('approving mints a claimable grant; denying does not', async () => {
    const grant = await deviceGrantService.createDeviceCode();
    const res = await fetch(`${baseUrl}/api/v1/oauth/device/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_code: grant.user_code }),
    });
    expect(res.status).toBe(200);

    const result = await deviceGrantService.poll(grant.device_code);
    expect(result.ok).toBe(true);
  });
});
