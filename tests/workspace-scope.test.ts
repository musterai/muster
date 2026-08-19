import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import {
  AgentService,
  AuditService,
  BoardService,
  CardService,
  ColumnService,
  CommentService,
  DocumentService,
  EventService,
  KBService,
  ProjectService,
  RoleService,
  UserService,
} from '../src/services/index.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { AuthContext } from '../src/shared/auth-context.js';
import { config } from '../src/config/index.js';
import { createProjectRouter } from '../src/api/routes/project.routes.js';
import { createKBRouter } from '../src/api/routes/kb.routes.js';

describe('MUS-66 workspace isolation', () => {
  let db: DatabaseAdapter;
  let tempDir: string;
  let originalMode: typeof config.auth.mode;
  let projects: ProjectService;
  let boards: BoardService;
  let columns: ColumnService;
  let cards: CardService;
  let documents: DocumentService;
  let events: EventService;
  let kbs: KBService;
  let agents: AgentService;
  let roles: RoleService;
  let users: UserService;

  const auth = (workspaceId: string, principalId: string): AuthContext => ({
    principal: { id: principalId, kind: 'user' },
    workspace_id: workspaceId,
    is_workspace_member: true,
    permissions: ['workspace.read', 'workspace.admin', 'project.create', 'card.create', 'card.move', 'card.assign_others', 'card.link', 'doc.create', 'kb.create', 'kb.update', 'role.manage'],
    is_operator_override: false,
    role_name: 'owner',
  });

  beforeEach(async () => {
    originalMode = config.auth.mode;
    (config.auth as { mode: typeof config.auth.mode }).mode = 'enforced';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workspace-scope-'));
    db = createDatabaseAdapter(path.join(tempDir, 'muster.db'));
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    const now = new Date().toISOString();
    for (const [id, name] of [['ws-a', 'Workspace A'], ['ws-b', 'Workspace B']]) {
      await db.execute(
        'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [id, name, id, now, now],
      );
    }
    events = new EventService(db);
    roles = new RoleService(db, events);
    boards = new BoardService(db, events);
    projects = new ProjectService(db, events, boards);
    columns = new ColumnService(db, events);
    cards = new CardService(db, events);
    documents = new DocumentService(db, events);
    kbs = new KBService(db, events);
    agents = new AgentService(db, events);
    users = new UserService(db);
    await roles.seedPreset('ws-a');
    await roles.seedPreset('ws-b');
  });

  afterEach(async () => {
    (config.auth as { mode: typeof config.auth.mode }).mode = originalMode;
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedPrincipal(id: string, workspaceId: string): Promise<void> {
    const now = new Date().toISOString();
    const owner = await roles.getByKey(workspaceId, 'owner');
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [id, 'user', now]);
    await db.execute('INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)', [id, id, 'active', now]);
    await db.execute('INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)', [workspaceId, id, owner!.id, now]);
  }

  it('binds selectors and mixed mutations to one authenticated workspace', async () => {
    await seedPrincipal('user-a', 'ws-a');
    await seedPrincipal('user-b', 'ws-b');
    const authA = auth('ws-a', 'user-a');
    const authB = auth('ws-b', 'user-b');
    const projectA = await projects.create({ name: 'Alpha' }, 'user-a', undefined, authA);
    const projectA2 = await projects.create({ name: 'Alpha Two' }, 'user-a', undefined, authA);
    const projectB = await projects.create({ name: 'Bravo' }, 'user-b', undefined, authB);
    const boardA = (await boards.list(projectA.id, authA))[0];
    const boardB = (await boards.list(projectB.id, authB))[0];
    const columnA = (await columns.list(boardA.id, authA))[0];
    const columnB = (await columns.list(boardB.id, authB))[0];
    const boardA2 = (await boards.list(projectA2.id, authA))[0];
    const columnA2 = (await columns.list(boardA2.id, authA))[0];
    const cardA = await cards.create({ column_id: columnA.id, title: 'Alpha card' }, 'user-a', { auth: authA });
    const cardB = await cards.create({ column_id: columnB.id, title: 'Bravo card' }, 'user-b', { auth: authB });
    const documentB = await documents.create({ project_id: projectB.id, title: 'Bravo doc', content: 'private' }, 'user-b', undefined, authB);

    expect(new Set((await projects.list(authA)).map(project => project.id))).toEqual(new Set([projectA.id, projectA2.id]));
    await expect(projects.getById(projectB.id, authA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(cards.getById(cardB.id, undefined, authA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(cards.list({ column_id: columnB.id }, authA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(events.list(projectB.id, {}, authA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(roles.list('ws-b', authA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(users.listMembers('ws-b', authA)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(cards.move(cardA.id, { target_column_id: columnB.id }, 'user-a', { auth: authA }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await cards.getById(cardA.id, undefined, authA)).column_id).toBe(columnA.id);
    await expect(cards.move(cardA.id, { target_column_id: columnA2.id }, 'user-a', { auth: authA }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await cards.getById(cardA.id, undefined, authA)).column_id).toBe(columnA.id);
    await expect(cards.linkDocument(cardA.id, documentB.id, 'user-a', authA))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(cards.linkCard(cardA.id, cardB.id, 'relates_to', 'user-a', authA))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    const now = new Date().toISOString();
    const kbA = await kbs.create({ name: 'Alpha KB', project_ids: [projectA.id] }, 'user-a', undefined, authA);
    const kbB = await kbs.create({ name: 'Bravo KB', is_global: true, project_ids: [projectB.id] }, 'user-b', undefined, authB);
    expect((await kbs.list(projectA.id, authA)).map(kb => kb.id)).toEqual([kbA.id]);
    const entityA = await kbs.upsertEntity({ kb_id: kbA.id, name: 'Alpha entity' }, 'user-a', undefined, authA);
    const entityB = await kbs.upsertEntity({ kb_id: kbB.id, name: 'Bravo entity' }, 'user-b', undefined, authB);
    await expect(kbs.addFact({
      kb_id: kbA.id,
      entity_id: entityB.id,
      title: 'Invalid mixed fact',
      content: 'Must not bind across KBs',
    }, 'user-a', undefined, authA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const factA = await kbs.addFact({
      kb_id: kbA.id,
      entity_id: entityA.id,
      title: 'Alpha fact',
      content: 'Scoped fact',
    }, 'user-a', undefined, authA);
    await expect(kbs.updateFact(factA.id, { entity_id: entityB.id }, 'user-a', undefined, authA))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(kbs.addRelation({
      kb_id: kbA.id,
      source_entity_id: entityA.id,
      target_entity_id: entityB.id,
      relation_type: 'depends_on',
    }, 'user-a', undefined, authA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await db.query<{ id: string }>(
      'SELECT id FROM kb_relation WHERE source_entity_id = ? AND target_entity_id = ?',
      [entityA.id, entityB.id],
    )).toEqual([]);
    await expect(kbs.linkProject(kbA.id, projectB.id, 'user-a', undefined, authA))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await db.query<{ project_id: string }>(
      'SELECT project_id FROM project_knowledge_base WHERE kb_id = ? AND project_id = ?',
      [kbA.id, projectB.id],
    )).toEqual([]);

    const factB = await kbs.addFact({
      kb_id: kbB.id,
      entity_id: entityB.id,
      title: 'Bravo secret fact',
      content: 'Must remain private',
    }, 'user-b', undefined, authB);
    const invalidFactId = 'invalid-cross-workspace-fact-binding';
    await db.execute(
      `INSERT INTO kb_fact
       (id, kb_id, entity_id, title, content, category, confidence, source_principal_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [invalidFactId, kbA.id, entityB.id, 'Alpha malformed fact', 'Must remain private', 'general', 1, null, now, now],
    );
    expect((await kbs.listFacts(undefined, undefined, undefined, authA)).map(fact => fact.id))
      .toEqual([factA.id]);
    const serviceSearch = await kbs.searchKnowledge('fact', undefined, 20, authA);
    expect(serviceSearch.facts.map(fact => fact.id)).toEqual([factA.id]);
    expect(serviceSearch.facts[0]).toMatchObject({ entity_id: entityA.id, entity_name: 'Alpha entity' });
    expect(JSON.stringify(serviceSearch)).not.toContain(entityB.id);
    expect(JSON.stringify(serviceSearch)).not.toContain('Bravo entity');

    // Simulate a malformed/imported graph edge that satisfies SQL foreign
    // keys but violates the common-KB/workspace invariant. Read paths must
    // filter it before selecting either the foreign endpoint ID or its name.
    const invalidRelationId = 'invalid-cross-workspace-relation';
    await db.execute(
      `INSERT INTO kb_relation
       (id, kb_id, source_entity_id, target_entity_id, relation_type, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [invalidRelationId, kbA.id, entityA.id, entityB.id, 'depends_on', null, now],
    );
    const entityKnowledge = await kbs.getEntityKnowledge(entityA.id, [kbA.id], authA);
    expect(entityKnowledge?.outgoing_relations).toEqual([]);
    expect((await kbs.getGraphTree(kbA.id, undefined, authA)).links).toEqual([]);

    const scopedMcp = createMcpServer({
      projectService: projects,
      boardService: boards,
      columnService: columns,
      cardService: cards,
      commentService: new CommentService(db, events),
      documentService: documents,
      agentService: agents,
      eventService: events,
      kbService: kbs,
      roleService: roles,
      auditService: new AuditService(db),
      userService: users,
      db,
    } as any, undefined, authA) as any;
    const mcpKnowledge = await scopedMcp._registeredTools.get_entity_knowledge.handler({
      query: entityA.id,
      kb_id: kbA.id,
    }, {});
    expect(JSON.parse(mcpKnowledge.content[0].text).outgoing_relations).toEqual([]);
    const mcpSearch = await scopedMcp._registeredTools.search_knowledge.handler({ query: 'fact' }, {});
    const mcpSearchPayload = JSON.parse(mcpSearch.content[0].text);
    expect(mcpSearchPayload.facts.map((fact: { id: string }) => fact.id)).toEqual([factA.id]);
    expect(mcpSearchPayload.facts[0]).toMatchObject({ entity_id: entityA.id, entity_name: 'Alpha entity' });
    expect(mcpSearch.content[0].text).not.toContain(entityB.id);
    expect(mcpSearch.content[0].text).not.toContain('Bravo entity');

    const kbRouter = createKBRouter(kbs) as any;
    const kbRouteHandler = (routePath: string) => kbRouter.stack
      .find((layer: any) => layer.route?.path === routePath && layer.route.methods.get)
      .route.stack.at(-1).handle;
    let restKnowledge: any;
    await kbRouteHandler('/kbs/entity-knowledge')(
      { query: { q: entityA.id, kb_id: kbA.id }, authContext: authA },
      { status: () => ({ json: (payload: any) => { restKnowledge = payload; } }), json: (payload: any) => { restKnowledge = payload; } },
      (error?: unknown) => { if (error) throw error; },
    );
    expect(restKnowledge.outgoing_relations).toEqual([]);
    let restSearch: any;
    await kbRouteHandler('/kbs/search')(
      { query: { q: 'fact' }, authContext: authA },
      { json: (payload: any) => { restSearch = payload; } },
      (error?: unknown) => { if (error) throw error; },
    );
    expect(restSearch.facts.map((fact: { id: string }) => fact.id)).toEqual([factA.id]);
    expect(restSearch.facts[0]).toMatchObject({ entity_id: entityA.id, entity_name: 'Alpha entity' });
    expect(JSON.stringify(restSearch)).not.toContain(entityB.id);
    expect(JSON.stringify(restSearch)).not.toContain('Bravo entity');
    let restGraph: any;
    await kbRouteHandler('/kbs/graph')(
      { query: { kb_id: kbA.id }, authContext: authA },
      { json: (payload: any) => { restGraph = payload; } },
      (error?: unknown) => { if (error) throw error; },
    );
    expect(restGraph.links).toEqual([]);

    // A second malformed/imported row gives one KB owners in two workspaces.
    // Lists must fail closed for that KB and must never hydrate projectB's ID.
    await db.execute(
      'INSERT INTO project_knowledge_base (project_id, kb_id, created_at) VALUES (?, ?, ?)',
      [projectB.id, kbA.id, now],
    );
    expect((await kbs.list(projectA.id, authA)).some(kb => kb.id === kbA.id)).toBe(false);
    const mcpKbs = await scopedMcp._registeredTools.list_knowledge_bases.handler({ project_id: projectA.id }, {});
    const mcpKbPayload = JSON.parse(mcpKbs.content[0].text);
    expect(mcpKbPayload.some((kb: { linked_project_ids?: string[] }) =>
      kb.linked_project_ids?.includes(projectB.id))).toBe(false);
    let restKbs: any;
    await kbRouteHandler('/kbs')(
      { query: { project_id: projectA.id }, authContext: authA },
      { json: (payload: any) => { restKbs = payload; } },
      (error?: unknown) => { if (error) throw error; },
    );
    expect(restKbs.some((kb: { linked_project_ids?: string[] }) =>
      kb.linked_project_ids?.includes(projectB.id))).toBe(false);
    expect((await db.query<{ id: string }>('SELECT id FROM kb_fact WHERE id = ?', [factB.id])).length).toBe(1);

    for (const [id, workspaceId] of [['agent-a', 'ws-a'], ['agent-b', 'ws-b']]) {
      await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [id, 'agent', now]);
      await db.execute('INSERT INTO agent (id, name, status, last_seen_at, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, id, 'active', now, workspaceId, now]);
    }
    expect((await agents.list(authA)).map(agent => agent.id)).toEqual(['agent-a']);

    const mcp = createMcpServer({
      projectService: projects,
      boardService: boards,
      columnService: columns,
      cardService: cards,
      commentService: new CommentService(db, events),
      documentService: documents,
      agentService: agents,
      eventService: events,
      kbService: kbs,
      roleService: roles,
      auditService: new AuditService(db),
      userService: users,
      db,
    } as any, undefined, authA) as any;
    const listed = await mcp._registeredTools.list_projects.handler({}, {});
    expect(new Set(JSON.parse(listed.content[0].text).map((project: { id: string }) => project.id)))
      .toEqual(new Set([projectA.id, projectA2.id]));
    await expect(mcp._registeredTools.get_card.handler({ card_id: cardB.id }, {}))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Exercise the REST handlers without opening a socket: this verifies the
    // transport passes its AuthContext into both list and point selectors.
    const projectRouter = createProjectRouter(db, projects, new AuditService(db)) as any;
    const routeHandler = (routePath: string) => projectRouter.stack
      .find((layer: any) => layer.route?.path === routePath && layer.route.methods.get)
      .route.stack.at(-1).handle;
    let listPayload: any;
    await routeHandler('/')(
      { params: {}, authContext: authA },
      { json: (payload: any) => { listPayload = payload; } },
      (error?: unknown) => { if (error) throw error; },
    );
    expect(new Set(listPayload.map((project: { id: string }) => project.id))).toEqual(new Set([projectA.id, projectA2.id]));
    let foreignError: any;
    await routeHandler('/:id')(
      { params: { id: projectB.id }, authContext: authA },
      { status: () => ({ json: () => undefined }), json: () => undefined },
      (error?: unknown) => { foreignError = error; },
    );
    expect(foreignError).toMatchObject({ code: 'NOT_FOUND' });
  });
});
