import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { BoardService, CardService, ProjectService } from '../src/services/index.js';
import { isCanonicalRank } from '../src/shared/lexorank.js';

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
  });
});
