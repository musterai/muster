// File: tests/hardening.test.ts
//
// MUS-30 acceptance criteria:
// - every privileged action writes exactly one audit record naming the real actor
// - audit records cannot be written by a client directly, only as a side effect
// - exceeding the rate limit returns 429 with Retry-After
// - a cross-origin request from an unlisted origin is refused
// - an oversized request body/field is rejected before reaching the database

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { RoleService } from '../src/services/role.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { CardService } from '../src/services/card.service.js';
import { createRoleRouter } from '../src/api/routes/role.routes.js';
import { createRateLimiter } from '../src/api/middleware/generic-rate-limiter.js';
import { corsMiddleware } from '../src/api/middleware/security.js';
import { AuthContext } from '../src/shared/auth-context.js';
import { assertMaxLength } from '../src/shared/content-limits.js';
import { config } from '../src/config/index.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-hardening.db');

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof express.application.listen>; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('MUS-30: audit log', () => {
  let db: DatabaseAdapter;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let wsId: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    wsId = 'ws-hardening';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [wsId, 'WS', 'ws-hardening', now, now]);
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['admin-1', 'user', now]);
    await db.execute('INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)', ['admin-1', 'Admin', 'active', now]);

    const roleService = new RoleService(db);
    const auditService = new AuditService(db);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).authContext = {
        principal: { kind: 'user', id: 'admin-1' },
        workspace_id: wsId,
        permissions: ['role.manage', 'workspace.admin'],
        is_operator_override: true,
        role_name: 'owner',
      } satisfies AuthContext;
      next();
    });
    app.use('/api/v1', createRoleRouter(roleService, auditService));

    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (db) await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* ok */ }
    }
  });

  it('writes exactly one audit record naming the real actor when a role is created', async () => {
    const res = await fetch(`${baseUrl}/api/v1/workspaces/${wsId}/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'sre', name: 'SRE', permissions: ['card.create'] }),
    });
    expect(res.status).toBe(201);
    const role = await res.json();

    const auditService = new AuditService(db);
    const records = await auditService.list(wsId, { action: 'role.create' });
    expect(records).toHaveLength(1);
    expect(records[0].actor_id).toBe('admin-1');
    expect(records[0].actor_kind).toBe('user');
    expect(records[0].target_id).toBe(role.id);
  });

  it('writes exactly one audit record naming the real actor when a role is deleted', async () => {
    const created = await fetch(`${baseUrl}/api/v1/workspaces/${wsId}/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'temp', name: 'Temp', permissions: [] }),
    }).then(r => r.json());

    await fetch(`${baseUrl}/api/v1/roles/${created.id}`, { method: 'DELETE' });

    const auditService = new AuditService(db);
    const records = await auditService.list(wsId, { action: 'role.delete' });
    expect(records).toHaveLength(1);
    expect(records[0].actor_id).toBe('admin-1');
    expect(records[0].target_id).toBe(created.id);
  });

  it('has no route that accepts an audit_log row as client input', async () => {
    // Only a GET listing exists — no POST/PUT/DELETE on /audit-log anywhere.
    const res = await fetch(`${baseUrl}/api/v1/workspaces/${wsId}/audit-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'fake.action', actor_id: 'admin-1' }),
    });
    // Express with no matching route falls through to its default 404.
    expect(res.status).toBe(404);
  });
});

describe('MUS-30: rate limiting', () => {
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('returns 429 with Retry-After once the limit is exceeded', async () => {
    const app = express();
    app.get('/probe', createRateLimiter({ windowMs: 60_000, max: 3 }), (_req, res) => res.json({ ok: true }));
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/probe`);
      expect(res.status).toBe(200);
    }

    const limited = await fetch(`${baseUrl}/probe`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    const body = await limited.json();
    expect(body.error).toBe('rate_limited');
  });

  it('tracks separate keys independently (per-principal keying)', async () => {
    const app = express();
    app.get('/probe', createRateLimiter({ windowMs: 60_000, max: 1, keyFn: (req) => req.headers['x-principal'] as string || 'anon' }), (_req, res) => res.json({ ok: true }));
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;

    const a1 = await fetch(`${baseUrl}/probe`, { headers: { 'x-principal': 'agent-a' } });
    const b1 = await fetch(`${baseUrl}/probe`, { headers: { 'x-principal': 'agent-b' } });
    expect(a1.status).toBe(200);
    expect(b1.status).toBe(200);

    const a2 = await fetch(`${baseUrl}/probe`, { headers: { 'x-principal': 'agent-a' } });
    expect(a2.status).toBe(429);
  });
});

describe('MUS-30: CORS', () => {
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let originalPublicUrl: string;

  beforeEach(() => {
    originalPublicUrl = config.oidc.publicUrl;
    (config.oidc as any).publicUrl = 'https://muster.example.com';
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    (config.oidc as any).publicUrl = originalPublicUrl;
  });

  it('sets Access-Control-Allow-Origin for the configured public origin', async () => {
    const app = express();
    app.use(corsMiddleware);
    app.get('/probe', (_req, res) => res.json({ ok: true }));
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;

    const res = await fetch(`${baseUrl}/probe`, { headers: { Origin: 'https://muster.example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://muster.example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does not echo back an unlisted cross-origin request — the browser then refuses it', async () => {
    const app = express();
    app.use(corsMiddleware);
    app.get('/probe', (_req, res) => res.json({ ok: true }));
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;

    const res = await fetch(`${baseUrl}/probe`, { headers: { Origin: 'https://evil.example.com' } });
    // The server still answers (fetch() itself isn't a browser and doesn't
    // enforce CORS) — what matters is it never names the untrusted origin,
    // which is what makes a real browser block the response from script.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers an OPTIONS preflight without reaching the route handler', async () => {
    let handlerCalled = false;
    const app = express();
    app.use(corsMiddleware);
    app.post('/probe', (_req, res) => { handlerCalled = true; res.json({ ok: true }); });
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;

    const res = await fetch(`${baseUrl}/probe`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://muster.example.com', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(handlerCalled).toBe(false);
  });
});

describe('MUS-30: oversized content is rejected before reaching the database', () => {
  it('assertMaxLength throws a 400-mapped ValidationError over the limit', () => {
    expect(() => assertMaxLength('a'.repeat(10), 5, 'Test field')).toThrow('exceeds the maximum length');
    expect(() => assertMaxLength('a'.repeat(5), 5, 'Test field')).not.toThrow();
    expect(() => assertMaxLength(null, 5, 'Test field')).not.toThrow();
  });

  it('CardService.create rejects an oversized description without writing a row', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const db = createDatabaseAdapter(TEST_DB);
    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    const now = new Date().toISOString();
    await db.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['ws-x', 'WS', 'ws-x', now, now]);
    await db.execute('INSERT INTO project (id, workspace_id, name, key_prefix, card_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['proj-x', 'ws-x', 'Proj', 'PRJ', 0, now, now]);
    await db.execute('INSERT INTO board (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['board-x', 'proj-x', 'Board', now, now]);
    await db.execute('INSERT INTO "column" (id, board_id, name, position) VALUES (?, ?, ?, ?)', ['col-x', 'board-x', 'To Do', 'a']);

    const cardService = createCardServiceForTest(db);
    await expect(cardService.create({ column_id: 'col-x', title: 'x', description: 'a'.repeat(200_001) })).rejects.toThrow('exceeds the maximum length');

    const rows = await db.query('SELECT * FROM card');
    expect(rows).toHaveLength(0);

    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* ok */ }
    }
  });
});
import { createCardServiceForTest } from './support/card-service.js';
