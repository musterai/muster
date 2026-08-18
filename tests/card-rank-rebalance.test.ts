import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { BoardService, CardService, ColumnService, ProjectService } from '../src/services/index.js';
import { isCanonicalRank } from '../src/shared/lexorank.js';
import { EventService } from '../src/services/event.service.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-card-rank-rebalance.db');

describe('transactional card rank rebalancing', () => {
  let db: DatabaseAdapter;
  let projectService: ProjectService;
  let boardService: BoardService;
  let cardService: CardService;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['rank-ws', 'Rank Workspace', 'rank-workspace', now, now],
    );
    boardService = new BoardService(db);
    projectService = new ProjectService(db, undefined, boardService);
    cardService = new CardService(db);
  });

  afterEach(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  async function lanes() {
    const project = await projectService.create({ name: `Rank project ${Date.now()}-${Math.random()}` });
    const board = (await boardService.list(project.id))[0];
    return { board, columns: await db.query<{ id: string }>('SELECT id FROM "column" WHERE board_id = ? ORDER BY position', [board.id]) };
  }

  it('repairs duplicate and legacy positions while preserving lane membership', async () => {
    const { columns } = await lanes();
    const cards = await Promise.all([
      cardService.create({ column_id: columns[0].id, title: 'First' }),
      cardService.create({ column_id: columns[0].id, title: 'Second' }),
      cardService.create({ column_id: columns[0].id, title: 'Third' }),
    ]);
    await db.execute('UPDATE card SET position = ? WHERE id = ?', ['a', cards[0].id]);
    await db.execute('UPDATE card SET position = ? WHERE id = ?', ['a', cards[1].id]);
    await db.execute('UPDATE card SET position = ? WHERE id = ?', ['0a', cards[2].id]);

    await cardService.move(cards[1].id, { target_column_id: columns[0].id, position: 'a' });
    const rows = await db.query<{ id: string; column_id: string; position: string }>(
      'SELECT id, column_id, position FROM card WHERE column_id = ? ORDER BY position',
      [columns[0].id],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.column_id === columns[0].id && isCanonicalRank(row.position))).toBe(true);
    expect(new Set(rows.map(row => row.position)).size).toBe(rows.length);
  });

  it('rejects unsafe external position hints before changing either lane', async () => {
    const { columns } = await lanes();
    const card = await cardService.create({ column_id: columns[0].id, title: 'Unsafe hint' });
    await expect(cardService.move(card.id, { target_column_id: columns[1].id, position: 'a-b' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const unchanged = await cardService.getById(card.id);
    expect(unchanged.column_id).toBe(columns[0].id);
  });

  it('serializes concurrent moves into unique canonical ranks in the target lane', async () => {
    const { columns } = await lanes();
    const cards = await Promise.all(Array.from({ length: 24 }, (_, i) =>
      cardService.create({ column_id: columns[0].id, title: `Concurrent ${i}` }),
    ));
    await Promise.all(cards.map((card, index) =>
      cardService.move(card.id, { target_column_id: columns[1].id, position: index % 2 === 0 ? 'a' : 'z' }),
    ));
    const rows = await db.query<{ id: string; position: string }>(
      'SELECT id, position FROM card WHERE column_id = ? ORDER BY position',
      [columns[1].id],
    );
    expect(rows).toHaveLength(cards.length);
    expect(new Set(rows.map(row => row.position)).size).toBe(cards.length);
    expect(rows.every(row => isCanonicalRank(row.position))).toBe(true);

    // The concurrent requests use two explicit insertion intents. Regardless
    // of which transaction reaches SQLite first, every front insertion must
    // remain before every append insertion after the lane is rebalanced.
    const rankById = new Map(rows.map(row => [row.id, row.position]));
    const frontRanks = cards.filter((_, index) => index % 2 === 0).map(card => rankById.get(card.id)!);
    const appendRanks = cards.filter((_, index) => index % 2 === 1).map(card => rankById.get(card.id)!);
    const lastFrontRank = frontRanks.reduce((max, rank) => max > rank ? max : rank);
    const firstAppendRank = appendRanks.reduce((min, rank) => min < rank ? min : rank);
    expect(lastFrontRank < firstAppendRank).toBe(true);
  });

  it('rolls back a terminal move when its completion event fails', async () => {
    const { columns } = await lanes();
    const card = await cardService.create({ column_id: columns[0].id, title: 'Atomic completion' });
    let calls = 0;
    const broadcasts: string[] = [];
    const realEvents = new EventService(db, event => {
      broadcasts.push(event.action);
    });
    const failingEvents = {
      create: async (data: Parameters<EventService['create']>[0], transaction?: DatabaseAdapter) => {
        calls += 1;
        if (calls === 2) throw new Error('completion event write failed');
        return realEvents.create(data, transaction);
      },
    } as unknown as EventService;
    const transactionalService = new CardService(db, failingEvents);

    await expect(transactionalService.move(card.id, { target_column_id: columns[4].id, position: 'z' })).rejects.toThrow(
      'completion event write failed',
    );

    const unchanged = await db.query<{ column_id: string; position: string }>(
      'SELECT column_id, position FROM card WHERE id = ?',
      [card.id],
    );
    expect(unchanged[0].column_id).toBe(columns[0].id);
    expect(isCanonicalRank(unchanged[0].position)).toBe(true);
    const events = await db.query<{ action: string }>('SELECT action FROM event WHERE entity_id = ?', [card.id]);
    expect(events).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  it('rolls back a move and override audit event as one transaction', async () => {
    const { columns } = await lanes();
    await db.execute('UPDATE "column" SET wip_limit = 0 WHERE id = ?', [columns[1].id]);
    const card = await cardService.create({ column_id: columns[0].id, title: 'Atomic override' });
    let calls = 0;
    const failingEvents = {
      create: async () => {
        calls += 1;
        if (calls === 2) throw new Error('override event write failed');
      },
    } as unknown as EventService;
    const transactionalService = new CardService(db, failingEvents);

    await expect(
      transactionalService.move(
        card.id,
        { target_column_id: columns[1].id, position: 'a' },
        'operator-1',
        { operatorOverride: true },
      ),
    ).rejects.toThrow('override event write failed');

    const unchanged = await db.query<{ column_id: string }>('SELECT column_id FROM card WHERE id = ?', [card.id]);
    expect(unchanged[0].column_id).toBe(columns[0].id);
    const events = await db.query<{ action: string }>('SELECT action FROM event WHERE entity_id = ?', [card.id]);
    expect(events).toHaveLength(0);
  });

  it('validates column hints and persists only canonical lane ranks', async () => {
    const { columns } = await lanes();
    const columnService = new ColumnService(db);

    await expect(columnService.update(columns[2].id, { position: 'a-b' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await columnService.update(columns[2].id, { position: '0a' });

    const rows = await db.query<{ id: string; position: string }>(
      'SELECT id, position FROM "column" WHERE board_id = (SELECT board_id FROM "column" WHERE id = ?) ORDER BY position, id',
      [columns[2].id],
    );
    expect(rows[0].id).toBe(columns[2].id);
    expect(rows.every(row => isCanonicalRank(row.position))).toBe(true);
  });

  it('repairs untouched invalid and duplicate ranks during startup migration backfill', async () => {
    const { columns } = await lanes();
    const cards = await Promise.all([
      cardService.create({ column_id: columns[0].id, title: 'Legacy one' }),
      cardService.create({ column_id: columns[0].id, title: 'Legacy two' }),
    ]);
    await db.execute('UPDATE "column" SET position = ? WHERE id IN (?, ?)', ['!', columns[0].id, columns[1].id]);
    await db.execute('UPDATE card SET position = ? WHERE id IN (?, ?)', ['!', cards[0].id, cards[1].id]);

    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();

    const repairedColumns = await db.query<{ position: string }>(
      'SELECT position FROM "column" WHERE board_id = (SELECT board_id FROM "column" WHERE id = ?) ORDER BY position, id',
      [columns[0].id],
    );
    const repairedCards = await db.query<{ position: string }>(
      'SELECT position FROM card WHERE column_id = ? ORDER BY position, id',
      [columns[0].id],
    );
    expect(repairedColumns.every(row => isCanonicalRank(row.position))).toBe(true);
    expect(new Set(repairedColumns.map(row => row.position)).size).toBe(repairedColumns.length);
    expect(repairedCards.every(row => isCanonicalRank(row.position))).toBe(true);
    expect(new Set(repairedCards.map(row => row.position)).size).toBe(repairedCards.length);
  });
});
