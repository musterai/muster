import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import {
  AgentService,
  BoardService,
  CardService,
  ColumnService,
  EventService,
  ProjectService,
} from '../src/services/index.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-card-rules.db');

describe('server-side card rules', () => {
  let db: DatabaseAdapter;
  let projectService: ProjectService;
  let boardService: BoardService;
  let columnService: ColumnService;
  let cardService: CardService;
  let agentService: AgentService;
  let eventService: EventService;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();

    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ['test-ws-card-rules', 'Card Rules Test Workspace', 'card-rules', now, now],
    );

    eventService = new EventService(db);
    boardService = new BoardService(db, eventService);
    projectService = new ProjectService(db, eventService, boardService);
    columnService = new ColumnService(db, eventService);
    cardService = createCardServiceForTest(db, eventService);
    agentService = new AgentService(db, eventService);
  });

  afterEach(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('rejects WIP-overflow creates and moves, then records an explicit override', async () => {
    const project = await projectService.create({ name: 'WIP Rules' });
    const [board] = await boardService.list(project.id);
    const columns = await columnService.list(board.id);
    const inProgress = columns.find(column => column.name === 'In Progress')!;
    const toDo = columns.find(column => column.name === 'To Do')!;
    await columnService.update(inProgress.id, { wip_limit: 1 });

    await cardService.create({ column_id: inProgress.id, title: 'Existing work' });

    await expect(
      cardService.create({ column_id: inProgress.id, title: 'Overflow work' }),
    ).rejects.toMatchObject({
      code: 'CARD_WIP_LIMIT',
      details: {
        rule: 'wip_limit',
        operation: 'create',
        current_count: 1,
        wip_limit: 1,
      },
    });

    const movable = await cardService.create({ column_id: toDo.id, title: 'Move into full lane' });
    await expect(
      cardService.move(movable.id, { target_column_id: inProgress.id }),
    ).rejects.toMatchObject({
      code: 'CARD_WIP_LIMIT',
      details: { operation: 'move', column_id: inProgress.id },
    });

    const operator = await agentService.register({ name: 'Operator' });
    const moved = await cardService.move(
      movable.id,
      { target_column_id: inProgress.id },
      operator.id,
      { operatorOverride: true },
    );
    expect(moved.column_id).toBe(inProgress.id);

    const events = await eventService.list(project.id, { entity_type: 'card', entity_id: movable.id });
    expect(events.some(event => event.action === 'override' && event.payload?.operation === 'move')).toBe(true);
  });

  it('blocks claims and In Progress moves while a linked blocker is unresolved', async () => {
    const project = await projectService.create({ name: 'Blocker Rules' });
    const [board] = await boardService.list(project.id);
    const columns = await columnService.list(board.id);
    const backlog = columns.find(column => column.name === 'Backlog')!;
    const toDo = columns.find(column => column.name === 'To Do')!;
    const inProgress = columns.find(column => column.name === 'In Progress')!;
    const blocker = await cardService.create({ column_id: backlog.id, title: 'Blocking task' });
    const blocked = await cardService.create({ column_id: toDo.id, title: 'Blocked task' });
    await cardService.linkCard(blocker.id, blocked.id, 'blocks');
    const agent = await agentService.register({ name: 'Blocked Task Agent' });

    await expect(cardService.claim(blocked.id, agent.id)).rejects.toMatchObject({
      code: 'CARD_BLOCKED',
      details: {
        rule: 'blocked_by',
        operation: 'claim',
      },
    });
    await expect(
      cardService.move(blocked.id, { target_column_id: inProgress.id }),
    ).rejects.toMatchObject({
      code: 'CARD_BLOCKED',
      details: { rule: 'blocked_by', operation: 'move' },
    });

    const claimed = await cardService.claim(
      blocked.id,
      agent.id,
      600,
      agent.id,
      { operatorOverride: true },
    );
    expect('success' in claimed ? claimed.success : claimed.claimed_by).not.toBe(false);

    const moved = await cardService.move(
      blocked.id,
      { target_column_id: inProgress.id },
      agent.id,
      { operatorOverride: true },
    );
    expect(moved.column_id).toBe(inProgress.id);

    const events = await eventService.list(project.id, { entity_type: 'card', entity_id: blocked.id });
    expect(events.some(event => event.action === 'override' && event.payload?.operation === 'claim')).toBe(true);
    expect(events.some(event => event.action === 'override' && event.payload?.operation === 'move')).toBe(true);
  });
});
import { createCardServiceForTest } from './support/card-service.js';
