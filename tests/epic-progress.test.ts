// File: tests/epic-progress.test.ts
// MUS-34: terminal columns and Epic done/total rollups.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import {
  BoardService,
  CardService,
  ColumnService,
  EventService,
  ProjectService,
} from '../src/services/index.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-epic-progress.db');

describe('MUS-34: Epic progress rollup', () => {
  let db: DatabaseAdapter;
  let projectService: ProjectService;
  let boardService: BoardService;
  let columnService: ColumnService;
  let cardService: CardService;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);

    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    const eventService = new EventService(db);
    boardService = new BoardService(db, eventService);
    projectService = new ProjectService(db, eventService, boardService);

    const wsId = 'test-ws-01';
    const now = new Date().toISOString();
    await db.execute(
      `INSERT OR IGNORE INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [wsId, 'Test Workspace', 'test', now, now]
    );

    columnService = new ColumnService(db, eventService);
    cardService = createCardServiceForTest(db, eventService);
  });

  afterEach(async () => {
    if (db) await db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  async function setupBoard() {
    const project = await projectService.create({ name: `Progress-${Math.random()}` });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);
    // Default board comes with a starter column; add two more so we have a
    // realistic To Do / In Progress / Done spread.
    const todo = columns[0];
    const inProgress = await columnService.create({ board_id: boards[0].id, name: 'In Progress' });
    const done = await columnService.create({ board_id: boards[0].id, name: 'Done' });
    return { todo, inProgress, done };
  }

  it('a board owner can flag a column as terminal, and it is not terminal by default', async () => {
    const { done } = await setupBoard();
    expect(done.is_terminal).toBe(0);

    const updated = await columnService.update(done.id, { is_terminal: true });
    expect(updated.is_terminal).toBe(1);

    const created = await columnService.create({ board_id: done.board_id, name: 'Archived', is_terminal: true });
    expect(created.is_terminal).toBe(1);
  });

  it('an Epic with zero children shows no progress indicator (null, not 0/0)', async () => {
    const { todo } = await setupBoard();
    const epic = await cardService.create({ column_id: todo.id, title: 'Empty epic', is_epic: true });

    const details = await cardService.getById(epic.id);
    expect(details.epic_progress).toBeNull();
  });

  it('a non-Epic card never gets a progress indicator, even with linked children', async () => {
    const { todo } = await setupBoard();
    const notAnEpic = await cardService.create({ column_id: todo.id, title: 'Just a card' });
    const child = await cardService.create({ column_id: todo.id, title: 'Child' });
    await cardService.linkCard(notAnEpic.id, child.id, 'parent_of');

    const details = await cardService.getById(notAnEpic.id);
    expect(details.epic_progress).toBeNull();
  });

  it('children spanning terminal and non-terminal columns produce an accurate done/total count', async () => {
    const { todo, inProgress, done } = await setupBoard();
    await columnService.update(done.id, { is_terminal: true, confirm_impact: true });

    const epic = await cardService.create({ column_id: todo.id, title: 'Big epic', is_epic: true });
    const childDone1 = await cardService.create({ column_id: done.id, title: 'Done child 1' });
    const childDone2 = await cardService.create({ column_id: done.id, title: 'Done child 2' });
    const childInProgress = await cardService.create({ column_id: inProgress.id, title: 'In-progress child' });
    const childTodo = await cardService.create({ column_id: todo.id, title: 'Todo child' });

    for (const child of [childDone1, childDone2, childInProgress, childTodo]) {
      await cardService.linkCard(epic.id, child.id, 'parent_of');
    }

    const details = await cardService.getById(epic.id);
    expect(details.epic_progress).toEqual({ total: 4, done: 2 });
  });

  it('a card can be flagged terminal after children are already linked, and progress reflects it live', async () => {
    const { todo, done } = await setupBoard();
    const epic = await cardService.create({ column_id: todo.id, title: 'Epic', is_epic: true });
    const child = await cardService.create({ column_id: done.id, title: 'Child' });
    await cardService.linkCard(epic.id, child.id, 'parent_of');

    expect((await cardService.getById(epic.id)).epic_progress).toEqual({ total: 1, done: 0 });

    await columnService.update(done.id, { is_terminal: true, confirm_impact: true });
    expect((await cardService.getById(epic.id)).epic_progress).toEqual({ total: 1, done: 1 });
  });

  it('multiple terminal columns on the same board all count toward done', async () => {
    const { todo, inProgress, done } = await setupBoard();
    await columnService.update(inProgress.id, { is_terminal: true }); // e.g. an "archived" lane, unusually
    await columnService.update(done.id, { is_terminal: true, confirm_impact: true });

    const epic = await cardService.create({ column_id: todo.id, title: 'Epic', is_epic: true });
    const childA = await cardService.create({ column_id: inProgress.id, title: 'A' });
    const childB = await cardService.create({ column_id: done.id, title: 'B' });
    const childC = await cardService.create({ column_id: todo.id, title: 'C' });
    for (const child of [childA, childB, childC]) {
      await cardService.linkCard(epic.id, child.id, 'parent_of');
    }

    const details = await cardService.getById(epic.id);
    expect(details.epic_progress).toEqual({ total: 3, done: 2 });
  });

  it('marking a column terminal does not change a card\'s position or column', async () => {
    const { todo, done } = await setupBoard();
    const card = await cardService.create({ column_id: done.id, title: 'Untouched card' });

    await columnService.update(done.id, { is_terminal: true, confirm_impact: true });

    const refreshed = await cardService.getById(card.id);
    expect(refreshed.column_id).toBe(done.id);
    expect(refreshed.position).toBe(card.position);
  });

  it('non-child links (blocks, related) on an Epic do not count toward its progress', async () => {
    const { todo, done } = await setupBoard();
    await columnService.update(done.id, { is_terminal: true, confirm_impact: true });

    const epic = await cardService.create({ column_id: todo.id, title: 'Epic', is_epic: true });
    const blocker = await cardService.create({ column_id: done.id, title: 'Unrelated blocker' });
    await cardService.linkCard(epic.id, blocker.id, 'blocks');

    const details = await cardService.getById(epic.id);
    expect(details.epic_progress).toBeNull();
  });
});
import { createCardServiceForTest } from './support/card-service.js';
