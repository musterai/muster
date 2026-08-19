import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { AgentService, AuditService, CardService, CommentService, EventService, RoleService } from '../src/services/index.js';
import { createCardRouter } from '../src/api/routes/card.routes.js';
import { createAgentRouter } from '../src/api/routes/agent.routes.js';
import { errorHandler } from '../src/api/middleware/error-handler.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { AuthContext } from '../src/shared/auth-context.js';
import type { Services } from '../src/shared/services.js';
import { config } from '../src/config/index.js';
import { PermissionDeniedError } from '../src/shared/permission-enforcer.js';

describe('MUS-61: transport-neutral card and agent row scope', () => {
  let db: DatabaseAdapter;
  let tempDir: string;
  let cardService: CardService;
  let commentService: CommentService;
  let agentService: AgentService;
  let auditService: AuditService;
  let appServer: ReturnType<typeof express.application.listen>;
  let baseUrl: string;
  let currentAuth: AuthContext;
  const originalMode = config.auth.mode;

  const wsA = 'scope-ws-a';
  const wsB = 'scope-ws-b';
  const userA = 'scope-user-a';
  const userOther = 'scope-user-other';
  const userB = 'scope-user-b';
  const agentA = 'scope-agent-a';
  const agentOther = 'scope-agent-other';
  const agentB = 'scope-agent-b';
  const removedAgent = 'scope-agent-removed';
  const colA = 'scope-col-a';
  const colA2 = 'scope-col-a-2';
  const colB = 'scope-col-b';

  const juniorAuth = (principal: AuthContext['principal'] = { kind: 'user', id: userA }): AuthContext => ({
    principal,
    workspace_id: wsA,
    is_workspace_member: true,
    permissions: ['card.update', 'card.move', 'card.claim', 'agent.register'],
    is_operator_override: false,
    role_name: 'junior_engineer',
  });

  const adminAuth = (): AuthContext => ({
    principal: { kind: 'user', id: userA },
    workspace_id: wsA,
    is_workspace_member: true,
    permissions: ['card.update', 'card.move', 'card.claim', 'card.assign_others', 'agent.register', 'agent.manage_others', 'workspace.admin'],
    is_operator_override: true,
    role_name: 'owner',
  });

  beforeEach(async () => {
    (config.auth as any).mode = 'enforced';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-row-scope-'));
    db = createDatabaseAdapter(path.join(tempDir, 'muster.db'));
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    cardService = new CardService(db, new EventService(db));
    commentService = new CommentService(db);
    agentService = new AgentService(db);
    auditService = new AuditService(db);

    const roles = new RoleService(db);
    const now = new Date().toISOString();
    for (const [id, name, slug] of [[wsA, 'Scope A', 'scope-a'], [wsB, 'Scope B', 'scope-b']]) {
      await db.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, name, slug, now, now]);
      await roles.seedPreset(id);
    }
    for (const [id, workspace] of [[userA, wsA], [userOther, wsA], [userB, wsB]]) {
      const role = await roles.getByKey(workspace, 'junior_engineer');
      await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [id, 'user', now]);
      await db.execute('INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)', [id, id, 'active', now]);
      await db.execute('INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)', [workspace, id, role!.id, now]);
    }
    for (const [id, operator, workspace] of [
      [agentA, userA, wsA], [agentOther, userOther, wsA], [agentB, userB, wsB], [removedAgent, null, wsA],
    ]) {
      await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [id, 'agent', now]);
      await db.execute(
        `INSERT INTO agent (id, name, status, last_seen_at, operator_user_id, workspace_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, id, 'active', now, operator, workspace, now],
      );
    }

    await seedWorkspaceGraph(wsA, 'a', colA, colA2);
    await seedWorkspaceGraph(wsB, 'b', colB);
    await seedCard('card-own-user', 'SCA-1', colA, [userA]);
    await seedCard('card-own-agent', 'SCA-2', colA, [agentA]);
    await seedCard('card-coassigned', 'SCA-3', colA, [agentA, agentOther]);
    await seedCard('card-other', 'SCA-4', colA, [agentOther]);
    await seedCard('card-unassigned', 'SCA-5', colA, []);
    await seedCard('card-expired-only', 'SCA-6', colA, [], agentA, new Date(Date.now() - 60_000).toISOString());
    await seedCard('card-expired-assigned', 'SCA-7', colA, [agentA], agentA, new Date(Date.now() - 60_000).toISOString());
    await seedCard('card-cross', 'SCB-1', colB, [agentB]);

    currentAuth = juniorAuth();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).authContext = currentAuth;
      next();
    });
    app.use('/api/v1', createCardRouter(cardService, commentService));
    app.use('/api/v1', createAgentRouter(db, agentService, cardService, auditService));
    app.use((err: Error, req: Request, res: Response, next: NextFunction) => errorHandler(err, req, res, next));
    appServer = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      appServer.once('listening', resolve);
      appServer.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}/api/v1`;
  });

  afterEach(async () => {
    (config.auth as any).mode = originalMode;
    await new Promise<void>(resolve => appServer.close(() => resolve()));
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedWorkspaceGraph(workspace: string, suffix: string, firstColumn: string, secondColumn?: string): Promise<void> {
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO project (id, workspace_id, name, slug, key_prefix, card_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`scope-project-${suffix}`, workspace, `Project ${suffix}`, `project-${suffix}`, `SC${suffix.toUpperCase()}`, 10, now, now],
    );
    await db.execute(
      'INSERT INTO board (id, project_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [`scope-board-${suffix}`, `scope-project-${suffix}`, 'Board', `board-${suffix}`, now, now],
    );
    await db.execute(
      'INSERT INTO "column" (id, board_id, name, position, wip_limit, is_terminal) VALUES (?, ?, ?, ?, ?, ?)',
      [firstColumn, `scope-board-${suffix}`, 'To Do', 'a', null, 0],
    );
    if (secondColumn) {
      await db.execute(
        'INSERT INTO "column" (id, board_id, name, position, wip_limit, is_terminal) VALUES (?, ?, ?, ?, ?, ?)',
        [secondColumn, `scope-board-${suffix}`, 'In Progress', 'b', null, 0],
      );
    }
  }

  async function seedCard(id: string, key: string, column: string, assignees: string[], claimedBy?: string, expires?: string): Promise<void> {
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO card
       (id, key, column_id, title, position, priority, created_at, updated_at, claimed_by, claimed_at, claim_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, key, column, id, id.slice(-1), 'medium', now, now, claimedBy || null, claimedBy ? now : null, expires || null],
    );
    for (const assignee of assignees) {
      await db.execute('INSERT INTO card_assignee (card_id, principal_id) VALUES (?, ?)', [id, assignee]);
    }
  }

  function mcp(auth: AuthContext): any {
    return createMcpServer({ cardService, agentService } as unknown as Services, { headers: {} } as any, auth) as any;
  }

  async function rest(method: string, pathname: string, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('enforces direct-service assignment scope for user, operated agent, co-assignment, unassigned, other operator, and expired lease cases', async () => {
    const auth = juniorAuth();
    await expect(cardService.update('card-own-user', { title: 'direct-user' }, userA, { auth })).resolves.toMatchObject({ title: 'direct-user' });
    await expect(cardService.update('card-own-agent', { title: 'direct-agent' }, userA, { auth })).resolves.toMatchObject({ title: 'direct-agent' });
    await expect(cardService.update('card-coassigned', { title: 'direct-coassigned' }, userA, { auth })).resolves.toMatchObject({ title: 'direct-coassigned' });
    await expect(cardService.update('card-unassigned', { title: 'denied' }, userA, { auth })).rejects.toMatchObject({
      refusal: expect.objectContaining({ required_permission: 'card.assign_others' }),
    });
    await expect(cardService.update('card-other', { title: 'denied' }, userA, { auth })).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(cardService.update('card-expired-only', { title: 'denied' }, userA, { auth })).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(cardService.move('card-expired-assigned', { target_column_id: colA2 }, userA, { auth })).resolves.toMatchObject({ column_id: colA2 });
    expect((await cardService.getById('card-other', db, auth)).title).toBe('card-other');
  });

  it('validates workspace before admin bypass and gives missing/cross-workspace cards the same refusal', async () => {
    const auth = adminAuth();
    await expect(cardService.update('card-unassigned', { title: 'admin allowed' }, userA, { auth })).resolves.toMatchObject({ title: 'admin allowed' });
    for (const ref of ['card-cross', 'missing-card']) {
      await expect(cardService.update(ref, { title: 'never' }, userA, { auth })).rejects.toMatchObject({
        refusal: expect.objectContaining({ required_permission: 'card.assign_others' }),
      });
    }
    expect(await db.query<{ title: string }>('SELECT title FROM card WHERE id = ?', ['card-cross']))
      .toEqual([{ title: 'card-cross' }]);
  });

  it('keeps REST and MCP update/move refusals identical and prevents handler execution', async () => {
    currentAuth = juniorAuth();
    const deniedRest = await rest('PUT', '/cards/card-other', { title: 'rest-hijack' });
    expect(deniedRest.status).toBe(403);
    expect(await deniedRest.json()).toMatchObject({ error: 'forbidden', required_permission: 'card.assign_others' });

    const server = mcp(currentAuth);
    await expect(server._registeredTools.update_card.handler({ card_id: 'card-other', title: 'mcp-hijack' }, {}))
      .rejects.toMatchObject({ refusal: expect.objectContaining({ required_permission: 'card.assign_others' }) });
    await expect(server._registeredTools.move_card.handler({ card_id: 'card-unassigned', target_column_id: colA2 }, {}))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await cardService.getById('card-other', db, currentAuth)).title).toBe('card-other');
    expect((await cardService.getById('card-unassigned', db, currentAuth)).column_id).toBe(colA);

    const allowedRest = await rest('PUT', '/cards/card-own-agent', { title: 'rest-owned' });
    expect(allowedRest.status).toBe(200);
    await expect(server._registeredTools.move_card.handler({ card_id: 'card-own-user', target_column_id: colA2 }, {})).resolves.toBeTruthy();
  });

  it('rejects missing and cross-workspace move targets before rank, card, or event mutation across service, REST, and MCP', async () => {
    currentAuth = juniorAuth();
    const snapshot = () => db.query<{ id: string; column_id: string; position: string }>(
      'SELECT id, column_id, position FROM card ORDER BY id',
    );
    const movedEvents = () => db.query<{ id: string }>(
      "SELECT id FROM event WHERE entity_type = 'card' AND action = 'moved'",
    );
    const beforeCards = await snapshot();
    const beforeEvents = await movedEvents();

    await expect(cardService.move('card-own-user', { target_column_id: colB }, userA, { auth: currentAuth }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    const restDenied = await rest('PATCH', '/cards/card-own-agent/move', { target_column_id: 'missing-column' });
    expect(restDenied.status).toBe(404);
    expect(await restDenied.json()).toMatchObject({
      error: 'Resource not found',
      code: 'NOT_FOUND',
    });

    const server = mcp(currentAuth);
    await expect(server._registeredTools.move_card.handler({ card_id: 'card-coassigned', target_column_id: colB }, {}))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(cardService.move('card-unassigned', { target_column_id: colB }, userA, { auth: adminAuth() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await snapshot()).toEqual(beforeCards);
    expect(await movedEvents()).toEqual(beforeEvents);

    const valid = await cardService.move('card-own-user', { target_column_id: colA2 }, userA, { auth: currentAuth });
    expect(valid.column_id).toBe(colA2);
    expect(await movedEvents()).toHaveLength(beforeEvents.length + 1);
  });

  it('treats claim IDs as selectors in REST and MCP and never claims as another operator', async () => {
    currentAuth = juniorAuth();
    await expect(cardService.claim('card-unassigned', agentOther, 600, userA, { auth: currentAuth }))
      .rejects.toMatchObject({ refusal: expect.objectContaining({ required_permission: 'card.assign_others' }) });
    await expect(cardService.assign('card-unassigned', agentOther, userA, currentAuth))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    const deniedRest = await rest('POST', '/cards/card-unassigned/claim', { agent_id: agentOther });
    expect(deniedRest.status).toBe(403);
    expect(await deniedRest.json()).toMatchObject({ required_permission: 'card.assign_others' });
    expect((await cardService.getById('card-unassigned', db, currentAuth)).claimed_by).toBeNull();

    const server = mcp(currentAuth);
    await expect(server._registeredTools.claim_card.handler({ card_id: 'card-unassigned', agent_id: agentOther }, {}))
      .rejects.toMatchObject({ refusal: expect.objectContaining({ required_permission: 'card.assign_others' }) });
    expect((await cardService.getById('card-unassigned', db, currentAuth)).assignees).toEqual([]);

    const allowed = await rest('POST', '/cards/card-unassigned/claim', { agent_id: agentA });
    expect(allowed.status).toBe(200);
    expect((await cardService.getById('card-unassigned', db, currentAuth)).claimed_by).toBe(agentA);
  });

  it('enforces agent lifecycle ownership directly, including removed agents and non-disclosing cross-workspace targets', async () => {
    const auth = juniorAuth();
    await expect(agentService.heartbeat(agentA, auth)).resolves.toMatchObject({ id: agentA, status: 'active' });
    await expect(agentService.update(agentOther, { name: 'hijacked' }, { auth, workspaceId: wsA })).rejects.toBeInstanceOf(PermissionDeniedError);
    for (const selector of [agentB, 'missing-agent']) {
      await expect(agentService.assertAgentScope(selector, adminAuth(), 'agent.manage_others')).rejects.toMatchObject({
        refusal: expect.objectContaining({ required_permission: 'agent.manage_others' }),
      });
    }
    await expect(agentService.heartbeat(removedAgent, auth)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(agentService.heartbeat(removedAgent, juniorAuth({ kind: 'agent', id: removedAgent }))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await agentService.getById(agentOther))!.name).toBe(agentOther);

    await db.execute('DELETE FROM workspace_member WHERE workspace_id = ? AND user_id = ?', [wsA, userA]);
    await expect(agentService.heartbeat(agentA, auth)).rejects.toMatchObject({
      refusal: expect.objectContaining({ required_permission: 'workspace.read' }),
    });
    await expect(cardService.update('card-unassigned', { title: 'stale-admin' }, userA, { auth: adminAuth() }))
      .rejects.toMatchObject({ refusal: expect.objectContaining({ required_permission: 'workspace.read' }) });
  });

  it('fails closed when an enforced-mode direct service caller omits credential context', async () => {
    await expect(cardService.update('card-own-user', { title: 'no-auth' }, userA))
      .rejects.toMatchObject({ refusal: expect.objectContaining({ required_permission: 'workspace.read' }) });
    await expect(agentService.heartbeat(agentA))
      .rejects.toMatchObject({ refusal: expect.objectContaining({ required_permission: 'workspace.read' }) });
    await expect(agentService.update(agentA, { name: 'no-auth' }))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(agentService.register({ name: 'no-auth-new-agent' }, userA, undefined, wsA))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await cardService.getById('card-own-user', db, juniorAuth())).title).toBe('card-own-user');
    expect((await agentService.getById(agentA))!.name).toBe(agentA);
  });

  it('applies the same agent selector boundary to REST, MCP, rebind, and workspace-scoped listing', async () => {
    currentAuth = juniorAuth();
    const restDenied = await rest('POST', `/agents/${agentOther}/heartbeat`);
    expect(restDenied.status).toBe(403);
    expect(await restDenied.json()).toMatchObject({ required_permission: 'agent.manage_others' });
    const missingDenied = await rest('POST', '/agents/missing-agent/heartbeat');
    expect(await missingDenied.json()).toMatchObject({ required_permission: 'agent.manage_others' });

    const server = mcp(currentAuth);
    await expect(server._registeredTools.heartbeat.handler({ agent_id: agentOther }, {}))
      .rejects.toMatchObject({ refusal: expect.objectContaining({ required_permission: 'agent.manage_others' }) });
    await expect(server._registeredTools.register_agent.handler({ agent_id: agentOther, name: 'rebound' }, {}))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(server._registeredTools.register_agent.handler({ agent_id: 'caller-selected-new-id', name: 'new' }, {}))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await agentService.getById('caller-selected-new-id')).toBeNull();

    const listed = await agentService.list(currentAuth);
    expect(listed.map(agent => agent.id)).toContain(agentA);
    expect(listed.map(agent => agent.id)).not.toContain(agentB);
    const restListed = await rest('GET', '/agents');
    expect((await restListed.json()).map((agent: { id: string }) => agent.id)).not.toContain(agentB);
  });
});
