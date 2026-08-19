// File: tests/card-routes-actor.test.ts
//
// Regression coverage for MUS-17: PUT /cards/:id and PATCH /cards/:id/move
// used to call cardService.update()/move() without the authenticated
// actor, so every card `updated`/`moved` event carried actor_id: null —
// silently breaking self-caused-notification suppression (the operator
// would be "notified" about their own edits since the event never named
// them as the actor).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { CardService, CommentService, EventService } from '../src/services/index.js';
import { createCardRouter } from '../src/api/routes/card.routes.js';
import { AuthContext } from '../src/shared/auth-context.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-card-routes-actor.db');

describe('MUS-17: card routes thread the authenticated actor through to events', () => {
  let db: DatabaseAdapter;
  let eventService: EventService;
  let cardService: CardService;
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;
  let cardId: string;
  const actingUserId = 'user-alice';

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();

    const now = new Date().toISOString();
    await db.execute(
      `INSERT OR IGNORE INTO principal (id, kind, created_at) VALUES (?, ?, ?)`,
      [actingUserId, 'user', now]
    );

    eventService = new EventService(db);
    cardService = createCardServiceForTest(db, eventService);
    const commentService = new CommentService(db, eventService);

    // Seed a project/board/column/card directly via SQL — only the card
    // router is under test here, not project/board creation.
    const projectId = 'proj-1';
    const boardId = 'board-1';
    const columnId = 'col-1';
    const targetColumnId = 'col-2';
    cardId = 'card-1';
    await db.execute(`INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['ws-1', 'WS', 'ws', now, now]);
    await db.execute(`INSERT INTO project (id, workspace_id, name, key_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [projectId, 'ws-1', 'P', 'PRJ', now, now]);
    await db.execute(`INSERT INTO board (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [boardId, projectId, 'Board', now, now]);
    await db.execute(`INSERT INTO "column" (id, board_id, name, position) VALUES (?, ?, ?, ?)`, [columnId, boardId, 'To Do', 'a']);
    await db.execute(`INSERT INTO "column" (id, board_id, name, position) VALUES (?, ?, ?, ?)`, [targetColumnId, boardId, 'Done', 'b']);
    await db.execute(
      `INSERT INTO card (id, key, column_id, title, position, priority, created_at, updated_at, archived, is_epic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      [cardId, 'PRJ-1', columnId, 'Test card', 'm', 'medium', now, now]
    );

    const app = express();
    app.use(express.json());
    // Simulate an authenticated session — the real auth middleware sets
    // exactly this shape on req.authContext once a session/token verifies.
    app.use((req, _res, next) => {
      (req as any).authContext = {
        principal: { kind: 'user', id: actingUserId },
        workspace_id: 'ws-1',
        permissions: [],
        is_operator_override: true,
        role_name: null,
      } satisfies AuthContext;
      next();
    });
    app.use('/api/v1', createCardRouter(cardService, commentService));

    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://localhost:${port}/api/v1`;
  });

  afterEach(async () => {
    server?.close();
    if (db) await db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('PUT /cards/:id attributes the resulting event to the authenticated principal', async () => {
    const res = await fetch(`${baseUrl}/cards/${cardId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'high' }),
    });
    expect(res.status).toBe(200);

    const events = await eventService.list('proj-1');
    const updateEvt = events.find(e => e.entity_type === 'card' && e.action === 'updated');
    expect(updateEvt?.actor_id).toBe(actingUserId);
  });

  it('PATCH /cards/:id/move attributes the resulting event to the authenticated principal', async () => {
    const res = await fetch(`${baseUrl}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_column_id: 'col-2' }),
    });
    expect(res.status).toBe(200);

    const events = await eventService.list('proj-1');
    const moveEvt = events.find(e => e.entity_type === 'card' && e.action === 'moved');
    expect(moveEvt?.actor_id).toBe(actingUserId);
  });

  it('PATCH /cards/:id/move rejects an empty intent without changing the card or events', async () => {
    const before = await db.query<{ column_id: string; position: string; updated_at: string }>(
      'SELECT column_id, position, updated_at FROM card WHERE id = ?', [cardId],
    );
    const res = await fetch(`${baseUrl}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const after = await db.query<{ column_id: string; position: string; updated_at: string }>(
      'SELECT column_id, position, updated_at FROM card WHERE id = ?', [cardId],
    );
    expect(after).toEqual(before);
    expect(await eventService.list('proj-1')).toEqual([]);
  });
});
import { createCardServiceForTest } from './support/card-service.js';
