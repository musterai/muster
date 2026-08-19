// File: src/services/project.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Project, CreateProject, UpdateProject, ProjectSummary } from '../shared/types.js';
import { EventService } from './event.service.js';
import { BoardService } from './board.service.js';
import { DocumentService } from './document.service.js';
import { deriveKeyPrefix } from '../shared/card-key.js';
import { deriveSlug } from '../shared/slug.js';
import { decodeCursor, encodeCursor, normalizePageLimit, Page, PageOptions, toPage } from '../shared/pagination.js';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import { assertResourceWorkspace, bootstrapWorkspaceId, workspaceIdFor } from './helpers/workspace-scope.helper.js';

export class ProjectService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService,
    private boardService?: BoardService,
    private documentService?: DocumentService
  ) {}

  async create(data: CreateProject, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Project> {
    if (!adapter) return this.db.transaction(tx => this.create(data, actorId, tx, auth));
    const db = adapter;
    const id = ulid();
    const created_at = new Date().toISOString();
    const updated_at = created_at;

    const existingPrefixes = await db.query<{ key_prefix: string }>(
      `SELECT key_prefix FROM project WHERE key_prefix IS NOT NULL`
    );
    const key_prefix = deriveKeyPrefix(data.name, new Set(existingPrefixes.map(p => p.key_prefix)));
    const existingSlugs = await db.query<{ slug: string }>(
      `SELECT slug FROM project WHERE slug IS NOT NULL`
    );
    const slug = deriveSlug(data.name, new Set(existingSlugs.map(p => p.slug)));

    // Authenticated creation is deterministic. The first-row fallback exists
    // only for the zero-config local/open bootstrap path.
    let workspaceId = workspaceIdFor(auth);
    if (!workspaceId) {
      workspaceId = (await bootstrapWorkspaceId(db)) || '';
    }

    await db.execute(
      `INSERT INTO project (id, workspace_id, name, slug, description, key_prefix, card_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [id, workspaceId, data.name, slug, data.description || null, key_prefix, created_at, updated_at]
    );

    const project: Project = {
      id,
      workspace_id: workspaceId,
      name: data.name,
      slug,
      description: data.description || null,
      key_prefix,
      card_seq: 0,
      created_at,
      updated_at,
    };

    if (this.eventService) {
      await this.eventService.create({
        project_id: id,
        entity_type: 'project',
        entity_id: id,
        action: 'created',
        actor_id: actorId,
        payload: { name: project.name },
      }, db);
    }

    if (this.boardService) {
      await this.boardService.create({ project_id: id, name: 'Sprint 1' }, actorId, db, auth);
    }

    if (this.documentService) {
      await this.documentService.create({
        project_id: id,
        title: 'Agent Operating Protocol & Collaboration Standard',
        content: `# Muster — Operating Protocol

All AI agents and human operators collaborating within this project must observe the following workflow rules:

1. **Agent Self-Registration & Identity Re-Binding**:
   - Call \`list_agents\` upon initial connection to check if an existing identity (or UI pre-registration) exists.
   - Re-bind to existing agent identities by passing its \`id\` as \`agent_id\` in \`register_agent\` or \`heartbeat\` rather than creating duplicate registrations.
   - Emit periodic \`heartbeat\` calls to indicate active status.

2. **Design Specifications & Knowledge Bases First**:
   - Always read project design specs via \`list_documents\` before starting tasks.
   - Inspect Knowledge Bases using \`list_knowledge_bases\`, \`search_knowledge\`, or \`get_entity_knowledge\` to check known facts, constraints, and entity relationships before planning or implementation.
   - Record newly discovered facts, constraints, or gotchas using \`add_gained_knowledge\` or \`upsert_kb_entity\`.
   - Propose architectural updates using \`create_document\` or \`update_document\` with status \`in_review\`.

3. **Kanban Card Workflow & Flexible Board Structures**:
   - Boards may have 3 lanes ('To Do' → 'In Progress' → 'Done'), standard 5 lanes, or custom columns. Inspect active board layout via \`get_board\`.
   - Select unassigned tasks from initial state columns ('To Do' or 'Backlog').
   - When starting work on a task, call \`claim_card\` to record yourself as the assignee and create the work lease, then call \`move_card\` to advance it to the next active-work lane—normally 'In Progress'.
   - Adhere strictly to WIP limits set on board columns; the server rejects over-limit card creates/moves and unresolved blockers on claims or moves into 'In Progress'.
   - There is no separate card status field: 'In Review' is a board lane, 'blocked' is expressed via the \`blocks\`/\`blocked_by\` card relationship, and a card is active by default.

4. **Mandatory Progress Comments on Cards**:
   - Agents **MUST ALWAYS** log their progress as comments directly on the target card using \`add_comment\`.
   - Post card comments for task pickup, sub-task completions, intermediate milestones, blockers, architectural decisions, and test/verification results.
   - Always state current work using full human-readable task titles and work summaries out loud (e.g., \`Working on Muster Task "Create authentication middleware"\`), never raw ID strings like \`Work on card #01J3K...\`.
   - When implementation is completed, move card to 'In Review' (if column exists) or directly to 'Done' (on simplified boards) after posting verification notes.`,
      }, actorId, db, auth);
    }

    return project;
  }

  async getById(id: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Project | null> {
    await assertResourceWorkspace(this.db, auth, 'project', id);
    const rows = await this.db.query<Project>('SELECT * FROM project WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async list(auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Project[]> {
    const workspaceId = workspaceIdFor(auth);
    if (!workspaceId) return this.db.query<Project>('SELECT * FROM project ORDER BY created_at DESC');
    return this.db.query<Project>('SELECT * FROM project WHERE workspace_id = ? ORDER BY created_at DESC', [workspaceId]);
  }

  async listPage(options: PageOptions = {}, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Page<Project>> {
    const limit = normalizePageLimit(options.limit);
    const workspaceId = workspaceIdFor(auth);
    const scope = `projects:${workspaceId || 'global'}`;
    const cursor = decodeCursor(options.cursor, scope, 2);
    const params: unknown[] = [];
    let sql = 'SELECT * FROM project';
    if (workspaceId) { sql += ' WHERE workspace_id = ?'; params.push(workspaceId); }
    if (cursor) {
      sql += `${workspaceId ? ' AND' : ' WHERE'} (created_at < ? OR (created_at = ? AND id < ?))`;
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(limit + 1);
    return toPage(await this.db.query<Project>(sql, params), limit, row => encodeCursor(scope, [row.created_at, row.id]));
  }

  async update(id: string, data: UpdateProject, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Project> {
    if (!adapter) return this.db.transaction(tx => this.update(id, data, actorId, tx, auth));
    const db = adapter;
    await assertResourceWorkspace(db, auth, 'project', id);
    const existingRows = await db.query<Project>('SELECT * FROM project WHERE id = ?', [id]);
    const existing = existingRows[0] || null;
    if (!existing) throw new Error(`Project with ID ${id} not found`);

    const name = data.name !== undefined ? data.name : existing.name;
    const description = data.description !== undefined ? data.description : existing.description;
    const updated_at = new Date().toISOString();
    let slug = existing.slug;

    // Rows created before slugs were introduced are repaired lazily if they
    // are updated before the startup backfill has seen them.
    if (!slug) {
      const existingSlugs = await db.query<{ slug: string }>(
        `SELECT slug FROM project WHERE id != ? AND slug IS NOT NULL`,
        [id]
      );
      slug = deriveSlug(name, new Set(existingSlugs.map(p => p.slug)));
    }

    await db.execute(
      `UPDATE project SET name = ?, slug = ?, description = ?, updated_at = ? WHERE id = ?`,
      [name, slug, description, updated_at, id]
    );

    const updated: Project = { ...existing, name, slug, description, updated_at };

    if (this.eventService) {
      await this.eventService.create({
        project_id: id,
        entity_type: 'project',
        entity_id: id,
        action: 'updated',
        actor_id: actorId,
        payload: data as Record<string, unknown>,
      }, db);
    }

    return updated;
  }

  async delete(id: string, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.delete(id, actorId, tx, auth));
    const db = adapter;
    await assertResourceWorkspace(db, auth, 'project', id);
    const existingRows = await db.query<Project>('SELECT * FROM project WHERE id = ?', [id]);
    const existing = existingRows[0] || null;
    if (!existing) throw new Error(`Project with ID ${id} not found`);

    await db.execute('DELETE FROM project WHERE id = ?', [id]);

    // A deleted project cannot be the target of event.project_id: the event
    // table intentionally keeps a required project FK and project deletion
    // cascades its project-scoped feed. Transports record the durable,
    // workspace-scoped project.delete audit row in this same adapter
    // transaction after this mutation succeeds.
  }

  async getSummary(id: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<ProjectSummary> {
    const project = await this.getById(id, auth);
    if (!project) throw new Error(`Project with ID ${id} not found`);

    const boards = await this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM board WHERE project_id = ?', [id]);
    const board_count = Number(boards[0]?.count || 0);

    const cards = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM card c 
       JOIN "column" col ON c.column_id = col.id 
       JOIN board b ON col.board_id = b.id 
       WHERE b.project_id = ? AND c.archived = 0`,
      [id]
    );
    const card_count = Number(cards[0]?.count || 0);

    const notDoneCards = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM card c 
       JOIN "column" col ON c.column_id = col.id 
       JOIN board b ON col.board_id = b.id 
       WHERE b.project_id = ? AND c.archived = 0 AND col.is_terminal = 0`,
      [id]
    );
    const not_done_card_count = Number(notDoneCards[0]?.count || 0);

    const agents = await this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM agent WHERE workspace_id = ?', [project.workspace_id]);
    const agent_count = Number(agents[0]?.count || 0);

    const activeAgents = await this.db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM agent WHERE workspace_id = ? AND status = ?',
      [project.workspace_id, 'active']
    );
    const active_agent_count = Number(activeAgents[0]?.count || 0);

    const docs = await this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM document WHERE project_id = ?', [id]);
    const document_count = Number(docs[0]?.count || 0);

    return {
      project_id: id,
      name: project.name,
      description: project.description,
      board_count,
      card_count,
      not_done_card_count,
      agent_count,
      active_agent_count,
      document_count,
    };
  }
}
