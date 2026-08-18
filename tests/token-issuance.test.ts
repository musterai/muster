import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { TokenService, hashToken } from '../src/services/token.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { RoleService } from '../src/services/role.service.js';
import { createTokenRouter } from '../src/api/routes/token.routes.js';
import { errorHandler } from '../src/api/middleware/error-handler.js';
import { AuthContext } from '../src/shared/auth-context.js';
import { PermissionDeniedError } from '../src/shared/permission-enforcer.js';
import { ValidationError } from '../src/shared/errors.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-token-issuance.db');

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof express.application.listen>; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('MUS-56: token issuance authorization boundary', () => {
  let db: DatabaseAdapter;
  let tokenService: TokenService;
  let auditService: AuditService;
  let roleService: RoleService;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let seniorRoleId: string;
  let ownerRoleId: string;
  let observerRoleId: string;
  let operatorId: string;
  let unrelatedOperatorId: string;
  let ownerId: string;
  let ownedAgentId: string;
  let unrelatedAgentId: string;
  let crossWorkspaceAgentId: string;
  let now: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    now = new Date().toISOString();
    workspaceId = 'ws-token-issuance';
    otherWorkspaceId = 'ws-token-issuance-other';
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Token Issuance', 'token-issuance', now, now],
    );
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [otherWorkspaceId, 'Other Workspace', 'token-issuance-other', now, now],
    );

    roleService = new RoleService(db);
    const roles = await roleService.seedPreset(workspaceId);
    await roleService.seedPreset(otherWorkspaceId);
    seniorRoleId = roles.find(role => role.key === 'senior_engineer')!.id;
    ownerRoleId = roles.find(role => role.key === 'owner')!.id;
    observerRoleId = roles.find(role => role.key === 'observer')!.id;

    operatorId = 'token-operator';
    unrelatedOperatorId = 'token-unrelated-operator';
    ownerId = 'token-owner';
    await addUser(operatorId, seniorRoleId, workspaceId);
    await addUser(unrelatedOperatorId, seniorRoleId, workspaceId);
    await addUser(ownerId, ownerRoleId, workspaceId);

    ownedAgentId = 'token-owned-agent';
    unrelatedAgentId = 'token-unrelated-agent';
    await addAgent(ownedAgentId, operatorId, seniorRoleId, workspaceId);
    await addAgent(unrelatedAgentId, unrelatedOperatorId, seniorRoleId, workspaceId);

    const crossOperatorId = 'token-cross-operator';
    await addUser(crossOperatorId, (await roleService.list(otherWorkspaceId)).find(role => role.key === 'owner')!.id, otherWorkspaceId);
    crossWorkspaceAgentId = 'token-cross-agent';
    await addAgent(crossWorkspaceAgentId, crossOperatorId, (await roleService.list(otherWorkspaceId)).find(role => role.key === 'owner')!.id, otherWorkspaceId);

    tokenService = new TokenService(db);
    auditService = new AuditService(db);
  });

  afterEach(async () => {
    if (db) await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
  });

  async function addUser(id: string, roleId: string, wsId: string): Promise<void> {
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [id, 'user', now]);
    await db.execute(
      'INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)',
      [id, id, 'active', now],
    );
    await db.execute(
      'INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)',
      [wsId, id, roleId, now],
    );
  }

  async function addAgent(id: string, operatorUserId: string, roleId: string, wsId: string): Promise<void> {
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [id, 'agent', now]);
    await db.execute(
      `INSERT INTO agent (id, name, status, last_seen_at, operator_user_id, role_id, workspace_id, created_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
      [id, id, now, operatorUserId, roleId, wsId, now],
    );
  }

  function auth(id = operatorId, kind: 'user' | 'agent' = 'user', wsId = workspaceId): AuthContext {
    return {
      principal: { kind, id },
      workspace_id: wsId,
      is_workspace_member: true,
      permissions: [],
      is_operator_override: false,
      role_name: 'Senior Engineer',
    };
  }

  async function issue(targetPrincipalId?: unknown, overrides: Record<string, unknown> = {}) {
    return tokenService.issue(auth(), {
      principal_id: targetPrincipalId,
      workspace_id: workspaceId,
      name: 'MUS-56 test token',
      ...overrides,
    });
  }

  it('allows self tokens and tokens for an operated agent', async () => {
    const self = await issue();
    expect(self.principal_id).toBe(operatorId);

    const agent = await issue(ownedAgentId);
    expect(agent.principal_id).toBe(ownedAgentId);
    expect(await tokenService.verify(agent.token)).toMatchObject({ principal_id: ownedAgentId, workspace_id: workspaceId });
  });

  it('rejects unrelated agents, owner targets and cross-workspace targets without an existence leak', async () => {
    for (const target of [unrelatedAgentId, ownerId, crossWorkspaceAgentId, 'not-a-principal']) {
      await expect(issue(target)).rejects.toBeInstanceOf(PermissionDeniedError);
    }

    await expect(issue(crossWorkspaceAgentId)).rejects.toThrow(/agent.register/);
  });

  it('rejects issuance after the caller or operated agent loses active membership', async () => {
    await db.execute('DELETE FROM workspace_member WHERE workspace_id = ? AND user_id = ?', [workspaceId, operatorId]);
    await expect(issue()).rejects.toBeInstanceOf(PermissionDeniedError);

    // Restore the operator and remove the agent operator's membership instead.
    await db.execute(
      'INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)',
      [workspaceId, operatorId, seniorRoleId, now],
    );
    await db.execute('DELETE FROM workspace_member WHERE workspace_id = ? AND user_id = ?', [workspaceId, operatorId]);
    await expect(issue(ownedAgentId)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('validates names, target identifiers and expiry before touching token storage', async () => {
    await expect(issue(undefined, { name: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(issue(42, { name: 'bad target' })).rejects.toBeInstanceOf(ValidationError);
    await expect(issue(undefined, { expires_at: 'not-a-date' })).rejects.toBeInstanceOf(ValidationError);
    await expect(issue(undefined, { expires_at: new Date(Date.now() - 1000).toISOString() })).rejects.toBeInstanceOf(ValidationError);
    const rows = await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM api_token');
    expect(rows[0].count).toBe(0);
  });

  it('enforces the same policy and redacts secrets on REST success/refusal', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).authContext = auth();
      next();
    });
    app.use(createTokenRouter(tokenService, auditService));
    app.use(errorHandler);
    const listening = await listen(app);

    try {
      const selfResponse = await fetch(`${listening.baseUrl}/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'REST self' }),
      });
      expect(selfResponse.status).toBe(201);
      const self = await selfResponse.json();
      expect(self.principal_id).toBe(operatorId);

      const ownedResponse = await fetch(`${listening.baseUrl}/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'REST agent', target_principal_id: ownedAgentId }),
      });
      expect(ownedResponse.status).toBe(201);
      const owned = await ownedResponse.json();
      expect(owned.principal_id).toBe(ownedAgentId);

      const refusalResponse = await fetch(`${listening.baseUrl}/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'REST unrelated', target_principal_id: ownerId }),
      });
      expect(refusalResponse.status).toBe(403);
      const refusalBody = await refusalResponse.text();
      expect(refusalBody).not.toContain(ownerId);

      const malformedResponse = await fetch(`${listening.baseUrl}/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'REST malformed', expires_at: 'expired' }),
      });
      expect(malformedResponse.status).toBe(400);

      const auditRows = await auditService.list(workspaceId, { action: 'token.create' });
      expect(auditRows.length).toBe(2);
      const refusalRows = await auditService.list(workspaceId, { action: 'token.create_refused' });
      expect(refusalRows.length).toBe(2);
      const auditText = JSON.stringify([...auditRows, ...refusalRows]);
      expect(auditText).not.toContain(self.token);
      expect(auditText).not.toContain(hashToken(self.token));
      expect(auditText).not.toContain(owned.token);
      expect(auditText).not.toContain(hashToken(owned.token));
    } finally {
      await new Promise<void>(resolve => listening.server.close(() => resolve()));
    }
  });
});
