// File: src/services/column.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Column, CreateColumn, UpdateColumn } from '../shared/types.js';
import { EventService } from './event.service.js';
import { rankAfter } from '../shared/lexorank.js';

export class ColumnService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService
  ) {}

  async create(data: CreateColumn, actorId?: string, adapter?: DatabaseAdapter): Promise<Column> {
    if (!adapter) return this.db.transaction(tx => this.create(data, actorId, tx));
    const db = adapter;
    const id = ulid();

    let position = data.position;
    if (!position) {
      const cols = await db.query<Column>('SELECT * FROM "column" WHERE board_id = ? ORDER BY position ASC', [data.board_id]);
      const lastPos = cols.length > 0 ? cols[cols.length - 1].position : '';
      position = rankAfter(lastPos);
    }

    const wip_limit = data.wip_limit !== undefined ? data.wip_limit : null;
    const is_terminal = data.is_terminal ? 1 : 0;

    await db.execute(
      `INSERT INTO "column" (id, board_id, name, position, wip_limit, is_terminal)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, data.board_id, data.name, position, wip_limit, is_terminal]
    );

    const col: Column = {
      id,
      board_id: data.board_id,
      name: data.name,
      position,
      wip_limit,
      is_terminal,
    };

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
    return this.db.query<Column>('SELECT * FROM "column" WHERE board_id = ? ORDER BY position ASC', [boardId]);
  }

  async update(id: string, data: UpdateColumn, actorId?: string, adapter?: DatabaseAdapter): Promise<Column> {
    if (!adapter) return this.db.transaction(tx => this.update(id, data, actorId, tx));
    const db = adapter;
    const rows = await db.query<Column>('SELECT * FROM "column" WHERE id = ?', [id]);
    const existing = rows[0] || null;
    if (!existing) throw new Error(`Column with ID ${id} not found`);

    const name = data.name !== undefined ? data.name : existing.name;
    const wip_limit = data.wip_limit !== undefined ? data.wip_limit : existing.wip_limit;
    const position = data.position !== undefined ? data.position : existing.position;
    const is_terminal = data.is_terminal !== undefined ? (data.is_terminal ? 1 : 0) : existing.is_terminal;

    await db.execute(
      'UPDATE "column" SET name = ?, wip_limit = ?, position = ?, is_terminal = ? WHERE id = ?',
      [name, wip_limit, position, is_terminal, id]
    );

    const updated: Column = { ...existing, name, wip_limit, position, is_terminal };

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
