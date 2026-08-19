/**
 * Stable workflow semantics for board columns.
 *
 * Column names are presentation data and must never be used as an
 * authorization or progress signal. Keep this vocabulary in shared code so
 * REST, MCP, services, migrations, and the SPA cannot drift apart.
 */
export const COLUMN_WORKFLOW_ROLES = [
  'backlog',
  'ready',
  'active',
  'review',
  'terminal',
] as const;

export type ColumnWorkflowRole = typeof COLUMN_WORKFLOW_ROLES[number];

export function isColumnWorkflowRole(value: unknown): value is ColumnWorkflowRole {
  return typeof value === 'string'
    && (COLUMN_WORKFLOW_ROLES as readonly string[]).includes(value);
}

export const TERMINAL_WORKFLOW_ROLE: ColumnWorkflowRole = 'terminal';
export const ACTIVE_WORKFLOW_ROLE: ColumnWorkflowRole = 'active';

export type WorkflowConfigState = 'configured' | 'needs_review';
