import type { DatabaseAdapter } from '../../db/adapter.js';
import { config } from '../../config/index.js';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../../shared/auth-context.js';
import { NotFoundError } from '../../shared/errors.js';

export type WorkspaceResource =
  | 'project'
  | 'board'
  | 'column'
  | 'card'
  | 'comment'
  | 'document'
  | 'label'
  | 'agent'
  | 'role'
  | 'knowledge_base'
  | 'kb_entity'
  | 'kb_fact'
  | 'kb_relation';

const RESOURCE_WORKSPACE_QUERIES: Record<WorkspaceResource, string> = {
  project: 'SELECT workspace_id FROM project WHERE id = ?',
  board: `SELECT p.workspace_id FROM board b JOIN project p ON p.id = b.project_id WHERE b.id = ?`,
  column: `SELECT p.workspace_id FROM "column" c JOIN board b ON b.id = c.board_id JOIN project p ON p.id = b.project_id WHERE c.id = ?`,
  card: `SELECT p.workspace_id FROM card c JOIN "column" col ON col.id = c.column_id JOIN board b ON b.id = col.board_id JOIN project p ON p.id = b.project_id WHERE c.id = ?`,
  comment: `SELECT p.workspace_id FROM comment c JOIN card ca ON ca.id = c.card_id JOIN "column" col ON col.id = ca.column_id JOIN board b ON b.id = col.board_id JOIN project p ON p.id = b.project_id WHERE c.id = ?`,
  document: `SELECT p.workspace_id FROM document d JOIN project p ON p.id = d.project_id WHERE d.id = ?`,
  label: `SELECT p.workspace_id FROM label l JOIN board b ON b.id = l.board_id JOIN project p ON p.id = b.project_id WHERE l.id = ?`,
  agent: 'SELECT workspace_id FROM agent WHERE id = ?',
  role: 'SELECT workspace_id FROM role WHERE id = ?',
  knowledge_base: `SELECT DISTINCT p.workspace_id FROM knowledge_base kb JOIN project_knowledge_base pkb ON pkb.kb_id = kb.id JOIN project p ON p.id = pkb.project_id WHERE kb.id = ?`,
  kb_entity: `SELECT DISTINCT p.workspace_id FROM kb_entity e JOIN project_knowledge_base pkb ON pkb.kb_id = e.kb_id JOIN project p ON p.id = pkb.project_id WHERE e.id = ?`,
  kb_fact: `SELECT DISTINCT p.workspace_id FROM kb_fact f JOIN project_knowledge_base pkb ON pkb.kb_id = f.kb_id JOIN project p ON p.id = pkb.project_id WHERE f.id = ?`,
  kb_relation: `SELECT DISTINCT p.workspace_id FROM kb_relation r JOIN kb_entity e ON e.id = r.source_entity_id JOIN project_knowledge_base pkb ON pkb.kb_id = e.kb_id JOIN project p ON p.id = pkb.project_id WHERE r.id = ?`,
};

/**
 * Return the authenticated workspace in enforced mode. Open mode intentionally
 * returns null when no workspace was supplied so existing local scripts keep
 * their single-operator behavior.
 */
export function workspaceIdFor(auth: AuthContext = OPEN_AUTH_CONTEXT): string | null {
  if (config.auth.mode === 'open') return auth.workspace_id;
  if (!auth.is_workspace_member || !auth.workspace_id) {
    throw new NotFoundError('Resource not found');
  }
  return auth.workspace_id;
}

/** Assert a caller-selected workspace parameter is exactly the authenticated workspace. */
export function assertWorkspace(auth: AuthContext, workspaceId: string): void {
  const scoped = workspaceIdFor(auth);
  if (scoped !== null && scoped !== workspaceId) throw new NotFoundError('Resource not found');
}

/**
 * Resolve resource ownership through its parent chain and refuse foreign IDs
 * with the same not-found response used for missing IDs.
 */
export async function assertResourceWorkspace(
  db: DatabaseAdapter,
  auth: AuthContext,
  resource: WorkspaceResource,
  id: string,
): Promise<void> {
  const scoped = workspaceIdFor(auth);
  if (scoped === null) return;
  const rows = await db.query<{ workspace_id: string | null }>(RESOURCE_WORKSPACE_QUERIES[resource], [id]);
  const workspaces = new Set(rows.map(row => row.workspace_id).filter((value): value is string => Boolean(value)));
  if (workspaces.size !== 1 || !workspaces.has(scoped)) throw new NotFoundError('Resource not found');
}

/** Assert all resources exist in the caller's one workspace before mutating any of them. */
export async function assertResourcesWorkspace(
  db: DatabaseAdapter,
  auth: AuthContext,
  resources: Array<[WorkspaceResource, string]>,
): Promise<void> {
  for (const [resource, id] of resources) {
    await assertResourceWorkspace(db, auth, resource, id);
  }
}

/** Reject mixed-workspace relationships even in permissive local/open mode. */
export async function assertResourcesShareWorkspace(
  db: DatabaseAdapter,
  resources: Array<[WorkspaceResource, string]>,
): Promise<void> {
  const owners = new Set<string>();
  for (const [resource, id] of resources) {
    const rows = await db.query<{ workspace_id: string | null }>(RESOURCE_WORKSPACE_QUERIES[resource], [id]);
    const workspaces = new Set(rows.map(row => row.workspace_id).filter((value): value is string => Boolean(value)));
    // Local/open-mode agents and a just-created KB predate workspace linkage.
    // Treat that legacy unscoped side as local-only compatibility, while any
    // two concrete workspace owners must still agree. Enforced mode never
    // permits an unowned selector through this boundary.
    if (workspaces.size === 0 && config.auth.mode === 'open') continue;
    if (workspaces.size !== 1) throw new NotFoundError('Resource not found');
    owners.add([...workspaces][0]);
  }
  if (owners.size !== 1) throw new NotFoundError('Resource not found');
}
