import type { DatabaseAdapter } from '../db/adapter.js';
import type { AuthContext } from '../shared/auth-context.js';
import { OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import type { KBReadScopeInput, KBReadScopeSummary } from '../shared/types.js';
import { assertResourceWorkspace, workspaceIdFor } from './helpers/workspace-scope.helper.js';

export interface KBReadPredicate {
  sql: string;
  params: unknown[];
}

export interface ResolvedKBReadScope {
  summary: KBReadScopeSummary;
  cursor_key: string;
  predicate(kbIdExpression: string): KBReadPredicate;
}

/**
 * Resolves the one authorized KB scope used by every read transport.
 *
 * Keeping this as a root-owned dependency prevents REST and MCP from growing
 * subtly different interpretations of “all linked and global”.
 */
export class KBReadScopeResolver {
  constructor(private readonly db: DatabaseAdapter) {}

  async resolve(
    input: KBReadScopeInput,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<ResolvedKBReadScope> {
    const hasKb = Boolean(input.kb_id);
    const hasProject = Boolean(input.project_id);
    if (hasKb === hasProject) {
      throw new ValidationError('Exactly one of kb_id or project_id is required', {
        fields: ['kb_id', 'project_id'],
        code: 'KB_SCOPE_REQUIRED',
      });
    }

    const workspaceId = workspaceIdFor(auth);
    if (input.kb_id) {
      await assertResourceWorkspace(this.db, auth, 'knowledge_base', input.kb_id);
      const rows = await this.db.query<{ id: string; name: string }>(
        'SELECT id, name FROM knowledge_base WHERE id = ?',
        [input.kb_id],
      );
      const kb = rows[0];
      if (!kb) throw new NotFoundError('Resource not found');
      return {
        summary: { kind: 'knowledge_base', id: kb.id, name: kb.name, knowledge_base_count: 1 },
        cursor_key: `kb:${kb.id}:workspace:${workspaceId || 'open'}`,
        predicate: (expression) => ({ sql: `${expression} = ?`, params: [kb.id] }),
      };
    }

    const projectId = input.project_id!;
    await assertResourceWorkspace(this.db, auth, 'project', projectId);
    const projects = await this.db.query<{ id: string; name: string }>(
      'SELECT id, name FROM project WHERE id = ?',
      [projectId],
    );
    const project = projects[0];
    if (!project) throw new NotFoundError('Resource not found');

    const predicate = (expression: string): KBReadPredicate => {
      const params: unknown[] = [];
      let authorization = '';
      if (workspaceId) {
        authorization = `
          AND EXISTS (
            SELECT 1 FROM project_knowledge_base owner_link
            JOIN project owner_project ON owner_project.id = owner_link.project_id
            WHERE owner_link.kb_id = scoped_kb.id AND owner_project.workspace_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_knowledge_base foreign_link
            JOIN project foreign_project ON foreign_project.id = foreign_link.project_id
            WHERE foreign_link.kb_id = scoped_kb.id AND foreign_project.workspace_id <> ?
          )`;
        params.push(workspaceId, workspaceId);
      }
      params.push(projectId);
      return {
        sql: `EXISTS (
          SELECT 1 FROM knowledge_base scoped_kb
          WHERE scoped_kb.id = ${expression}
          ${authorization}
          AND (
            scoped_kb.is_global = 1
            OR EXISTS (
              SELECT 1 FROM project_knowledge_base selected_link
              WHERE selected_link.kb_id = scoped_kb.id AND selected_link.project_id = ?
            )
          )
        )`,
        params,
      };
    };

    const countPredicate = predicate('counted_kb.id');
    const counts = await this.db.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM knowledge_base counted_kb WHERE ${countPredicate.sql}`,
      countPredicate.params,
    );
    return {
      summary: {
        kind: 'project',
        id: project.id,
        name: project.name,
        knowledge_base_count: Number(counts[0]?.count || 0),
      },
      cursor_key: `project:${project.id}:workspace:${workspaceId || 'open'}`,
      predicate,
    };
  }
}
