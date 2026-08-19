// File: src/services/column.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Column, CreateColumn, UpdateColumn } from '../shared/types.js';
import { EventService } from './event.service.js';
import { isValidRankHint, rebalanceRanks } from '../shared/lexorank.js';
import { CardRuleError, ValidationError } from '../shared/errors.js';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import { assertResourceWorkspace } from './helpers/workspace-scope.helper.js';
import { WorkflowLanePolicy } from './workflow-lane.policy.js';
import type { AuditService } from './audit.service.js';

export class ColumnService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService,
    private auditService?: AuditService,
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

  async create(data: CreateColumn, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Column> {
    if (!adapter) return this.db.transaction(tx => this.create(data, actorId, tx, auth));

    const db = adapter;
    await assertResourceWorkspace(db, auth, 'board', data.board_id);
    const id = ulid();
    this.assertPosition(data.position);
    const wip_limit = data.wip_limit !== undefined ? data.wip_limit : null;
    const workflow_role = WorkflowLanePolicy.roleFromCreateInput(data.workflow_role, data.is_terminal);
    const is_terminal = WorkflowLanePolicy.projectionForRole(workflow_role);

    await this.lockBoard(data.board_id, db);
    const columns = await this.orderedColumns(data.board_id, db);
    const draft: Column = {
      id,
      board_id: data.board_id,
      name: data.name,
      position: 'm',
      wip_limit,
      workflow_role,
      is_terminal,
    };
    const ordered = this.orderWithPosition(columns, draft, data.position);

    await db.execute(
      `INSERT INTO "column" (id, board_id, name, position, wip_limit, workflow_role, is_terminal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, data.board_id, data.name, 'm', wip_limit, workflow_role, is_terminal]
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
          payload: { name: col.name, board_id: col.board_id, workflow_role: col.workflow_role },
        }, db);
      }
    }

    if (this.auditService) {
      await this.auditService.logAs(auth, {
        action: 'column.workflow_role_created',
        target_type: 'column',
        target_id: id,
        payload: { workflow_role, card_count: 0 },
      }, db);
    }

    return col;
  }

  async getById(id: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Column | null> {
    await assertResourceWorkspace(this.db, auth, 'column', id);
    const rows = await this.db.query<Column>('SELECT * FROM "column" WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async list(boardId: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Column[]> {
    await assertResourceWorkspace(this.db, auth, 'board', boardId);
    return this.db.query<Column>('SELECT * FROM "column" WHERE board_id = ? ORDER BY position ASC, id ASC', [boardId]);
  }

  async update(id: string, data: UpdateColumn, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Column> {
    if (!adapter) return this.db.transaction(tx => this.update(id, data, actorId, tx, auth));

    const db = adapter;
    await assertResourceWorkspace(db, auth, 'column', id);
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
    let workflow_role = existing.workflow_role;
    if (data.workflow_role !== undefined) {
      WorkflowLanePolicy.assertRole(data.workflow_role);
      workflow_role = data.workflow_role;
      if (data.is_terminal !== undefined) {
        const terminal = data.is_terminal === true || data.is_terminal === 1;
        if (terminal !== (workflow_role === 'terminal')) {
          throw new ValidationError('is_terminal conflicts with workflow_role', {
            fields: ['is_terminal', 'workflow_role'],
            code: 'WORKFLOW_ROLE_CONFLICT',
          });
        }
      }
    } else if (data.is_terminal !== undefined) {
      const terminal = data.is_terminal === true || data.is_terminal === 1;
      if (terminal) {
        workflow_role = 'terminal';
      } else {
        // A false compatibility projection confirms that an already
        // non-terminal role remains unchanged. It cannot guess a replacement
        // for a terminal role, nor invent semantics for an unclassified row.
        if (existing.workflow_role === 'terminal') {
          throw new ValidationError('is_terminal:false cannot reclassify a terminal column; provide workflow_role and confirm_impact', {
            fields: ['is_terminal', 'workflow_role'],
            code: 'WORKFLOW_ROLE_CONFLICT',
          });
        }
        workflow_role = existing.workflow_role;
      }
    }
    const is_terminal = WorkflowLanePolicy.projectionForRole(workflow_role);
    const roleChanged = workflow_role !== existing.workflow_role;
    const cardRows = await db.query<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM card WHERE column_id = ?',
      [id],
    );
    const cardCount = Number(cardRows[0]?.count || 0);
    if (roleChanged && cardCount > 0 && data.confirm_impact !== true) {
      throw new CardRuleError(
        'WORKFLOW_IMPACT_CONFIRMATION_REQUIRED',
        `Changing the workflow role of populated column "${existing.name}" can change blocker enforcement, progress, and completion semantics; confirm_impact:true is required.`,
        {
          rule: 'workflow_role_impact',
          operation: 'update',
          column_id: id,
          old_role: existing.workflow_role,
          new_role: workflow_role,
          card_count: cardCount,
          confirm_impact: false,
        },
      );
    }

    const draft: Column = { ...existing, name, wip_limit, workflow_role, is_terminal, position: 'm' };
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

    const prospective = columns.map(column => column.id === id ? draft : column);
    // A legacy/ambiguous board may need several role edits before it becomes
    // configured; only an already configured board must remain valid after a
    // mutation. This keeps operator classification possible while preserving
    // the invariant once the board is live.
    const currentSummary = WorkflowLanePolicy.summarizeColumns(columns);
    WorkflowLanePolicy.assertRequiredRolesRemain(columns, prospective);
    if (currentSummary.workflow_config_state === 'configured') {
      WorkflowLanePolicy.assertInvariant(prospective);
    }

    await db.execute(
      'UPDATE "column" SET name = ?, wip_limit = ?, position = ?, workflow_role = ?, is_terminal = ? WHERE id = ?',
      [name, wip_limit, 'm', workflow_role, is_terminal, id]
    );

    const ranks = await this.rebalanceBoard(db, ordered);
    const position = ranks[ordered.findIndex(column => column.id === id)];
    const updated: Column = { ...draft, position };

    if (this.eventService) {
      const boardRows = await db.query<{ project_id: string }>('SELECT project_id FROM board WHERE id = ?', [existing.board_id]);
      if (boardRows[0]) {
        if (roleChanged) {
          await this.eventService.create({
            project_id: boardRows[0].project_id,
            entity_type: 'column',
            entity_id: id,
            action: 'workflow_role_changed',
            actor_id: actorId,
            payload: {
              column_id: id,
              old_role: existing.workflow_role,
              new_role: workflow_role,
              card_count: cardCount,
            },
          }, db);
        } else {
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
    }

    if (this.auditService && roleChanged) {
      await this.auditService.logAs(auth, {
        action: 'column.workflow_role_changed',
        target_type: 'column',
        target_id: id,
        payload: {
          old_role: existing.workflow_role,
          new_role: workflow_role,
          card_count: cardCount,
          confirm_impact: data.confirm_impact === true,
        },
      }, db);
    }

    return updated;
  }

  async delete(id: string, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.delete(id, actorId, tx, auth));
    const db = adapter;
    await assertResourceWorkspace(db, auth, 'column', id);
    const rows = await db.query<Column>('SELECT * FROM "column" WHERE id = ?', [id]);
    const existing = rows[0] || null;
    if (!existing) throw new Error(`Column with ID ${id} not found`);
    await this.lockBoard(existing.board_id, db);

    const cards = await db.query<{ count: number }>('SELECT COUNT(*) as count FROM card WHERE column_id = ? AND archived = 0', [id]);
    if (Number(cards[0]?.count || 0) > 0) {
      throw new Error(`Cannot delete column ${id} because it contains active cards.`);
    }

    const columns = await this.orderedColumns(existing.board_id, db);
    const currentSummary = WorkflowLanePolicy.summarizeColumns(columns);
    const prospective = columns.filter(column => column.id !== id);
    WorkflowLanePolicy.assertRequiredRolesRemain(columns, prospective);
    if (currentSummary.workflow_config_state === 'configured') {
      WorkflowLanePolicy.assertInvariant(prospective);
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
          payload: { workflow_role: existing.workflow_role },
        }, db);
      }
    }

    if (this.auditService) {
      await this.auditService.logAs(auth, {
        action: 'column.workflow_role_deleted',
        target_type: 'column',
        target_id: id,
        payload: { workflow_role: existing.workflow_role, card_count: 0 },
      }, db);
    }
  }
}
