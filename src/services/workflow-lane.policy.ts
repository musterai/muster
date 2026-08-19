import type { DatabaseAdapter } from '../db/adapter.js';
import {
  COLUMN_WORKFLOW_ROLES,
  isColumnWorkflowRole,
  type ColumnWorkflowRole,
  type WorkflowConfigState,
} from '../shared/workflow-lane.js';
import type { Column } from '../shared/types.js';
import { CardRuleError, ValidationError } from '../shared/errors.js';

export interface BoardWorkflowSummary {
  workflow_config_state: WorkflowConfigState;
  unclassified_column_ids: string[];
  missing_roles: Array<'active' | 'terminal'>;
}

export interface ActiveLane {
  id: string;
  board_id: string;
  name: string;
  position: string;
  workflow_role: 'active';
}

/**
 * Shared domain policy for persisted workflow roles. Keeping configuration
 * checks here prevents REST, MCP, and direct service callers from acquiring
 * subtly different name-based behavior.
 */
export class WorkflowLanePolicy {
  static readonly roles = COLUMN_WORKFLOW_ROLES;

  static assertRole(value: unknown, field = 'workflow_role'): asserts value is ColumnWorkflowRole {
    if (!isColumnWorkflowRole(value)) {
      throw new ValidationError(`${field} must be one of: ${COLUMN_WORKFLOW_ROLES.join(', ')}`, {
        field,
        code: 'INVALID_WORKFLOW_ROLE',
        allowed_roles: [...COLUMN_WORKFLOW_ROLES],
      });
    }
  }

  static projectionForRole(role: ColumnWorkflowRole | null | undefined): number {
    return role === 'terminal' ? 1 : 0;
  }

  static roleFromCreateInput(
    workflowRole: ColumnWorkflowRole | undefined,
    isTerminal: boolean | number | undefined,
  ): ColumnWorkflowRole {
    const terminal = isTerminal === true || isTerminal === 1;
    if (workflowRole !== undefined) {
      this.assertRole(workflowRole);
      if (isTerminal !== undefined && terminal !== (workflowRole === 'terminal')) {
        throw new ValidationError('is_terminal conflicts with workflow_role', {
          fields: ['is_terminal', 'workflow_role'],
          code: 'WORKFLOW_ROLE_CONFLICT',
        });
      }
      return workflowRole;
    }
    // A true legacy projection is unambiguous. Name-only custom creation is
    // intentionally compatible and defaults to ready. NULL is reserved for
    // migrated legacy rows and is never produced by a service write.
    if (terminal) return 'terminal';
    return 'ready';
  }

  static summarizeColumns(columns: Array<Pick<Column, 'id' | 'workflow_role'>>): BoardWorkflowSummary {
    const unclassified = columns
      .filter(column => !isColumnWorkflowRole(column.workflow_role))
      .map(column => column.id);
    const hasActive = columns.some(column => column.workflow_role === 'active');
    const hasTerminal = columns.some(column => column.workflow_role === 'terminal');
    const missing_roles: Array<'active' | 'terminal'> = [];
    if (!hasActive) missing_roles.push('active');
    if (!hasTerminal) missing_roles.push('terminal');
    return {
      workflow_config_state: unclassified.length === 0 && missing_roles.length === 0
        ? 'configured'
        : 'needs_review',
      unclassified_column_ids: unclassified,
      missing_roles,
    };
  }

  /** Reject a board that cannot enforce workflow semantics. */
  static assertInvariant(columns: Array<Pick<Column, 'id' | 'workflow_role'>>): void {
    const summary = this.summarizeColumns(columns);
    if (summary.workflow_config_state !== 'configured') {
      throw new CardRuleError(
        'WORKFLOW_CONFIGURATION_INVALID',
        'Board columns must all be classified and include at least one active and one terminal lane.',
        {
          rule: 'workflow_configuration',
          missing_roles: summary.missing_roles,
          unclassified_column_ids: summary.unclassified_column_ids,
        },
      );
    }
  }

  /**
   * Required roles may be added while a legacy board is being classified, but
   * once present they cannot be removed. This guard applies even when the
   * board is still `needs_review`, so an operator cannot make an already
   * partially classified board less enforceable while correcting it.
   */
  static assertRequiredRolesRemain(
    current: Array<Pick<Column, 'id' | 'workflow_role'>>,
    prospective: Array<Pick<Column, 'id' | 'workflow_role'>>,
  ): void {
    const removed = (['active', 'terminal'] as const).filter(role =>
      current.some(column => column.workflow_role === role)
      && !prospective.some(column => column.workflow_role === role),
    );
    if (removed.length === 0) return;
    throw new CardRuleError(
      'WORKFLOW_CONFIGURATION_INVALID',
      `Cannot remove the last ${removed.join(' or ')} workflow column.`,
      {
        rule: 'workflow_configuration',
        missing_roles: removed,
        unclassified_column_ids: prospective
          .filter(column => !isColumnWorkflowRole(column.workflow_role))
          .map(column => column.id),
      },
    );
  }

  static async getBoardSummary(boardId: string, db: DatabaseAdapter): Promise<BoardWorkflowSummary> {
    const columns = await db.query<Pick<Column, 'id' | 'workflow_role'>>(
      'SELECT id, workflow_role FROM "column" WHERE board_id = ? ORDER BY position ASC, id ASC',
      [boardId],
    );
    return WorkflowLanePolicy.summarizeColumns(columns);
  }

  static async getColumn(columnId: string, db: DatabaseAdapter): Promise<Column & { board_id: string }> {
    const rows = await db.query<Column & { board_id: string }>(
      'SELECT * FROM "column" WHERE id = ?',
      [columnId],
    );
    if (!rows[0]) throw new ValidationError(`Column with ID ${columnId} not found`);
    return rows[0];
  }

  static async assertConfigured(boardId: string, operation: string, db: DatabaseAdapter): Promise<BoardWorkflowSummary> {
    const summary = await this.getBoardSummary(boardId, db);
    if (summary.workflow_config_state !== 'configured') {
      throw new CardRuleError(
        'WORKFLOW_CONFIGURATION_REQUIRED',
        `Board ${boardId} requires workflow configuration before ${operation}.`,
        {
          rule: 'workflow_configuration',
          operation,
          board_id: boardId,
          workflow_config_state: summary.workflow_config_state,
          unclassified_column_ids: summary.unclassified_column_ids,
          missing_roles: summary.missing_roles,
        },
      );
    }
    return summary;
  }

  static async assertConfiguredForColumn(columnId: string, operation: string, db: DatabaseAdapter): Promise<BoardWorkflowSummary> {
    const column = await this.getColumn(columnId, db);
    return this.assertConfigured(column.board_id, operation, db);
  }

  /** Position then immutable ID makes multiple active lanes deterministic. */
  static async nextActiveLane(boardId: string, db: DatabaseAdapter): Promise<ActiveLane | null> {
    await this.assertConfigured(boardId, 'select the next active lane', db);
    const rows = await db.query<ActiveLane>(
      `SELECT id, board_id, name, position, workflow_role
         FROM "column"
        WHERE board_id = ? AND workflow_role = 'active'
        ORDER BY position ASC, id ASC
        LIMIT 1`,
      [boardId],
    );
    return rows[0] || null;
  }
}
