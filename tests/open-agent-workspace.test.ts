import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter, ExecutionResult } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { AgentService } from '../src/services/agent.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { CardService } from '../src/services/card.service.js';
import { ProjectService } from '../src/services/project.service.js';
import { createAgentRouter } from '../src/api/routes/agent.routes.js';
import { createProjectRouter } from '../src/api/routes/project.routes.js';
import { createMcpServer } from '../src/mcp/server.js';
import { OPEN_AUTH_CONTEXT, type AuthContext } from '../src/shared/auth-context.js';
import { config } from '../src/config/index.js';

class FailingAdapter implements DatabaseAdapter {
  readonly dialect;
  private failed = false;

  constructor(
    private readonly inner: DatabaseAdapter,
    private readonly shouldFail: (sql: string) => boolean,
  ) {
    this.dialect = inner.dialect;
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.inner.query<T>(sql, params);
  }

  execute(sql: string, params: unknown[] = []): Promise<ExecutionResult> {
    if (!this.failed && this.shouldFail(sql)) {
      this.failed = true;
      return Promise.reject(new Error(`injected failure: ${sql}`));
    }
    return this.inner.execute(sql, params);
  }

  transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.inner.transaction(tx => fn(new FailingAdapter(tx, this.shouldFail)));
  }

  migrate(sql: string): Promise<void> { return this.inner.migrate(sql); }
  close(): Promise<void> { return this.inner.close(); }
  afterCommit(callback: () => void | Promise<void>): void | Promise<void> {
    return this.inner.afterCommit?.(callback);
  }
}

