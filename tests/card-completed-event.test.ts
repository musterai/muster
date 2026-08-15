// File: tests/card-completed-event.test.ts
// MUS-45: when a card is moved into a terminal (Done) lane, the server emits a
// dedicated `completed` event so the human operator can be alerted. These
// tests pin that behaviour: only real cross-column moves into a terminal lane
// produce the event, and it carries the card key/title and the target lane.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import {
  ProjectService,
  BoardService,
  ColumnService,
  CardService,
  AgentService,
  EventService,
} from '../src/services/index.js';
import type { Event } from '../src/shared/types.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-card-completed.db');

describe('card completion event (MUS-45)', () => {
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
      ['test-ws-completed', 'Completed Test Workspace', 'completed', now, now],
    );

    eventService = new EventService(db);
    boardService = new BoardService(db, eventService);
    projectService = new ProjectService(db, eventService, boardService);
    columnService = new ColumnService(db, eventService);
    cardService = new CardService(db, eventService);
    agentService = new AgentService(db, eventService);
  });

  afterEach(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('emits a `completed` event when a card is moved into the Done lane', async () => {
    const project = await projectService.create({ name: 'Completion' });
    const [board] = await boardService.list(project.id);
    const cols = await columnService.list(board.id);
    const todo = cols.find(c => c.name === 'To Do')!;
    const done = cols.find(c => c.name === 'Done')!;
    expect(done.is_terminal).toBe(1);

    const agent = await agentService.register({ name: 'scout' });
    const card = await cardService.create({ column_id: todo.id, title: 'Ship the feature' });
    const moved = await cardService.move(card.id, { target_column_id: done.id }, agent.id);
    expect(moved.column_id).toBe(done.id);

    const events = await eventService.list(project.id, { entity_type: 'card', entity_id: card.id });
    const completed = events.find(e => e.action === 'completed');
    expect(completed).toBeDefined();
    expect(completed!.actor_id).toBe(agent.id);
    expect(completed!.payload).toMatchObject({
      card_key: card.key,
      card_title: 'Ship the feature',
      to_column_id: done.id,
      to_column_name: 'Done',
    });
  });

  it('does not emit a `completed` event for moves into a non-terminal lane', async () => {
    const project = await projectService.create({ name: 'Completion' });
    const [board] = await boardService.list(project.id);
    const cols = await columnService.list(board.id);
    const todo = cols.find(c => c.name === 'To Do')!;
    const inProgress = cols.find(c => c.name === 'In Progress')!;

    const agent = await agentService.register({ name: 'scout' });
    const card = await cardService.create({ column_id: todo.id, title: 'WIP work' });
    await cardService.move(card.id, { target_column_id: inProgress.id }, agent.id);

    const events = await eventService.list(project.id, { entity_type: 'card', entity_id: card.id });
    expect(events.some(e => e.action === 'completed')).toBe(false);
  });

  it('does not emit a `completed` event when reordering within the Done lane', async () => {
    const project = await projectService.create({ name: 'Completion' });
    const [board] = await boardService.list(project.id);
    const cols = await columnService.list(board.id);
    const done = cols.find(c => c.name === 'Done')!;

    const agent = await agentService.register({ name: 'scout' });
    const card = await cardService.create({ column_id: done.id, title: 'Already done' });
    // Reorder within the terminal lane — same column, so no cross-column move.
    await cardService.move(card.id, { target_column_id: done.id, position: 'z' }, agent.id);

    const events = await eventService.list(project.id, { entity_type: 'card', entity_id: card.id });
    expect(events.some(e => e.action === 'completed')).toBe(false);
  });

  it('fan-out: an EventService listener (SSE broadcaster) receives the `completed` event', async () => {
    const project = await projectService.create({ name: 'Completion' });
    const [board] = await boardService.list(project.id);
    const cols = await columnService.list(board.id);
    const todo = cols.find(c => c.name === 'To Do')!;
    const done = cols.find(c => c.name === 'Done')!;

    const received: Event[] = [];
    const service = new EventService(db, (evt) => { received.push(evt); });
    const cards = new CardService(db, service);

    const card = await cards.create({ column_id: todo.id, title: 'Fan out' });
    await cards.move(card.id, { target_column_id: done.id });

    const completed = received.find(e => e.action === 'completed');
    expect(completed).toBeDefined();
    expect(completed!.entity_id).toBe(card.id);
    expect(completed!.payload).toMatchObject({ card_key: card.key });
  });
});