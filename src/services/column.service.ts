// File: src/services/column.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Column, CreateColumn, UpdateColumn } from '../shared/types.js';
import { EventService } from './event.service.js';
import { isValidRankHint, rebalanceRanks } from '../shared/lexorank.js';
import { ValidationError } from '../shared/errors.js';

export class ColumnService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService
  ) {}

  /**
   * Column positions share the card insertion-hint contract. A legacy `0a`
   * hint is accepted at the API boundary, then replaced by a canonical rank
   * before the transaction commits; arbitrary punctuation must never reach
   * the persisted ordering column.
   */
  private assertPosition(position: string | undefined): void {
    if (position !== undefined && !isValidRankHint(position)) {
      throw new ValidationError('position must contain only lowercase letters a-z', {
        field: 'position',
        code: 'INVALID_RANK',
      });
    }
  }

  private async orderedColumns(boardId: string, db: DatabaseAdapter): Promise<Column[]> {
    return db.query<Column>(
      'SELECT * FROM "column" WHERE board_id = ? ORDER BY position ASC, id ASC',
      [boardId],
    );
  }

  private async lockBoard(boardId: string, db: DatabaseAdapter): Promise<void> {
    if (db.dialect === 'postgres') {
      await db.query<{ id: string }>('SELECT id FROM board WHERE id = ? FOR UPDATE', [boardId]);
    }
  }

  private orderWithPosition(columns: Column[], column: Column, position?: string): Column[] {
    const ordered = [...columns];
    if (position === undefined) {
      ordered.push(column);
      return ordered;
    }
    const index = ordered.findIndex(existing => existing.position > position);
    ordered.splice(index === -1 ? ordered.length : index, 0, column);
    return ordered;
  }

  private async rebalanceBoard(db: DatabaseAdapter, columns: Column[]): Promise<string[]> {
    const ranks = rebalanceRanks(columns.length);
    for (let index = 0; index < columns.length; index++) {
      await db.execute('UPDATE "column" SET position = ? WHERE id = ?', [ranks[index], columns[index].id]);
    }
    return ranks;
  }

  async create(data: CreateColumn, actorId?: string, adapter?: DatabaseAdapter): Promise<Column> {
    if (!adapter) return this.db.transaction(tx => this.create(data, actorId, tx));

    const db = adapter;
    const id = ulid();
    this.assertPosition(data.position);
    const wip_limit = data.wip_limit !== undefined ? data.wip_limit : null;
    const is_terminal = data.is_terminal ? 1 : 0;

    await this.lockBoard(data.board_id, db);
    const columns = await this.orderedColumns(data.board_id, db);
    const draft: Column = {
      id,
      board_id: data.board_id,
      name: data.name,
      position: 'm',
      wip_limit,
      is_terminal,
    };
    const ordered = this.orderWithPosition(columns, draft, data.position);

    await db.execute(
      `INSERT INTO "column" (id, board_id, name, position, wip_limit, is_terminal)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, data.board_id, data.name, 'm', wip_limit, is_terminal]
    );

    const ranks = await this.rebalanceBoard(db, ordered);
    const position = ranks[ordered.findIndex(column => column.id === id)];
    const col: Column = { ...draft, position };

    if (this.eventService) {
      const boardRows = await db.query<{ project_id: string }>('SELECT project_id FROM board WHERE id = ?', [data.board_id]);
      if (boardRows[0]) {
        await this.eventService.create({
          project_id: boardRows[0].project_id,
          entity_type: 'column',
          entity_id: id,
          action: 'created',
          actor_id: actorId,
          payload: { name: col.name, board_id: col.board_id },
        }, db);
      }
    }

    return col;
  }

  async getById(id: string): Promise<Column | null> {
    const rows = await this.db.query<Column>('SELECT * FROM "column" WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async list(boardId: string): Promise<Column[]> {
    return this.db.query<Column>('SELECT * FROM "column" WHERE board_id = ? ORDER BY position ASC, id ASC', [boardId]);
  }

  async update(id: string, data: UpdateColumn, actorId?: string, adapter?: DatabaseAdapter): Promise<Column> {
    if (!adapter) return this.db.transaction(tx => this.update(id, data, actorId, tx));

    const db = adapter;
    this.assertPosition(data.position);
    const hintRows = await db.query<Pick<Column, 'board_id'>>('SELECT board_id FROM "column" WHERE id = ?', [id]);
    const hint = hintRows[0];
    if (!hint) throw new Error(`Column with ID ${id} not found`);
    await this.lockBoard(hint.board_id, db);

    const lockClause = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const rows = await db.query<Column>(`SELECT * FROM "column" WHERE id = ?${lockClause}`, [id]);
    const existing = rows[0];
    if (!existing) throw new Error(`Column with ID ${id} not found`);

    const name = data.name !== undefined ? data.name : existing.name;
    const wip_limit = data.wip_limit !== undefined ? data.wip_limit : existing.wip_limit;
    const is_terminal = data.is_terminal !== undefined ? (data.is_terminal ? 1 : 0) : existing.is_terminal;
    const draft: Column = { ...existing, name, wip_limit, is_terminal, position: 'm' };
    const columns = await this.orderedColumns(existing.board_id, db);
    const withoutExisting = columns.filter(column => column.id !== id);
    let ordered: Column[];
    if (data.position === undefined) {
      const oldIndex = columns.findIndex(column => column.id === id);
      ordered = [...columns];
      ordered[oldIndex] = draft;
    } else {
      ordered = this.orderWithPosition(withoutExisting, draft, data.position);
    }

    await db.execute(
      'UPDATE "column" SET name = ?, wip_limit = ?, position = ?, is_terminal = ? WHERE id = ?',
      [name, wip_limit, 'm', is_terminal, id]
    );

    const ranks = await this.rebalanceBoard(db, ordered);
    const position = ranks[ordered.findIndex(column => column.id === id)];
    const updated: Column = { ...draft, position };

    if (this.eventService) {
      const boardRows = await db.query<{ project_id: string }>('SELECT project_id FROM board WHERE id = ?', [existing.board_id]);
      if (boardRows[0]) {
        await this.eventService.create({
          project_id: boardRows[0].project_id,
          entity_type: 'column',
          entity_id: id,
          action: 'updated',
          actor_id: actorId,
          payload: data as Record<string, unknown>,
        }, db);
      }
    }

    return updated;
  }

  async delete(id: string, actorId?: string, adapter?: DatabaseAdapter): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.delete(id, actorId, tx));
    const db = adapter;
    const rows = await db.query<Column>('SELECT * FROM "column" WHERE id = ?', [id]);
    const existing = rows[0] || null;
    if (!existing) throw new Error(`Column with ID ${id} not found`);

    const cards = await db.query<{ count: number }>('SELECT COUNT(*) as count FROM card WHERE column_id = ? AND archived = 0', [id]);
    if (Number(cards[0]?.count || 0) > 0) {
      throw new Error(`Cannot delete column ${id} because it contains active cards.`);
    }

    await db.execute('DELETE FROM "column" WHERE id = ?', [id]);

    if (this.eventService) {
      const boardRows = await db.query<{ project_id: string }>('SELECT project_id FROM board WHERE id = ?', [existing.board_id]);
      if (boardRows[0]) {
        await this.eventService.create({
          project_id: boardRows[0].project_id,
          entity_type: 'column',
          entity_id: id,
          action: 'deleted',
          actor_id: actorId,
        }, db);
      }
    }
  }
}