describe('MUS-66 open-mode agent bootstrap workspace binding', () => {
  let db: DatabaseAdapter;
  let tempDir: string;
  let originalMode: typeof config.auth.mode;
  let agents: AgentService;
  let cards: CardService;
  let projects: ProjectService;
  let projectId: string;

  const bootstrapWorkspace = 'workspace-a';
  const otherWorkspace = 'workspace-z';
  const scopedOpenAuth = (workspaceId: string): AuthContext => ({
    ...OPEN_AUTH_CONTEXT,
    workspace_id: workspaceId,
    is_workspace_member: true,
  });

  beforeEach(async () => {
    originalMode = config.auth.mode;
    (config.auth as { mode: typeof config.auth.mode }).mode = 'open';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-open-agent-workspace-'));
    db = createDatabaseAdapter(path.join(tempDir, 'muster.db'));
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();

    // Equal timestamps deliberately exercise the stable ID tie-breaker.
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [otherWorkspace, 'Other Workspace', 'other', now, now],
    );
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [bootstrapWorkspace, 'Bootstrap Workspace', 'bootstrap', now, now],
    );

    agents = new AgentService(db);
    cards = new CardService(db);
    projects = new ProjectService(db);
    projectId = (await projects.create({ name: 'Open Mode Project' })).id;
  });

  afterEach(async () => {
    (config.auth as { mode: typeof config.auth.mode }).mode = originalMode;
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('binds new and legacy-unscoped rebindings without moving concretely scoped agents', async () => {
    const created = await agents.register({ name: 'Direct Open Agent' });
    expect(created.workspace_id).toBe(bootstrapWorkspace);
    expect((await agents.list(scopedOpenAuth(bootstrapWorkspace))).map(agent => agent.id)).toContain(created.id);
    expect(await projects.getSummary(projectId)).toMatchObject({ agent_count: 1, active_agent_count: 1 });

    const now = new Date().toISOString();
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['legacy-unscoped', 'agent', now]);
    await db.execute(
      'INSERT INTO agent (id, name, status, last_seen_at, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['legacy-unscoped', 'Legacy', 'idle', now, null, now],
    );
    const rebound = await agents.register({ agent_id: 'legacy-unscoped', name: 'Legacy Rebound' });
    expect(rebound).toMatchObject({ workspace_id: bootstrapWorkspace, status: 'active' });

    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['already-scoped', 'agent', now]);
    await db.execute(
      'INSERT INTO agent (id, name, status, last_seen_at, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['already-scoped', 'Other Scoped', 'idle', now, otherWorkspace, now],
    );
    const preserved = await agents.register({ agent_id: 'already-scoped', name: 'Other Rebound' });
    expect(preserved.workspace_id).toBe(otherWorkspace);
    expect(await projects.getSummary(projectId)).toMatchObject({ agent_count: 2, active_agent_count: 2 });
  });

  it('keeps REST register, heartbeat, list, and project summary immediately consistent', async () => {
    const agentRouter = createAgentRouter(db, agents, cards, new AuditService(db)) as any;
    const projectRouter = createProjectRouter(db, projects, new AuditService(db)) as any;
    const handler = (router: any, routePath: string, method: 'get' | 'post') => router.stack
      .find((layer: any) => layer.route?.path === routePath && layer.route.methods[method])
      .route.stack.at(-1).handle;
    const invoke = async (routeHandler: any, request: any) => {
      let body: any;
      let status = 200;
      const response = {
        status(code: number) { status = code; return this; },
        json(payload: any) { body = payload; return this; },
        send() { return this; },
      };
      let error: unknown;
      await routeHandler(request, response, (nextError?: unknown) => { error = nextError; });
      if (error) throw error;
      return { body, status };
    };

    const registration = await invoke(handler(agentRouter, '/agents', 'post'), {
      body: { name: 'REST Open Agent' },
      authContext: OPEN_AUTH_CONTEXT,
    });
    expect(registration.status).toBe(201);
    expect(registration.body.workspace_id).toBe(bootstrapWorkspace);

    const heartbeat = await invoke(handler(agentRouter, '/agents/:id/heartbeat', 'post'), {
      params: { id: registration.body.id },
      authContext: OPEN_AUTH_CONTEXT,
    });
    expect(heartbeat.body).toMatchObject({ id: registration.body.id, workspace_id: bootstrapWorkspace, status: 'active' });

    const listed = await invoke(handler(agentRouter, '/agents', 'get'), { authContext: OPEN_AUTH_CONTEXT });
    expect(listed.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: registration.body.id, workspace_id: bootstrapWorkspace }),
    ]));

    const summary = await invoke(handler(projectRouter, '/:id/summary', 'get'), {
      params: { id: projectId },
      authContext: OPEN_AUTH_CONTEXT,
    });
    expect(summary.body).toMatchObject({ agent_count: 1, active_agent_count: 1 });
  });

  it('keeps MCP register, heartbeat, list, and project summary immediately consistent', async () => {
    const server = createMcpServer({
      projectService: projects,
      agentService: agents,
      cardService: cards,
    } as any, undefined, OPEN_AUTH_CONTEXT) as any;

    const registrationResult = await server._registeredTools.register_agent.handler({ name: 'MCP Open Agent' }, {});
    const registration = JSON.parse(registrationResult.content[0].text);
    expect(registration.workspace_id).toBe(bootstrapWorkspace);

    const heartbeatResult = await server._registeredTools.heartbeat.handler({ agent_id: registration.id }, {});
    expect(JSON.parse(heartbeatResult.content[0].text)).toMatchObject({
      id: registration.id,
      workspace_id: bootstrapWorkspace,
      status: 'active',
    });

    const listResult = await server._registeredTools.list_agents.handler({}, {});
    expect(JSON.parse(listResult.content[0].text).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: registration.id, workspace_id: bootstrapWorkspace }),
    ]));

    const summaryResult = await server._registeredTools.get_project_summary.handler({ project_id: projectId }, {});
    expect(JSON.parse(summaryResult.content[0].text)).toMatchObject({ agent_count: 1, active_agent_count: 1 });
  });

  it('rolls back the principal when agent insertion fails after bootstrap resolution', async () => {
    const failing = new FailingAdapter(db, sql => /INSERT INTO agent\s*\(/i.test(sql));
    await expect(new AgentService(failing).register({ agent_id: 'rollback-agent', name: 'Rollback' }))
      .rejects.toThrow('injected failure');
    expect(await db.query('SELECT id FROM principal WHERE id = ?', ['rollback-agent'])).toEqual([]);
    expect(await db.query('SELECT id FROM agent WHERE id = ?', ['rollback-agent'])).toEqual([]);
  });

  it('serializes concurrent registrations into the same bootstrap workspace', async () => {
    const registrations = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      agents.register({ agent_id: `concurrent-agent-${index}`, name: `Concurrent ${index}` })));
    expect(new Set(registrations.map(agent => agent.workspace_id))).toEqual(new Set([bootstrapWorkspace]));
    expect(new Set(registrations.map(agent => agent.id)).size).toBe(12);
    expect(await projects.getSummary(projectId)).toMatchObject({ agent_count: 12, active_agent_count: 12 });
  });

  it('does not manufacture a workspace for embedded workspace-less databases', async () => {
    const embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-embedded-agent-'));
    const embeddedDb = createDatabaseAdapter(path.join(embeddedDir, 'embedded.db'));
    try {
      await new Migrator(embeddedDb, path.join(process.cwd(), 'src/db/migrations')).run();
      const agent = await new AgentService(embeddedDb).register({ name: 'Embedded Agent' });
      expect(agent.workspace_id).toBeNull();
      expect(await embeddedDb.query('SELECT id FROM workspace')).toEqual([]);
    } finally {
      await embeddedDb.close();
      fs.rmSync(embeddedDir, { recursive: true, force: true });
    }
  });
});
