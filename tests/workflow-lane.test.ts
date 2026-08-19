import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { convertPlaceholders } from '../src/db/postgres-adapter.js';
import { translateForPostgres } from '../src/db/migrator.js';
import {
  AgentService,
  AuditService,
  BoardService,
  CardService,
  ColumnService,
  EventService,
  ProjectService,
} from '../src/services/index.js';
import { createCardServiceForTest } from './support/card-service.js';
import { createColumnRouter } from '../src/api/routes/column.routes.js';
import { createMcpServer } from '../src/mcp/server.js';
import { columnCreateSchema, columnUpdateSchema } from '../src/api/schemas.js';
import { OPEN_AUTH_CONTEXT } from '../src/shared/auth-context.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-workflow-lane.db');

describe('MUS-77 explicit workflow-lane semantics', () => {
  let db: DatabaseAdapter;
  let migrator: Migrator;
  let boardService: BoardService;
  let columnService: ColumnService;
  let cardService: CardService;
  let projectService: ProjectService;
  let agentService: AgentService;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['workflow-lane-ws', 'Workflow lane test workspace', 'workflow-lane-tests', now, now],
    );
    const events = new EventService(db);
    boardService = new BoardService(db, events);
    columnService = new ColumnService(db, events);
    cardService = createCardServiceForTest(db, events);
    projectService = new ProjectService(db, events, boardService);
    agentService = new AgentService(db, events);
  });

  afterEach(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('seeds roles, preserves compatibility omissions as needs_review, and accepts explicit custom specs', async () => {
    const project = await projectService.create({ name: 'Workflow layouts' });
    const seeded = (await boardService.list(project.id))[0];
    const seededColumns = await columnService.list(seeded.id);
    expect(seededColumns.map(column => column.workflow_role)).toEqual([
      'backlog', 'ready', 'active', 'review', 'terminal',
    ]);
    expect(seeded.workflow_config_state).toBe('configured');

    const compatibility = await boardService.create({
      project_id: project.id,
      name: 'Name-only compatibility board',
      columns: ['Queue', 'Doing', 'Finished'],
    });
    expect((await columnService.list(compatibility.id)).map(column => column.workflow_role))
      .toEqual(['ready', 'ready', 'ready']);
    expect(compatibility.workflow_config_state).toBe('needs_review');

    const explicit = await boardService.create({
      project_id: project.id,
      name: 'Explicit custom board',
      columns: [
        { name: 'Intake', workflow_role: 'backlog' },
        { name: 'Executing', workflow_role: 'active' },
        { name: 'Verification', workflow_role: 'review' },
        { name: 'Shipped', workflow_role: 'terminal' },
      ],
    });
    expect(explicit.workflow_config_state).toBe('configured');
    expect((await columnService.list(explicit.id)).map(column => column.workflow_role))
      .toEqual(['backlog', 'active', 'review', 'terminal']);
  });

  it('backfills only canonical names and never guesses a renamed or false Done lane', async () => {
    const project = await projectService.create({ name: 'Migration semantics' });
    const board = (await boardService.list(project.id))[0];
    const columns = await columnService.list(board.id);
    const names = ['Backlog', 'To Do', 'In Progress', 'In Review', 'Done'];
    for (let index = 0; index < columns.length; index++) {
      await db.execute(
        'UPDATE "column" SET name = ?, workflow_role = NULL, is_terminal = 0 WHERE id = ?',
        [names[index], columns[index].id],
      );
    }
    await migrator.run();
    const rows = await columnService.list(board.id);
    expect(rows.map(column => column.workflow_role)).toEqual([
      'backlog', 'ready', 'active', 'review', null,
    ]);
    expect((await boardService.getById(board.id))?.workflow_config_state).toBe('needs_review');
  });

  it('uses role semantics for renamed and multiple active lanes, including blocked moves', async () => {
    const project = await projectService.create({ name: 'Role enforcement' });
    const board = await boardService.create({
      project_id: project.id,
      name: 'Localized workflow',
      columns: [
        { name: 'Queue', workflow_role: 'ready' },
        { name: 'Primär', workflow_role: 'active' },
        { name: 'Sekundär', workflow_role: 'active' },
        { name: 'Archiv', workflow_role: 'terminal' },
      ],
    });
    const columns = await columnService.list(board.id);
    const ready = columns.find(column => column.workflow_role === 'ready')!;
    const active = columns.filter(column => column.workflow_role === 'active');
    const blocker = await cardService.create({ column_id: ready.id, title: 'Blocking work' });
    const blocked = await cardService.create({ column_id: ready.id, title: 'Blocked work' });
    await cardService.linkCard(blocker.id, blocked.id, 'blocks');
    const agent = await agentService.register({ name: 'Workflow agent' });

    await expect(cardService.claim(blocked.id, agent.id)).rejects.toMatchObject({ code: 'CARD_BLOCKED' });
    for (const lane of active) {
      await expect(cardService.move(blocked.id, { target_column_id: lane.id })).rejects.toMatchObject({ code: 'CARD_BLOCKED' });
    }

    const unblocked = await cardService.create({ column_id: ready.id, title: 'Ready work' });
    const claimed = await cardService.claim(unblocked.id, agent.id);
    expect('next_active_lane' in claimed && claimed.next_active_lane?.id).toBe(active[0].id);

    await columnService.update(active[0].id, { name: 'Exécution' });
    await expect(cardService.move(blocked.id, { target_column_id: active[0].id })).rejects.toMatchObject({ code: 'CARD_BLOCKED' });
  });

  it('keeps REST and MCP role mutations explicit instead of inferring from display names', async () => {
    const project = await projectService.create({ name: 'Transport role parity' });
    const board = await boardService.create({
      project_id: project.id,
      name: 'Localized transport board',
      columns: [
        { name: 'Entrée', workflow_role: 'ready' },
        { name: 'Exécution', workflow_role: 'active' },
        { name: 'Archivé', workflow_role: 'terminal' },
      ],
    });

    // The REST contract accepts the same role-bearing payload as the direct
    // service. A presentation name such as "Done" remains ready when the
    // semantic field is omitted; the route must not restore name heuristics.
    expect(columnCreateSchema.parse({ name: 'Done' })).toEqual({ name: 'Done' });
    expect(columnUpdateSchema.parse({ workflow_role: 'review', confirm_impact: true }))
      .toEqual({ workflow_role: 'review', confirm_impact: true });
    expect(() => columnCreateSchema.parse({ name: 'Unclassified', workflow_role: null })).toThrow();
    expect(() => columnUpdateSchema.parse({ workflow_role: null })).toThrow();
    const restRouter = createColumnRouter(columnService) as any;
    const restPost = restRouter.stack.find((layer: any) => layer.route?.path === '/boards/:boardId/columns' && layer.route.methods.post)
      .route.stack.at(-1).handle;
    let restCreated: any;
    await restPost(
      { params: { boardId: board.id }, body: { name: 'Done' }, authContext: OPEN_AUTH_CONTEXT },
      { status: () => ({ json: (value: any) => { restCreated = value; } }) },
      (error?: unknown) => { if (error) throw error; },
    );
    expect(restCreated).toMatchObject({ name: 'Done', workflow_role: 'ready', is_terminal: 0 });

    // MCP exposes the identical role input, and its localized "In Progress"
    // display name also cannot manufacture an active lane.
    const mcp = createMcpServer({ columnService } as any, undefined, OPEN_AUTH_CONTEXT) as any;
    const mcpResult = await mcp._registeredTools.create_column.handler({
      board_id: board.id,
      name: 'In Progress',
    }, {});
    expect(JSON.parse(mcpResult.content[0].text)).toMatchObject({
      name: 'In Progress',
      workflow_role: 'ready',
      is_terminal: 0,
    });
  });

  it('requires populated-role confirmation and protects the last active/terminal lanes', async () => {
    const project = await projectService.create({ name: 'Workflow invariants' });
    const board = await boardService.create({
      project_id: project.id,
      name: 'Invariant board',
      columns: [
        { name: 'Ready', workflow_role: 'ready' },
        { name: 'Active A', workflow_role: 'active' },
        { name: 'Active B', workflow_role: 'active' },
        { name: 'Terminal', workflow_role: 'terminal' },
      ],
    });
    const columns = await columnService.list(board.id);
    const activeA = columns.find(column => column.name === 'Active A')!;
    const terminal = columns.find(column => column.workflow_role === 'terminal')!;
    await cardService.create({ column_id: activeA.id, title: 'Existing work' });

    await expect(columnService.update(activeA.id, { workflow_role: 'terminal' }))
      .rejects.toMatchObject({ code: 'WORKFLOW_IMPACT_CONFIRMATION_REQUIRED' });
    expect((await columnService.getById(activeA.id))?.workflow_role).toBe('active');
    await columnService.update(activeA.id, { workflow_role: 'terminal', confirm_impact: true });
    const roleEvents = await db.query<{ action: string }>(
      'SELECT action FROM event WHERE entity_id = ? ORDER BY created_at, id',
      [activeA.id],
    );
    expect(roleEvents.filter(event => event.action === 'workflow_role_changed')).toHaveLength(1);
    expect(roleEvents.filter(event => event.action === 'updated')).toHaveLength(0);
    await db.execute('UPDATE card SET archived = 1 WHERE column_id = ?', [activeA.id]);
    await columnService.delete(activeA.id);
    await expect(columnService.delete(terminal.id)).rejects.toMatchObject({ code: 'WORKFLOW_CONFIGURATION_INVALID' });
  });

  it('fails closed without claim, move, assignment, lease, or event mutation while configuration needs review', async () => {
    const project = await projectService.create({ name: 'Needs review enforcement' });
    const board = await boardService.create({
      project_id: project.id,
      name: 'Ambiguous board',
      columns: ['Queue', 'Doing', 'Finished'],
    });
    const columns = await columnService.list(board.id);
    const card = await cardService.create({ column_id: columns[0].id, title: 'Do not mutate' });
    const agent = await agentService.register({ name: 'Guarded workflow agent' });
    const beforeEvents = await db.query<{ id: string }>('SELECT id FROM event WHERE entity_id = ?', [card.id]);

    await expect(cardService.claim(card.id, agent.id)).rejects.toMatchObject({
      code: 'WORKFLOW_CONFIGURATION_REQUIRED',
    });
    await expect(cardService.move(card.id, { target_column_id: columns[1].id })).rejects.toMatchObject({
      code: 'WORKFLOW_CONFIGURATION_REQUIRED',
    });

    const after = await cardService.getById(card.id);
    expect(after).toMatchObject({ column_id: columns[0].id, claimed_by: null, claimed_at: null, claim_expires_at: null });
    expect(await db.query('SELECT card_id FROM card_assignee WHERE card_id = ?', [card.id])).toHaveLength(0);
    expect(await db.query<{ id: string }>('SELECT id FROM event WHERE entity_id = ?', [card.id]))
      .toHaveLength(beforeEvents.length);
  });

  it('does not let a configured board be declassified by a service caller', async () => {
    const project = await projectService.create({ name: 'No deconfiguration' });
    const board = (await boardService.list(project.id))[0];
    const active = (await columnService.list(board.id)).find(column => column.workflow_role === 'active')!;

    await expect(columnService.update(active.id, { workflow_role: null } as any))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { code: 'INVALID_WORKFLOW_ROLE' } });
    expect((await columnService.getById(active.id))?.workflow_role).toBe('active');
    expect((await boardService.getById(board.id))?.workflow_config_state).toBe('configured');
  });

  it('rolls back a role change and its activity when audit insertion fails', async () => {
    const project = await projectService.create({ name: 'Workflow audit rollback' });
    const board = await boardService.create({
      project_id: project.id,
      name: 'Audited workflow',
      columns: [
        { name: 'Ready', workflow_role: 'ready' },
        { name: 'Active A', workflow_role: 'active' },
        { name: 'Active B', workflow_role: 'active' },
        { name: 'Terminal', workflow_role: 'terminal' },
      ],
    });
    const active = (await columnService.list(board.id)).find(column => column.workflow_role === 'active')!;
    await cardService.create({ column_id: active.id, title: 'Existing work' });
    const failingAudit = {
      logAs: async () => { throw new Error('audit write failed'); },
    } as unknown as AuditService;
    const auditedColumns = new ColumnService(db, new EventService(db), failingAudit);

    await expect(auditedColumns.update(active.id, { workflow_role: 'review', confirm_impact: true }))
      .rejects.toThrow('audit write failed');
    expect((await columnService.getById(active.id))?.workflow_role).toBe('active');
    expect(await db.query('SELECT id FROM event WHERE entity_id = ? AND action = ?', [active.id, 'workflow_role_changed']))
      .toHaveLength(0);
  });

  it('keeps the role predicates and migration shape portable for PostgreSQL', async () => {
    const migration = fs.readFileSync(path.join(process.cwd(), 'src/db/migrations/011-workflow-lane-roles.sql'), 'utf8');
    expect(translateForPostgres(migration)).toContain("CHECK (workflow_role IS NULL OR workflow_role IN ('backlog', 'ready', 'active', 'review', 'terminal'))");
    expect(translateForPostgres(migration)).not.toMatch(/strftime|AUTOINCREMENT|INSERT OR IGNORE/i);
    expect(convertPlaceholders('SELECT id FROM "column" WHERE board_id = ? AND workflow_role = ? ORDER BY position, id'))
      .toBe('SELECT id FROM "column" WHERE board_id = $1 AND workflow_role = $2 ORDER BY position, id');
  });
});
