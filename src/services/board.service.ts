// File: src/services/board.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Board, CreateBoard, UpdateBoard, Label, CreateLabel } from '../shared/types.js';
import { EventService } from './event.service.js';
import { rankAfter } from '../shared/lexorank.js';
import { deriveSlug } from '../shared/slug.js';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import { assertResourceWorkspace } from './helpers/workspace-scope.helper.js';

export class BoardService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService
  ) {}

  async create(data: CreateBoard, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Board> {
    if (!adapter) {
      return this.db.transaction(tx => this.create(data, actorId, tx, auth));
    }
    const db = adapter;
    await assertResourceWorkspace(db, auth, 'project', data.project_id);
    const id = ulid();
    const created_at = new Date().toISOString();
    const updated_at = created_at;
    const existingSlugs = await db.query<{ slug: string }>(
      `SELECT slug FROM board WHERE project_id = ? AND slug IS NOT NULL`,
      [data.project_id]
    );
    const slug = deriveSlug(data.name, new Set(existingSlugs.map(b => b.slug)));

    await db.execute(
      `INSERT INTO board (id, project_id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, data.project_id, data.name, slug, created_at, updated_at]
    );

    const board: Board = {
      id,
      project_id: data.project_id,
      name: data.name,
      slug,
      created_at,
      updated_at,
    };

    // Default or custom columns
    let defaultCols: { name: string; wip_limit: number | null; is_terminal: boolean }[] = [];

    if (data.columns && data.columns.length > 0) {
      defaultCols = data.columns.map((colName) => ({
        name: colName,
        wip_limit: colName.toLowerCase() === 'in progress' ? 3 : null,
        is_terminal: colName.trim().toLowerCase() === 'done',
      }));
    } else if (data.template === 'simple') {
      defaultCols = [
        { name: 'To Do', wip_limit: null, is_terminal: false },
        { name: 'In Progress', wip_limit: 3, is_terminal: false },
        { name: 'Done', wip_limit: null, is_terminal: true },
      ];
    } else {
      defaultCols = [
        { name: 'Backlog', wip_limit: null, is_terminal: false },
        { name: 'To Do', wip_limit: null, is_terminal: false },
        { name: 'In Progress', wip_limit: 3, is_terminal: false },
        { name: 'In Review', wip_limit: 2, is_terminal: false },
        { name: 'Done', wip_limit: null, is_terminal: true },
      ];
    }

    let lastRank = '';
    for (const col of defaultCols) {
      const colId = ulid();
      const pos = rankAfter(lastRank);
      lastRank = pos;
      await db.execute(
        `INSERT INTO "column" (id, board_id, name, position, wip_limit, is_terminal) VALUES (?, ?, ?, ?, ?, ?)`,
        [colId, id, col.name, pos, col.wip_limit, col.is_terminal ? 1 : 0]
      );
    }

    if (this.eventService) {
      await this.eventService.create({
        project_id: data.project_id,
        entity_type: 'board',
        entity_id: id,
        action: 'created',
        actor_id: actorId,
        payload: { name: board.name },
      }, db);
    }

    return board;
  }

  async getById(id: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Board | null> {
    await assertResourceWorkspace(this.db, auth, 'board', id);
    const rows = await this.db.query<Board>('SELECT * FROM board WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async list(projectId: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Board[]> {
    await assertResourceWorkspace(this.db, auth, 'project', projectId);
    return this.db.query<Board>('SELECT * FROM board WHERE project_id = ? ORDER BY created_at ASC', [projectId]);
  }

  async update(id: string, data: UpdateBoard, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Board> {
    if (!adapter) return this.db.transaction(tx => this.update(id, data, actorId, tx, auth));
    const db = adapter;
    await assertResourceWorkspace(db, auth, 'board', id);
    const rows = await db.query<Board>('SELECT * FROM board WHERE id = ?', [id]);
    const existing = rows[0] || null;
    if (!existing) throw new Error(`Board with ID ${id} not found`);

    const name = data.name !== undefined ? data.name : existing.name;
    const updated_at = new Date().toISOString();
    let slug = existing.slug;

    if (!slug) {
      const existingSlugs = await db.query<{ slug: string }>(
        `SELECT slug FROM board WHERE project_id = ? AND id != ? AND slug IS NOT NULL`,
        [existing.project_id, id]
      );
      slug = deriveSlug(name, new Set(existingSlugs.map(b => b.slug)));
    }

    await db.execute('UPDATE board SET name = ?, slug = ?, updated_at = ? WHERE id = ?', [name, slug, updated_at, id]);

    const updated: Board = { ...existing, name, slug, updated_at };

    if (this.eventService) {
      await this.eventService.create({
        project_id: existing.project_id,
        entity_type: 'board',
        entity_id: id,
        action: 'updated',
        actor_id: actorId,
        payload: { name },
      }, db);
    }

    return updated;
  }

  async delete(id: string, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.delete(id, actorId, tx, auth));
    const db = adapter;
    await assertResourceWorkspace(db, auth, 'board', id);
    const rows = await db.query<Board>('SELECT * FROM board WHERE id = ?', [id]);
    const existing = rows[0] || null;
    if (!existing) throw new Error(`Board with ID ${id} not found`);

    await db.execute('DELETE FROM board WHERE id = ?', [id]);

    if (this.eventService) {
      await this.eventService.create({
        project_id: existing.project_id,
        entity_type: 'board',
        entity_id: id,
        action: 'deleted',
        actor_id: actorId,
      }, db);
    }
  }

  // Label management
  async createLabel(data: CreateLabel, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Label> {
    await assertResourceWorkspace(this.db, auth, 'board', data.board_id);
    const id = ulid();
    await this.db.execute(
      'INSERT INTO label (id, board_id, name, color) VALUES (?, ?, ?, ?)',
      [id, data.board_id, data.name, data.color]
    );
    return { id, board_id: data.board_id, name: data.name, color: data.color };
  }

  async listLabels(boardId: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Label[]> {
    await assertResourceWorkspace(this.db, auth, 'board', boardId);
    return this.db.query<Label>('SELECT * FROM label WHERE board_id = ?', [boardId]);
  }
}
