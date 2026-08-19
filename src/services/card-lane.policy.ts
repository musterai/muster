import type { DatabaseAdapter } from '../db/adapter.js';
import type { Card, MoveCard } from '../shared/types.js';
import { isValidRankHint, rebalanceRanks } from '../shared/lexorank.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import type { ColumnWorkflowRole, WorkflowConfigState } from '../shared/workflow-lane.js';
import { WorkflowLanePolicy } from './workflow-lane.policy.js';

export interface ColumnCapacity {
  id: string;
  name: string;
  wip_limit: number | null;
  card_count: number;
  workflow_role: ColumnWorkflowRole | null;
  board_id: string;
  workflow_config_state: WorkflowConfigState;
  is_terminal: number;
}

export interface UnresolvedBlocker {
  id: string;
  key: string;
  title: string;
  column_id: string;
  column_name: string;
}

/**
 * Ordering, WIP, and blocker rules for a card lane. Transaction ownership
 * stays with CardService: callers must pass the transaction-scoped adapter
 * to every database-backed operation.
 */
export class CardLanePolicy {
  constructor(private readonly db: DatabaseAdapter) {}

  assertPosition(position: string | undefined): void {
    if (position !== undefined && !isValidRankHint(position)) {
      throw new ValidationError('position must contain only lowercase letters a-z', {
        field: 'position',
        code: 'INVALID_RANK',
      });
    }
  }

  assertMoveIntent(data: MoveCard): void {
    if (data.target_column_id === undefined && data.position === undefined) {
      throw new ValidationError('target_column_id or position is required', {
        fields: ['target_column_id', 'position'],
        code: 'MOVE_INTENT_REQUIRED',
      });
    }
    if (data.target_column_id !== undefined && (typeof data.target_column_id !== 'string' || data.target_column_id.trim().length === 0)) {
      throw new ValidationError('target_column_id must be a non-empty string', {
        field: 'target_column_id',
        code: 'INVALID_TARGET_COLUMN',
      });
    }
    if (data.position !== undefined && typeof data.position !== 'string') {
      throw new ValidationError('position must be a string', {
        field: 'position',
        code: 'INVALID_RANK',
      });
    }
    this.assertPosition(data.position);
  }

  async rebalanceLane(db: DatabaseAdapter, cards: Card[]): Promise<string[]> {
    const ranks = rebalanceRanks(cards.length);
    for (let index = 0; index < cards.length; index++) {
      await db.execute('UPDATE card SET position = ? WHERE id = ?', [ranks[index], cards[index].id]);
    }
    return ranks;
  }

  async orderedLaneCards(columnId: string, db: DatabaseAdapter, excludeId?: string): Promise<Card[]> {
    const cards = await db.query<Card>(
      'SELECT * FROM card WHERE column_id = ? AND archived = 0 ORDER BY position ASC, id ASC',
      [columnId],
    );
    return excludeId ? cards.filter((card) => card.id !== excludeId) : cards;
  }

  orderWithPosition(cards: Card[], card: Card, position?: string): Card[] {
    const ordered = [...cards];
    let insertAt = ordered.length;
    if (position !== undefined) {
      const index = ordered.findIndex((existing) => existing.position > position);
      insertAt = index === -1 ? ordered.length : index;
    }
    ordered.splice(insertAt, 0, card);
    return ordered;
  }

  async getColumnCapacity(columnId: string, db: DatabaseAdapter = this.db): Promise<ColumnCapacity> {
    if (db.dialect === 'postgres') {
      await db.query<{ id: string }>('SELECT id FROM "column" WHERE id = ? FOR UPDATE', [columnId]);
    }
    const rows = await db.query<{
      id: string;
      board_id: string;
      name: string;
      wip_limit: number | null;
      card_count: number | string;
      workflow_role: ColumnWorkflowRole | null;
      workflow_config_state: WorkflowConfigState;
      is_terminal: number | string;
    }>(
      `SELECT col.id, col.board_id, col.name, col.wip_limit, col.workflow_role,
              CASE WHEN (
                NOT EXISTS (SELECT 1 FROM "column" cfg WHERE cfg.board_id = col.board_id
                  AND (cfg.workflow_role IS NULL OR cfg.workflow_role NOT IN ('backlog', 'ready', 'active', 'review', 'terminal')))
                AND EXISTS (SELECT 1 FROM "column" cfg WHERE cfg.board_id = col.board_id AND cfg.workflow_role = 'active')
                AND EXISTS (SELECT 1 FROM "column" cfg WHERE cfg.board_id = col.board_id AND cfg.workflow_role = 'terminal')
              ) THEN 'configured' ELSE 'needs_review' END AS workflow_config_state,
              col.is_terminal, COUNT(c.id) AS card_count
       FROM "column" col
       LEFT JOIN card c ON c.column_id = col.id AND c.archived = 0
       WHERE col.id = ?
       GROUP BY col.id, col.board_id, col.name, col.wip_limit, col.workflow_role, col.is_terminal`,
      [columnId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError(`Column with ID ${columnId} not found`);
    return { ...row, card_count: Number(row.card_count), is_terminal: Number(row.is_terminal) };
  }

  async assertWorkflowConfigured(columnId: string, operation: string, db: DatabaseAdapter = this.db): Promise<void> {
    const rows = await db.query<{ board_id: string }>('SELECT board_id FROM "column" WHERE id = ?', [columnId]);
    if (!rows[0]) throw new NotFoundError(`Column with ID ${columnId} not found`);
    await WorkflowLanePolicy.assertConfigured(rows[0].board_id, operation, db);
  }

  async nextActiveLane(boardId: string, db: DatabaseAdapter = this.db) {
    return WorkflowLanePolicy.nextActiveLane(boardId, db);
  }

  getUnresolvedBlockers(cardId: string, db: DatabaseAdapter = this.db): Promise<UnresolvedBlocker[]> {
    return db.query<UnresolvedBlocker>(
      `SELECT blocker.id, blocker.key, blocker.title, blocker.column_id, blocker_column.name AS column_name
       FROM card_link link
       JOIN card blocker ON blocker.id = link.source_card_id
       JOIN "column" blocker_column ON blocker_column.id = blocker.column_id
       WHERE link.target_card_id = ?
         AND link.relation_type = 'blocks'
         AND blocker.archived = 0
         AND (blocker_column.workflow_role IS NULL OR blocker_column.workflow_role <> 'terminal')
       ORDER BY blocker.position ASC`,
      [cardId],
    );
  }
}
