// File: src/services/kb.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import {
  KnowledgeBase,
  CreateKnowledgeBase,
  KBEntity,
  UpsertKBEntity,
  KBFact,
  KBFactSummary,
  AddGainedKnowledge,
  KBRelation,
  AddKBRelation,
  EntityKnowledgeResult,
  KBGraphTree,
  KBGraphNode,
  KBGraphLink,
  KBReadScopeInput,
  KBFactBrowseSummary,
  KBKnowledgeOverview,
  KBEntitySummary,
  KBEntityCandidate,
  KBEntityContext,
  KBEntityContextNode,
  KBEntityContextEdge,
  KBKnowledgeOverviewOptions,
  KBBrowseFilters,
  KBEntityListFilters,
  KBEntityReference,
  KBEntityContextOptions,
} from '../shared/types.js';
import { EventService } from './event.service.js';
import { decodeCursor, encodeCursor, normalizePageLimit, Page, PageInfo, PageOptions, toPage } from '../shared/pagination.js';
import type { AuthContext } from '../shared/auth-context.js';
import { OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import { KBEntityAmbiguityError, NotFoundError, ValidationError } from '../shared/errors.js';
import {
  assertResourceWorkspace,
  assertResourcesShareWorkspace,
  assertResourcesWorkspace,
  workspaceIdFor,
} from './helpers/workspace-scope.helper.js';
import { KBReadScopeResolver, ResolvedKBReadScope } from './kb-read-scope.js';

const KB_SEARCH_RANK_VERSION = 2;
const KB_SEARCH_MAX_TERMS = 64;

// Search is intentionally lexical and transport-neutral.  These words carry
// question grammar rather than knowledge, so retaining them in a phrase
// search would make a natural-language question miss an otherwise useful
// keyword result.  A stop-word-only query is still rejected by the normalizer
// rather than being treated as an empty browse request.
const KB_SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'by', 'can',
  'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how',
  'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'please',
  'should', 'that', 'the', 'their', 'them', 'they', 'this', 'to', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
  'would', 'you', 'your',
]);

// Keep this deliberately small and conservative.  LIKE against the canonical
// token still matches ordinary plural/derived forms (image -> images), while
// these explicit aliases cover the common deployment wording that does not
// share a simple suffix (deployed/deployment -> deploy).
const KB_SEARCH_TOKEN_ALIASES: Record<string, string> = {
  deployed: 'deploy',
  deploying: 'deploy',
  deployment: 'deploy',
  deployments: 'deploy',
};

interface KBSearchQueryPlan {
  canonical: string;
  terms: string[];
}

interface KBSearchFields {
  title: string;
  entityName: string;
  entityIdentifier: string;
  entityType: string;
  category: string;
  content: string;
}

function canonicalSearchToken(token: string): string {
  const alias = KB_SEARCH_TOKEN_ALIASES[token];
  if (alias) return alias;

  // A narrow suffix normalizer handles the high-value forms without trying to
  // become a general linguistic stemmer.  The LIKE pattern then covers the
  // source form as well (for example image matches images).
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith('ing')) {
    const stem = token.slice(0, -3);
    return stem.endsWith(stem.at(-1) || '') && stem.length > 2
      && stem.at(-1) === stem.at(-2) ? stem.slice(0, -1) : stem;
  }
  if (token.length > 4 && token.endsWith('ied')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function normalizeKBSearchQuery(query: string): KBSearchQueryPlan {
  const terms = [...new Set(
    query
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .filter(token => !KB_SEARCH_STOP_WORDS.has(token))
      .map(canonicalSearchToken)
      .filter(Boolean),
  )];
  if (terms.length === 0) {
    throw new ValidationError('Search query must contain at least one meaningful term', {
      field: 'q',
      code: 'KB_SEARCH_QUERY_EMPTY',
    });
  }
  if (terms.length > KB_SEARCH_MAX_TERMS) {
    throw new ValidationError(`Search query may contain at most ${KB_SEARCH_MAX_TERMS} meaningful terms`, {
      field: 'q',
      code: 'KB_SEARCH_QUERY_TOO_COMPLEX',
    });
  }
  return { canonical: terms.join(' '), terms };
}

export class KBService {
  constructor(
    private db: DatabaseAdapter,
    private eventService: EventService | undefined,
    private readonly readScopeResolver: KBReadScopeResolver,
  ) {}

  private async logEventForKb(
    kbId: string,
    action: string,
    entityId: string,
    actorId?: string,
    payload?: Record<string, unknown>,
    adapter: DatabaseAdapter = this.db,
  ): Promise<void> {
    if (!this.eventService) return;
    const projectIds = await this.getLinkedProjectIdsInternal(kbId, adapter);
    for (const projectId of projectIds) {
      await this.eventService.create({
        project_id: projectId,
        entity_type: 'knowledge_base',
        entity_id: entityId,
        action,
        actor_id: actorId,
        payload,
      }, adapter);
    }
  }

  // --- Knowledge Base CRUD & Linkage ---


  async create(data: CreateKnowledgeBase, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KnowledgeBase> {
    if (!adapter) return this.db.transaction(tx => this.create(data, actorId, tx, auth));
    const db = adapter;
    if (data.project_ids?.length) {
      await assertResourcesWorkspace(db, auth, data.project_ids.map(id => ['project', id]));
    } else if (workspaceIdFor(auth)) {
      throw new ValidationError('A knowledge base must be linked to a project in the authenticated workspace');
    }
    const id = ulid();
    const created_at = new Date().toISOString();
    const updated_at = created_at;
    const is_global = data.is_global ? 1 : 0;

    await db.execute(
      `INSERT INTO knowledge_base (id, name, description, is_global, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, data.name, data.description || null, is_global, created_at, updated_at]
    );

    if (data.project_ids && data.project_ids.length > 0) {
      for (const projectId of data.project_ids) {
        // The KB has no owner until its first project link exists, so the
        // public linkProject guard cannot resolve it yet. Project ownership
        // was validated before the insert; establish only those validated
        // initial links inside this same transaction.
        await db.execute(
          `INSERT OR IGNORE INTO project_knowledge_base (project_id, kb_id, created_at)
           VALUES (?, ?, ?)`,
          [projectId, id, created_at],
        );
      }
    }

    const kb: KnowledgeBase = {
      id,
      name: data.name,
      description: data.description || null,
      is_global,
      created_at,
      updated_at,
      linked_project_ids: data.project_ids || [],
    };

    if (this.eventService && data.project_ids?.[0]) {
      await this.eventService.create({
        project_id: data.project_ids[0],
        entity_type: 'knowledge_base',
        entity_id: id,
        action: 'created',
        actor_id: actorId,
        payload: { name: kb.name, is_global: kb.is_global },
      }, db);
    }

    return kb;
  }

  async getById(id: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KnowledgeBase | null> {
    await assertResourceWorkspace(this.db, auth, 'knowledge_base', id);
    const rows = await this.db.query<KnowledgeBase>('SELECT * FROM knowledge_base WHERE id = ?', [id]);
    if (!rows[0]) return null;

    const kb = rows[0];
    kb.linked_project_ids = await this.getLinkedProjectIds(id, auth);
    return kb;
  }

  async list(projectId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KnowledgeBase[]> {
    if (projectId) await assertResourceWorkspace(this.db, auth, 'project', projectId);
    const scopedWorkspace = workspaceIdFor(auth);
    let kbs: KnowledgeBase[];
    if (projectId) {
      kbs = scopedWorkspace
        ? await this.db.query<KnowledgeBase>(
            `SELECT DISTINCT kb.* FROM knowledge_base kb
             JOIN project_knowledge_base owner_link ON owner_link.kb_id = kb.id
             JOIN project owner_project ON owner_project.id = owner_link.project_id
             LEFT JOIN project_knowledge_base selected_link
               ON selected_link.kb_id = kb.id AND selected_link.project_id = ?
             WHERE owner_project.workspace_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM project_knowledge_base foreign_link
                 JOIN project foreign_project ON foreign_project.id = foreign_link.project_id
                 WHERE foreign_link.kb_id = kb.id AND foreign_project.workspace_id <> ?
               )
               AND (kb.is_global = 1 OR selected_link.project_id IS NOT NULL)
             ORDER BY kb.created_at DESC`,
            [projectId, scopedWorkspace, scopedWorkspace],
          )
        : await this.db.query<KnowledgeBase>(
            `SELECT DISTINCT kb.* FROM knowledge_base kb
             LEFT JOIN project_knowledge_base pkb ON kb.id = pkb.kb_id
             WHERE kb.is_global = 1 OR pkb.project_id = ?
             ORDER BY kb.created_at DESC`,
            [projectId],
          );
    } else if (scopedWorkspace) {
      kbs = await this.db.query<KnowledgeBase>(
        `SELECT DISTINCT kb.* FROM knowledge_base kb
         JOIN project_knowledge_base pkb ON kb.id = pkb.kb_id
         JOIN project p ON p.id = pkb.project_id
         WHERE p.workspace_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM project_knowledge_base foreign_link
             JOIN project foreign_project ON foreign_project.id = foreign_link.project_id
             WHERE foreign_link.kb_id = kb.id AND foreign_project.workspace_id <> ?
           )
         ORDER BY kb.created_at DESC`,
        [scopedWorkspace, scopedWorkspace],
      );
    } else {
      kbs = await this.db.query<KnowledgeBase>('SELECT * FROM knowledge_base ORDER BY created_at DESC');
    }

    for (const kb of kbs) {
      kb.linked_project_ids = await this.getLinkedProjectIds(kb.id, auth);
    }

    return kbs;
  }

  async listPage(projectId?: string, options: PageOptions = {}, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Page<KnowledgeBase>> {
    if (projectId) await assertResourceWorkspace(this.db, auth, 'project', projectId);
    const scopedWorkspace = workspaceIdFor(auth);
    const limit = normalizePageLimit(options.limit);
    const scope = `knowledge-bases:${projectId || 'global'}:${scopedWorkspace || 'open'}`;
    const cursor = decodeCursor(options.cursor, scope, 2);
    const params: unknown[] = [];
    let sql = projectId
      ? `SELECT DISTINCT kb.* FROM knowledge_base kb
         LEFT JOIN project_knowledge_base pkb ON kb.id = pkb.kb_id
         WHERE (kb.is_global = 1 OR pkb.project_id = ?)`
      : 'SELECT kb.* FROM knowledge_base kb WHERE 1 = 1';
    if (projectId) params.push(projectId);
    if (scopedWorkspace) {
      sql += ` AND EXISTS (SELECT 1 FROM project_knowledge_base owner_link JOIN project owner_project ON owner_project.id=owner_link.project_id WHERE owner_link.kb_id=kb.id AND owner_project.workspace_id=?)
        AND NOT EXISTS (SELECT 1 FROM project_knowledge_base foreign_link JOIN project foreign_project ON foreign_project.id=foreign_link.project_id WHERE foreign_link.kb_id=kb.id AND foreign_project.workspace_id<>?)`;
      params.push(scopedWorkspace, scopedWorkspace);
    }
    if (cursor) {
      sql += ' AND (kb.created_at < ? OR (kb.created_at = ? AND kb.id < ?))';
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    sql += ' ORDER BY kb.created_at DESC, kb.id DESC LIMIT ?';
    params.push(limit + 1);
    const rows = await this.db.query<KnowledgeBase>(sql, params);
    for (const kb of rows.slice(0, limit)) kb.linked_project_ids = await this.getLinkedProjectIds(kb.id, auth);
    return toPage(rows, limit, row => encodeCursor(scope, [row.created_at, row.id]));
  }

  async linkProject(kbId: string, projectId: string, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.linkProject(kbId, projectId, actorId, tx, auth));
    const db = adapter;
    await assertResourcesWorkspace(db, auth, [['knowledge_base', kbId], ['project', projectId]]);
    await assertResourcesShareWorkspace(db, [['knowledge_base', kbId], ['project', projectId]]);
    const created_at = new Date().toISOString();
    const result = await db.execute(
      `INSERT OR IGNORE INTO project_knowledge_base (project_id, kb_id, created_at)
       VALUES (?, ?, ?)`,
      [projectId, kbId, created_at]
    );
    if (result.changes === 1 && this.eventService) {
      await this.eventService.create({
        project_id: projectId,
        entity_type: 'knowledge_base',
        entity_id: kbId,
        action: 'linked',
        actor_id: actorId,
      }, db);
    }
  }

  async unlinkProject(kbId: string, projectId: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    await assertResourcesWorkspace(this.db, auth, [['knowledge_base', kbId], ['project', projectId]]);
    await this.db.execute(
      `DELETE FROM project_knowledge_base WHERE project_id = ? AND kb_id = ?`,
      [projectId, kbId]
    );
  }

  private async getLinkedProjectIdsInternal(kbId: string, adapter: DatabaseAdapter = this.db): Promise<string[]> {
    const rows = await adapter.query<{ project_id: string }>(
      'SELECT project_id FROM project_knowledge_base WHERE kb_id = ?',
      [kbId]
    );
    return rows.map(r => r.project_id);
  }

  private async getLinkedProjectIds(
    kbId: string,
    auth: AuthContext,
    adapter: DatabaseAdapter = this.db,
  ): Promise<string[]> {
    const workspaceId = workspaceIdFor(auth);
    if (!workspaceId) return this.getLinkedProjectIdsInternal(kbId, adapter);

    const rows = await adapter.query<{ project_id: string }>(
      `SELECT pkb.project_id
       FROM project_knowledge_base pkb
       JOIN project p ON p.id = pkb.project_id
       WHERE pkb.kb_id = ? AND p.workspace_id = ?
       ORDER BY pkb.created_at`,
      [kbId, workspaceId],
    );
    return rows.map(row => row.project_id);
  }

  async delete(id: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    await assertResourceWorkspace(this.db, auth, 'knowledge_base', id);
    await this.db.execute('DELETE FROM knowledge_base WHERE id = ?', [id]);
  }

  // --- Entities ---

  async upsertEntity(data: UpsertKBEntity, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KBEntity> {
    if (!adapter) return this.db.transaction(tx => this.upsertEntity(data, actorId, tx, auth));
    const db = adapter;
    await assertResourceWorkspace(db, auth, 'knowledge_base', data.kb_id);
    const now = new Date().toISOString();
    let existing: KBEntity | null = null;

    if (data.identifier) {
      const rows = await db.query<KBEntity>(
        'SELECT * FROM kb_entity WHERE kb_id = ? AND identifier = ?',
        [data.kb_id, data.identifier]
      );
      existing = rows[0] || null;
    }

    if (!existing && data.name) {
      const rows = await db.query<KBEntity>(
        'SELECT * FROM kb_entity WHERE kb_id = ? AND name = ?',
        [data.kb_id, data.name]
      );
      existing = rows[0] || null;
    }

    const type = data.type || (this.detectEntityType(data.identifier || data.name));
    const metadataStr = data.metadata ? JSON.stringify(data.metadata) : null;

    let resEntity: KBEntity;

    if (existing) {
      await db.execute(
        `UPDATE kb_entity SET name = ?, type = ?, identifier = ?, metadata = ?, updated_at = ? WHERE id = ?`,
        [data.name, type, data.identifier || existing.identifier, metadataStr || existing.metadata, now, existing.id]
      );
      resEntity = {
        ...existing,
        name: data.name,
        type,
        identifier: data.identifier || existing.identifier,
        metadata: data.metadata || existing.metadata,
        updated_at: now,
      };
      await this.logEventForKb(data.kb_id, 'entity_updated', resEntity.id, actorId, { name: resEntity.name, type: resEntity.type, kb_id: data.kb_id }, db);
    } else {
      const id = ulid();
      await db.execute(
        `INSERT INTO kb_entity (id, kb_id, name, type, identifier, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, data.kb_id, data.name, type, data.identifier || null, metadataStr, now, now]
      );
      resEntity = {
        id,
        kb_id: data.kb_id,
        name: data.name,
        type,
        identifier: data.identifier || null,
        metadata: data.metadata || null,
        created_at: now,
        updated_at: now,
      };
      await this.logEventForKb(data.kb_id, 'entity_created', resEntity.id, actorId, { name: resEntity.name, type: resEntity.type, kb_id: data.kb_id }, db);
    }

    return resEntity;
  }

  async getEntityById(id: string, adapter: DatabaseAdapter = this.db, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KBEntity | null> {
    await assertResourceWorkspace(adapter, auth, 'kb_entity', id);
    const rows = await adapter.query<KBEntity>('SELECT * FROM kb_entity WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async listEntities(kbId: string, type?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KBEntity[]> {
    await assertResourceWorkspace(this.db, auth, 'knowledge_base', kbId);
    if (type) {
      return this.db.query<KBEntity>(
        'SELECT * FROM kb_entity WHERE kb_id = ? AND type = ? ORDER BY name ASC',
        [kbId, type]
      );
    }
    return this.db.query<KBEntity>('SELECT * FROM kb_entity WHERE kb_id = ? ORDER BY name ASC', [kbId]);
  }

  async listEntitiesPage(kbId: string, type?: string, options: PageOptions = {}, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Page<KBEntity>> {
    await assertResourceWorkspace(this.db, auth, 'knowledge_base', kbId);
    const limit = normalizePageLimit(options.limit);
    const scope = `kb-entities:${JSON.stringify({ kbId, type: type || null })}`;
    const cursor = decodeCursor(options.cursor, scope, 2);
    const clauses = ['kb_id = ?'];
    const params: unknown[] = [kbId];
    if (type) { clauses.push('type = ?'); params.push(type); }
    if (cursor) {
      clauses.push('(name > ? OR (name = ? AND id > ?))');
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    params.push(limit + 1);
    const rows = await this.db.query<KBEntity>(
      `SELECT * FROM kb_entity WHERE ${clauses.join(' AND ')} ORDER BY name ASC, id ASC LIMIT ?`, params,
    );
    return toPage(rows, limit, row => encodeCursor(scope, [row.name, row.id]));
  }

  async deleteEntity(id: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    await assertResourceWorkspace(this.db, auth, 'kb_entity', id);
    await this.db.execute('DELETE FROM kb_entity WHERE id = ?', [id]);
  }

  async updateEntity(id: string, data: Partial<UpsertKBEntity>, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KBEntity> {
    if (!adapter) return this.db.transaction(tx => this.updateEntity(id, data, actorId, tx, auth));
    const db = adapter;
    const existing = await this.getEntityById(id, db, auth);
    if (!existing) throw new Error(`KBEntity with ID ${id} not found`);

    const now = new Date().toISOString();
    const name = data.name !== undefined ? data.name : existing.name;
    const type = data.type !== undefined ? data.type : existing.type;
    const identifier = data.identifier !== undefined ? data.identifier : existing.identifier;
    const metadataStr = data.metadata ? JSON.stringify(data.metadata) : (existing.metadata ? (typeof existing.metadata === 'string' ? existing.metadata : JSON.stringify(existing.metadata)) : null);

    await db.execute(
      `UPDATE kb_entity SET name = ?, type = ?, identifier = ?, metadata = ?, updated_at = ? WHERE id = ?`,
      [name, type, identifier, metadataStr, now, id]
    );

    const updated: KBEntity = {
      ...existing,
      name,
      type,
      identifier,
      metadata: data.metadata || existing.metadata,
      updated_at: now,
    };

    await this.logEventForKb(existing.kb_id, 'entity_updated', id, actorId, { name: updated.name, type: updated.type, kb_id: existing.kb_id }, db);
    return updated;
  }


  // --- Facts / Gained Knowledge ---

  async addFact(data: AddGainedKnowledge, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KBFact> {
    if (!adapter) return this.db.transaction(tx => this.addFact(data, actorId, tx, auth));
    const db = adapter;
    await assertResourceWorkspace(db, auth, 'knowledge_base', data.kb_id);
    if (data.entity_id) {
      await assertResourcesWorkspace(db, auth, [['knowledge_base', data.kb_id], ['kb_entity', data.entity_id]]);
      await assertResourcesShareWorkspace(db, [['knowledge_base', data.kb_id], ['kb_entity', data.entity_id]]);
      const matchingEntities = await db.query<{ id: string }>(
        'SELECT id FROM kb_entity WHERE id = ? AND kb_id = ?',
        [data.entity_id, data.kb_id],
      );
      if (matchingEntities.length !== 1) throw new NotFoundError('Resource not found');
    }
    const now = new Date().toISOString();
    const id = ulid();
    let entityId = data.entity_id || null;

    // Auto-resolve entity if name or identifier provided or detected in content
    if (!entityId && (data.entity_name || data.entity_identifier)) {
      const entity = await this.upsertEntity({
        kb_id: data.kb_id,
        name: data.entity_name || data.entity_identifier || 'Unknown Entity',
        identifier: data.entity_identifier,
        type: data.entity_type,
      }, actorId, db, auth);
      entityId = entity.id;
    } else if (!entityId) {
      // Auto-detect IP or email pattern in title or content if available
      const text = `${data.title} ${data.content}`;
      const ipMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);

      if (ipMatch) {
        const entity = await this.upsertEntity({
          kb_id: data.kb_id,
          name: ipMatch[0],
          identifier: ipMatch[0],
          type: 'ip_address',
        }, actorId, db, auth);
        entityId = entity.id;
      } else if (emailMatch) {
        const entity = await this.upsertEntity({
          kb_id: data.kb_id,
          name: emailMatch[0],
          identifier: emailMatch[0],
          type: 'email',
        }, actorId, db, auth);
        entityId = entity.id;
      }
    }

    const category = data.category || 'general';
    const confidence = data.confidence !== undefined ? data.confidence : 1.0;
    // `actorId` originates at a transport boundary from AuthContext. It is
    // authoritative over the legacy source field so provenance cannot be
    // spoofed by a caller who is otherwise allowed to add knowledge.
    const sourceAgentId = actorId || data.source_principal_id || null;

    await db.execute(
      `INSERT INTO kb_fact (id, kb_id, entity_id, title, content, category, confidence, source_principal_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.kb_id, entityId, data.title, data.content, category, confidence, sourceAgentId, now, now]
    );

    const fact: KBFact = {
      id,
      kb_id: data.kb_id,
      entity_id: entityId,
      title: data.title,
      content: data.content,
      category,
      confidence,
      source_principal_id: sourceAgentId,
      created_at: now,
      updated_at: now,
    };

    if (entityId) {
      const entity = await this.getEntityById(entityId, db, auth);
      if (entity) {
        fact.entity_name = entity.name;
        fact.entity_identifier = entity.identifier || undefined;
      }
    }

    await this.logEventForKb(data.kb_id, 'fact_added', id, actorId, {
      title: fact.title,
      category: fact.category,
      entity_name: fact.entity_name,
      kb_id: data.kb_id,
    }, db);

    return fact;
  }

  async listFacts(kbId?: string, entityId?: string, category?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KBFact[]> {
    if (kbId) await assertResourceWorkspace(this.db, auth, 'knowledge_base', kbId);
    if (entityId) await assertResourceWorkspace(this.db, auth, 'kb_entity', entityId);
    const scopedWorkspace = workspaceIdFor(auth);
    let sql = `SELECT f.*, e.name as entity_name, e.identifier as entity_identifier 
               FROM kb_fact f 
               LEFT JOIN kb_entity e ON f.entity_id = e.id AND e.kb_id = f.kb_id`;
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (kbId) {
      clauses.push('f.kb_id = ?');
      params.push(kbId);
    }
    if (entityId) {
      clauses.push('f.entity_id = ?');
      params.push(entityId);
    }
    if (category) {
      clauses.push('f.category = ?');
      params.push(category);
    }
    if (scopedWorkspace) {
      clauses.push(`EXISTS (
        SELECT 1 FROM project_knowledge_base owner_link
        JOIN project owner_project ON owner_project.id = owner_link.project_id
        WHERE owner_link.kb_id = f.kb_id AND owner_project.workspace_id = ?
      )`);
      params.push(scopedWorkspace);
      clauses.push(`NOT EXISTS (
        SELECT 1 FROM project_knowledge_base foreign_link
        JOIN project foreign_project ON foreign_project.id = foreign_link.project_id
        WHERE foreign_link.kb_id = f.kb_id AND foreign_project.workspace_id <> ?
      )`);
      params.push(scopedWorkspace);
      clauses.push(`(
        f.entity_id IS NULL OR EXISTS (
          SELECT 1 FROM kb_entity fact_entity
          WHERE fact_entity.id = f.entity_id AND fact_entity.kb_id = f.kb_id
        )
      )`);
    }

    if (clauses.length > 0) {
      sql += ' WHERE ' + clauses.join(' AND ');
    }

    sql += ' ORDER BY f.created_at DESC';

    return this.db.query<KBFact>(sql, params);
  }

  async listFactsPage(
    kbId: string,
    filters: { entityId?: string; category?: string } = {},
    options: PageOptions = {},
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<Page<KBFactSummary>> {
    await assertResourceWorkspace(this.db, auth, 'knowledge_base', kbId);
    const limit = normalizePageLimit(options.limit);
    const scope = `kb-facts:${JSON.stringify({ kbId, entityId: filters.entityId || null, category: filters.category || null })}`;
    const cursor = decodeCursor(options.cursor, scope, 2);
    let sql = `SELECT f.id, f.kb_id, f.entity_id, f.title, f.category, f.confidence,
      f.source_principal_id, f.created_at, f.updated_at, e.name as entity_name,
      e.identifier as entity_identifier
      FROM kb_fact f LEFT JOIN kb_entity e ON f.entity_id = e.id WHERE f.kb_id = ?`;
    const params: unknown[] = [kbId];
    if (filters.entityId) { sql += ' AND f.entity_id = ?'; params.push(filters.entityId); }
    if (filters.category) { sql += ' AND f.category = ?'; params.push(filters.category); }
    if (cursor) {
      sql += ' AND (f.created_at < ? OR (f.created_at = ? AND f.id < ?))';
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    sql += ' ORDER BY f.created_at DESC, f.id DESC LIMIT ?';
    params.push(limit + 1);
    const rows = await this.db.query<KBFactSummary>(sql, params);
    return toPage(rows, limit, row => encodeCursor(scope, [row.created_at, row.id]));
  }

  async getFactById(id: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KBFact | null> {
    await assertResourceWorkspace(this.db, auth, 'kb_fact', id);
    const rows = await this.db.query<KBFact>(
      `SELECT f.*, e.name as entity_name, e.identifier as entity_identifier
       FROM kb_fact f LEFT JOIN kb_entity e ON f.entity_id = e.id WHERE f.id = ?`, [id],
    );
    return rows[0] || null;
  }

  async deleteFact(id: string, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.deleteFact(id, actorId, tx, auth));
    const db = adapter;
    await assertResourceWorkspace(db, auth, 'kb_fact', id);
    const existingRows = await db.query<KBFact>('SELECT * FROM kb_fact WHERE id = ?', [id]);
    if (!existingRows[0]) return;
    await db.execute('DELETE FROM kb_fact WHERE id = ?', [id]);
    await this.logEventForKb(existingRows[0].kb_id, 'fact_deleted', id, actorId, { title: existingRows[0].title, kb_id: existingRows[0].kb_id }, db);
  }

  async updateFact(id: string, data: Partial<AddGainedKnowledge>, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KBFact> {
    if (!adapter) return this.db.transaction(tx => this.updateFact(id, data, actorId, tx, auth));
    const db = adapter;
    await assertResourceWorkspace(db, auth, 'kb_fact', id);
    const existingRows = await db.query<KBFact>('SELECT * FROM kb_fact WHERE id = ?', [id]);
    if (!existingRows[0]) throw new Error(`KBFact with ID ${id} not found`);
    const existing = existingRows[0];

    const now = new Date().toISOString();
    const title = data.title !== undefined ? data.title : existing.title;
    const content = data.content !== undefined ? data.content : existing.content;
    const category = data.category !== undefined ? data.category : existing.category;
    const confidence = data.confidence !== undefined ? data.confidence : existing.confidence;

    let entityId = data.entity_id !== undefined ? data.entity_id : existing.entity_id;

    if (data.entity_id) {
      await assertResourceWorkspace(db, auth, 'kb_entity', data.entity_id);
      const matchingEntities = await db.query<{ id: string }>(
        'SELECT id FROM kb_entity WHERE id = ? AND kb_id = ?',
        [data.entity_id, existing.kb_id],
      );
      if (matchingEntities.length !== 1) throw new NotFoundError('Resource not found');
    }

    if (data.entity_name || data.entity_identifier) {
      const entity = await this.upsertEntity({
        kb_id: existing.kb_id,
        name: data.entity_name || data.entity_identifier || 'Unknown Entity',
        identifier: data.entity_identifier,
        type: data.entity_type,
      }, actorId, db, auth);
      entityId = entity.id;
    }

    await db.execute(
      `UPDATE kb_fact SET title = ?, content = ?, category = ?, confidence = ?, entity_id = ?, updated_at = ? WHERE id = ?`,
      [title, content, category, confidence, entityId, now, id]
    );

    const fact: KBFact = {
      ...existing,
      title,
      content,
      category,
      confidence,
      entity_id: entityId,
      updated_at: now,
    };

    if (entityId) {
      const entity = await this.getEntityById(entityId, db, auth);
      if (entity) {
        fact.entity_name = entity.name;
        fact.entity_identifier = entity.identifier || undefined;
      }
    }

    await this.logEventForKb(existing.kb_id, 'fact_updated', id, actorId, {
      title: fact.title,
      category: fact.category,
      entity_name: fact.entity_name,
      kb_id: existing.kb_id,
    }, db);

    return fact;
  }


  // --- Graph Relations ---

  async addRelation(data: AddKBRelation, actorId?: string, adapter?: DatabaseAdapter, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KBRelation> {
    if (!adapter) return this.db.transaction(tx => this.addRelation(data, actorId, tx, auth));
    const db = adapter;
    await assertResourcesWorkspace(db, auth, [
      ['knowledge_base', data.kb_id], ['kb_entity', data.source_entity_id], ['kb_entity', data.target_entity_id],
    ]);
    await assertResourcesShareWorkspace(db, [
      ['knowledge_base', data.kb_id], ['kb_entity', data.source_entity_id], ['kb_entity', data.target_entity_id],
    ]);
    const entityKbs = await db.query<{ id: string }>(
      'SELECT id FROM kb_entity WHERE kb_id = ? AND id IN (?, ?)',
      [data.kb_id, data.source_entity_id, data.target_entity_id],
    );
    if (entityKbs.length !== 2) throw new ValidationError('Knowledge base relation endpoints must belong to the selected knowledge base');
    const id = ulid();
    const created_at = new Date().toISOString();

    await db.execute(
      `INSERT INTO kb_relation (id, kb_id, source_entity_id, target_entity_id, relation_type, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, data.kb_id, data.source_entity_id, data.target_entity_id, data.relation_type, data.description || null, created_at]
    );

    const source = await this.getEntityById(data.source_entity_id, db, auth);
    const target = await this.getEntityById(data.target_entity_id, db, auth);

    const relation: KBRelation = {
      id,
      kb_id: data.kb_id,
      source_entity_id: data.source_entity_id,
      target_entity_id: data.target_entity_id,
      relation_type: data.relation_type,
      description: data.description || null,
      created_at,
      source_entity_name: source?.name,
      target_entity_name: target?.name,
    };

    await this.logEventForKb(data.kb_id, 'relation_added', id, actorId, {
      relation_type: relation.relation_type,
      source_name: relation.source_entity_name,
      target_name: relation.target_entity_name,
      kb_id: data.kb_id,
    }, db);

    return relation;
  }


  async deleteRelation(id: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    await assertResourceWorkspace(this.db, auth, 'kb_relation', id);
    await this.db.execute('DELETE FROM kb_relation WHERE id = ?', [id]);
  }

  // --- Bounded read model ---

  /**
   * Return one LIKE predicate per meaningful term.  Requiring every term to
   * occur somewhere avoids turning a multi-word question into a broad OR
   * search while still allowing the words to appear in different fields.
   */
  private searchTermsPredicate(
    plan: KBSearchQueryPlan,
    fields: KBSearchFields,
    params: unknown[],
  ): string {
    const searchableFields = [
      fields.title,
      fields.entityName,
      fields.entityIdentifier,
      fields.entityType,
      fields.category,
      fields.content,
    ];
    return plan.terms.map(term => {
      const pattern = `%${term}%`;
      params.push(...searchableFields.map(() => pattern));
      return `(${searchableFields.map(field => `LOWER(COALESCE(${field}, '')) LIKE ?`).join(' OR ')})`;
    }).join(' AND ');
  }

  /**
   * Build a portable numeric relevance score.  Identity matches are weighted
   * well above body-only matches so a title/entity hit remains ahead even if a
   * long question contains many body terms.  The same expression is used for
   * REST and MCP because both call this service.
   */
  private searchRankExpression(
    plan: KBSearchQueryPlan,
    fields: KBSearchFields,
    params: unknown[],
  ): string {
    const lower = (field: string) => `LOWER(COALESCE(${field}, ''))`;
    const rankParts: string[] = [];
    for (const term of plan.terms) {
      const pattern = `%${term}%`;
      params.push(pattern);
      rankParts.push(`CASE WHEN ${lower(fields.title)} LIKE ? THEN 1000 ELSE 0 END`);
      params.push(pattern, pattern, pattern);
      rankParts.push(`CASE WHEN ${[
        fields.entityName,
        fields.entityIdentifier,
        fields.entityType,
      ].map(field => `${lower(field)} LIKE ?`).join(' OR ')} THEN 800 ELSE 0 END`);
      params.push(pattern);
      rankParts.push(`CASE WHEN ${lower(fields.category)} LIKE ? THEN 100 ELSE 0 END`);
      params.push(pattern);
      rankParts.push(`CASE WHEN ${lower(fields.content)} LIKE ? THEN 1 ELSE 0 END`);
    }
    return rankParts.join(' + ');
  }

  private searchCursorRank(value: string): number {
    const rank = Number(value);
    if (!Number.isSafeInteger(rank) || rank < 0) {
      throw new ValidationError('cursor is invalid, stale, or belongs to a different collection', {
        field: 'cursor', code: 'INVALID_CURSOR',
      });
    }
    return rank;
  }

  private searchCursorScopePriority(value: string): number {
    const priority = Number(value);
    if (priority !== 0 && priority !== 1) {
      throw new ValidationError('cursor is invalid, stale, or belongs to a different collection', {
        field: 'cursor', code: 'INVALID_CURSOR',
      });
    }
    return priority;
  }

  async getKnowledgeOverview(
    scopeInput: KBReadScopeInput,
    options: KBKnowledgeOverviewOptions = {},
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<KBKnowledgeOverview> {
    const scope = await this.readScopeResolver.resolve(scopeInput, auth);
    const facetLimit = this.boundedInteger(options.facet_limit, 20, 1, 50, 'facet_limit');
    const factScope = scope.predicate('f.kb_id');
    const factCounts = await this.db.query<{ facts: number | string; attached_facts: number | string; unattached_facts: number | string }>(
      `SELECT COUNT(*) AS facts,
       SUM(CASE WHEN f.entity_id IS NOT NULL THEN 1 ELSE 0 END) AS attached_facts,
       SUM(CASE WHEN f.entity_id IS NULL THEN 1 ELSE 0 END) AS unattached_facts
       FROM kb_fact f WHERE ${factScope.sql}`,
      factScope.params,
    );
    const entityScope = scope.predicate('e.kb_id');
    const entityCounts = await this.db.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM kb_entity e WHERE ${entityScope.sql}`, entityScope.params,
    );
    const relationScope = scope.predicate('r.kb_id');
    const relationCounts = await this.db.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM kb_relation r WHERE ${relationScope.sql}`, relationScope.params,
    );
    const kbScope = scope.predicate('kb.id');
    const kbRows = await this.db.query<{ value: string; label: string; count: number | string }>(
      `SELECT kb.id AS value, kb.name AS label, COUNT(f.id) AS count
       FROM knowledge_base kb LEFT JOIN kb_fact f ON f.kb_id = kb.id
       WHERE ${kbScope.sql} GROUP BY kb.id, kb.name
       ORDER BY count DESC, kb.name ASC, kb.id ASC LIMIT ?`,
      [...kbScope.params, facetLimit + 1],
    );
    const categoryScope = scope.predicate('f.kb_id');
    const categoryRows = await this.db.query<{ value: string; count: number | string }>(
      `SELECT f.category AS value, COUNT(*) AS count FROM kb_fact f
       WHERE ${categoryScope.sql} GROUP BY f.category
       ORDER BY count DESC, f.category ASC LIMIT ?`,
      [...categoryScope.params, facetLimit + 1],
    );
    const typeScope = scope.predicate('e.kb_id');
    const typeRows = await this.db.query<{ value: string; count: number | string }>(
      `SELECT e.type AS value, COUNT(*) AS count FROM kb_entity e
       WHERE ${typeScope.sql} GROUP BY e.type
       ORDER BY count DESC, e.type ASC LIMIT ?`,
      [...typeScope.params, facetLimit + 1],
    );
    const relationTypeScope = scope.predicate('r.kb_id');
    const relationTypeRows = await this.db.query<{ value: string; count: number | string }>(
      `SELECT r.relation_type AS value, COUNT(*) AS count FROM kb_relation r
       WHERE ${relationTypeScope.sql} GROUP BY r.relation_type
       ORDER BY count DESC, r.relation_type ASC LIMIT ?`,
      [...relationTypeScope.params, facetLimit + 1],
    );
    const first = factCounts[0];
    const facet = (rows: Array<{ value: string; label?: string; count: number | string }>) => ({
      items: rows.slice(0, facetLimit).map(row => ({
        value: row.value,
        ...(row.label ? { label: row.label } : {}),
        count: Number(row.count || 0),
      })),
      has_more: rows.length > facetLimit,
    });
    return {
      scope: scope.summary,
      totals: {
        facts: Number(first?.facts || 0),
        attached_facts: Number(first?.attached_facts || 0),
        unattached_facts: Number(first?.unattached_facts || 0),
        entities: Number(entityCounts[0]?.count || 0),
        relations: Number(relationCounts[0]?.count || 0),
      },
      facets: {
        knowledge_bases: facet(kbRows),
        categories: facet(categoryRows),
        entity_types: facet(typeRows),
        relation_types: facet(relationTypeRows),
      },
    };
  }

  async listKnowledgePage(
    scopeInput: KBReadScopeInput,
    filters: KBBrowseFilters = {},
    options: PageOptions = {},
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<Page<KBFactBrowseSummary>> {
    const scope = await this.readScopeResolver.resolve(scopeInput, auth);
    if (filters.entity_id) await assertResourceWorkspace(this.db, auth, 'kb_entity', filters.entity_id);
    const rawQuery = filters.q?.trim() || undefined;
    const query = rawQuery ? normalizeKBSearchQuery(rawQuery) : undefined;
    const limit = normalizePageLimit(options.limit);
    const cursorScope = `knowledge-browse:${scope.cursor_key}:${JSON.stringify({
      q: query?.canonical || null,
      search_rank_version: query ? KB_SEARCH_RANK_VERSION : null,
      scope_priority_version: 1,
      category: filters.category || null,
      entity_id: filters.entity_id || null,
      entity_type: filters.entity_type || null,
      attached: filters.attached ?? null,
      has_source: filters.has_source ?? null,
    })}`;
    const cursor = decodeCursor(options.cursor, cursorScope, query ? 4 : 3);
    const resolvedScope = scope.predicate('f.kb_id');
    const fields: KBSearchFields = {
      title: 'f.title',
      entityName: 'e.name',
      entityIdentifier: 'e.identifier',
      entityType: 'e.type',
      category: 'f.category',
      content: 'f.content',
    };
    const rankParams: unknown[] = [];
    const rankExpression = query ? this.searchRankExpression(query, fields, rankParams) : null;
    const selectFields = `f.id, f.title, SUBSTR(f.content, 1, 280) AS excerpt,
      f.category, f.confidence, f.created_at, f.updated_at,
      kb.id AS kb_id, kb.name AS kb_name, kb.is_global AS kb_is_global,
      e.id AS entity_id, e.name AS entity_name, e.type AS entity_type, e.identifier AS entity_identifier,
      pr.id AS source_principal_id, pr.kind AS source_kind,
      COALESCE(agent.name, app_user.display_name) AS source_display_name`;
    const summaryFields = `id, title, excerpt, category, confidence, created_at, updated_at,
      kb_id, kb_name, kb_is_global, entity_id, entity_name, entity_type, entity_identifier,
      source_principal_id, source_kind, source_display_name, search_rank`;
    let baseSql = `SELECT ${selectFields}${rankExpression ? `, ${rankExpression} AS search_rank` : ''}
      FROM kb_fact f JOIN knowledge_base kb ON kb.id = f.kb_id
      LEFT JOIN kb_entity e ON e.id = f.entity_id AND e.kb_id = f.kb_id
      LEFT JOIN principal pr ON pr.id = f.source_principal_id
      LEFT JOIN agent ON agent.id = pr.id LEFT JOIN app_user ON app_user.id = pr.id
      WHERE ${resolvedScope.sql}`;
    const params: unknown[] = [...rankParams, ...resolvedScope.params];
    if (query) {
      baseSql += ` AND ${this.searchTermsPredicate(query, fields, params)}`;
    }
    if (filters.category) { baseSql += ' AND f.category = ?'; params.push(filters.category); }
    if (filters.entity_id) { baseSql += ' AND f.entity_id = ?'; params.push(filters.entity_id); }
    if (filters.entity_type) { baseSql += ' AND e.type = ?'; params.push(filters.entity_type); }
    if (filters.attached === true) baseSql += ' AND f.entity_id IS NOT NULL';
    if (filters.attached === false) baseSql += ' AND f.entity_id IS NULL';
    if (filters.has_source === true) baseSql += ' AND f.source_principal_id IS NOT NULL';
    if (filters.has_source === false) baseSql += ' AND f.source_principal_id IS NULL';

    let sql = baseSql;
    if (query) {
      sql = `SELECT ${summaryFields} FROM (${baseSql}) AS ranked`;
      if (cursor) {
        const scopePriority = this.searchCursorScopePriority(cursor[0]);
        const rank = this.searchCursorRank(cursor[1]);
        sql += ` WHERE (kb_is_global > ? OR (kb_is_global = ? AND
          (search_rank < ? OR (search_rank = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))))))`;
        params.push(scopePriority, scopePriority, rank, rank, cursor[2], cursor[2], cursor[3]);
      }
      sql += ' ORDER BY kb_is_global ASC, search_rank DESC, updated_at DESC, id DESC LIMIT ?';
    } else {
      if (cursor) {
        const scopePriority = this.searchCursorScopePriority(cursor[0]);
        sql += ` AND (kb.is_global > ? OR (kb.is_global = ? AND
          (f.updated_at < ? OR (f.updated_at = ? AND f.id < ?))))`;
        params.push(scopePriority, scopePriority, cursor[1], cursor[1], cursor[2]);
      }
      sql += ' ORDER BY kb.is_global ASC, f.updated_at DESC, f.id DESC LIMIT ?';
    }
    params.push(limit + 1);
    const rows = await this.db.query<Record<string, unknown>>(sql, params);
    const included = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = included.at(-1);
    return {
      items: included.map(row => this.mapFactBrowseSummary(row)),
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore && last
          ? encodeCursor(cursorScope, query
            ? [String(Number(last.kb_is_global || 0)), String(last.search_rank), String(last.updated_at), String(last.id)]
            : [String(Number(last.kb_is_global || 0)), String(last.updated_at), String(last.id)])
          : null,
      },
    };
  }

  async listScopedEntitiesPage(
    scopeInput: KBReadScopeInput,
    filters: KBEntityListFilters = {},
    options: PageOptions = {},
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<Page<KBEntitySummary>> {
    const scope = await this.readScopeResolver.resolve(scopeInput, auth);
    const limit = normalizePageLimit(options.limit);
    const cursorScope = `knowledge-entities:${scope.cursor_key}:${JSON.stringify({ type: filters.type || null })}`;
    const cursor = decodeCursor(options.cursor, cursorScope, 3);
    const resolvedScope = scope.predicate('e.kb_id');
    let sql = `${this.entitySummarySelect()} WHERE ${resolvedScope.sql}`;
    const params: unknown[] = [...resolvedScope.params];
    if (filters.type) { sql += ' AND e.type = ?'; params.push(filters.type); }
    if (cursor) {
      sql += ` AND (LOWER(e.name) > ? OR (LOWER(e.name) = ? AND
        (e.name > ? OR (e.name = ? AND e.id > ?))))`;
      params.push(cursor[0], cursor[0], cursor[1], cursor[1], cursor[2]);
    }
    sql += ' ORDER BY LOWER(e.name) ASC, e.name ASC, e.id ASC LIMIT ?'; params.push(limit + 1);
    const rows = await this.db.query<Record<string, unknown>>(sql, params);
    const included = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = included.at(-1);
    return {
      items: included.map(row => this.mapEntitySummary(row)),
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore && last
          ? encodeCursor(cursorScope, [String(last.name).toLowerCase(), String(last.name), String(last.id)])
          : null,
      },
    };
  }

  async getEntityContext(
    scopeInput: KBReadScopeInput,
    reference: KBEntityReference,
    options: KBEntityContextOptions = {},
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<KBEntityContext> {
    const scope = await this.readScopeResolver.resolve(scopeInput, auth);
    const hasId = Boolean(reference.entity_id);
    const hasQuery = Boolean(reference.query?.trim());
    if (hasId === hasQuery) {
      throw new ValidationError('Exactly one of entity_id or query is required', {
        fields: ['entity_id', 'query'], code: 'KB_ENTITY_REFERENCE_REQUIRED',
      });
    }
    const depth = this.boundedInteger(options.depth, 1, 0, 2, 'depth');
    const nodeLimit = this.boundedInteger(options.max_nodes, 50, 1, 100, 'max_nodes');
    const edgeLimit = this.boundedInteger(options.max_edges, 200, 1, 500, 'max_edges');
    const factLimit = this.boundedInteger(options.fact_limit, 20, 1, 100, 'fact_limit');
    const relationTypes = [...new Set(options.relation_types || [])].sort();
    const entityTypes = [...new Set(options.entity_types || [])].sort();
    if (relationTypes.length > 50 || entityTypes.length > 50) {
      throw new ValidationError('Context filter lists may contain at most 50 values');
    }

    const candidateScope = scope.predicate('e.kb_id');
    const candidateParams: unknown[] = [...candidateScope.params];
    let candidateWhere: string;
    if (reference.entity_id) {
      candidateWhere = 'e.id = ?'; candidateParams.push(reference.entity_id);
    } else {
      candidateWhere = '(e.identifier = ? OR LOWER(e.name) = LOWER(?))';
      candidateParams.push(reference.query!.trim(), reference.query!.trim());
    }
    const candidateRows = await this.db.query<Record<string, unknown>>(
      `SELECT e.id, e.kb_id, e.name, e.type, e.identifier, kb.name AS kb_name
       FROM kb_entity e JOIN knowledge_base kb ON kb.id = e.kb_id
       WHERE ${candidateScope.sql} AND ${candidateWhere}
       ORDER BY kb.name ASC, kb.id ASC, LOWER(e.name) ASC, e.name ASC, e.id ASC LIMIT 21`,
      candidateParams,
    );
    if (candidateRows.length === 0) throw new NotFoundError('Entity knowledge not found');
    if (candidateRows.length > 1) {
      throw new KBEntityAmbiguityError({
        candidates: candidateRows.slice(0, 20).map(row => this.mapEntityCandidate(row)),
        candidate_count_at_least: candidateRows.length > 20 ? 21 : candidateRows.length,
        candidates_truncated: candidateRows.length > 20,
      });
    }
    const root = this.mapEntityCandidate(candidateRows[0]);
    const facts = await this.listKnowledgePage(
      scopeInput, { entity_id: root.id }, { cursor: options.fact_cursor, limit: factLimit }, auth,
    );
    const depths = new Map<string, number>([[root.id, 0]]);
    let frontier = [root.id];
    const edges = new Map<string, KBEntityContextEdge>();
    const expandable = new Set<string>();
    let truncated = false;

    for (let hop = 1; hop <= depth && frontier.length > 0; hop += 1) {
      const placeholders = frontier.map(() => '?').join(',');
      const params: unknown[] = [root.knowledge_base.id, ...frontier, ...frontier];
      let sql = `SELECT r.id, r.kb_id, r.source_entity_id, r.target_entity_id, r.relation_type, r.created_at,
        source.type AS source_type, target.type AS target_type
        FROM kb_relation r
        JOIN kb_entity source ON source.id = r.source_entity_id AND source.kb_id = r.kb_id
        JOIN kb_entity target ON target.id = r.target_entity_id AND target.kb_id = r.kb_id
        WHERE r.kb_id = ? AND (r.source_entity_id IN (${placeholders}) OR r.target_entity_id IN (${placeholders}))`;
      if (relationTypes.length) {
        sql += ` AND r.relation_type IN (${relationTypes.map(() => '?').join(',')})`;
        params.push(...relationTypes);
      }
      sql += ' ORDER BY r.created_at ASC, r.id ASC LIMIT ?'; params.push(edgeLimit + 1);
      const relationRows = await this.db.query<Record<string, unknown>>(sql, params);
      if (relationRows.length > edgeLimit) {
        truncated = true; frontier.forEach(id => expandable.add(id));
      }
      const nextFrontier = new Set<string>();
      for (const row of relationRows.slice(0, edgeLimit)) {
        const edgeId = String(row.id);
        if (edges.has(edgeId)) continue;
        const sourceId = String(row.source_entity_id);
        const targetId = String(row.target_entity_id);
        const sourceInFrontier = frontier.includes(sourceId);
        const neighborId = sourceInFrontier ? targetId : sourceId;
        const neighborType = String(sourceInFrontier ? row.target_type : row.source_type);
        if (entityTypes.length && !entityTypes.includes(neighborType)) continue;
        if (!depths.has(neighborId)) {
          if (depths.size >= nodeLimit) {
            truncated = true; frontier.forEach(id => expandable.add(id)); continue;
          }
          depths.set(neighborId, hop); nextFrontier.add(neighborId);
        }
        if (edges.size >= edgeLimit) {
          truncated = true; frontier.forEach(id => expandable.add(id)); break;
        }
        edges.set(edgeId, {
          id: edgeId,
          kb_id: String(row.kb_id),
          source: sourceId,
          target: targetId,
          relation_type: String(row.relation_type),
          created_at: String(row.created_at),
        });
      }
      frontier = [...nextFrontier];
    }
    if (frontier.length > 0 && depth > 0) frontier.forEach(id => expandable.add(id));
    const nodeRows = await this.entitySummaryRows(scope, [...depths.keys()]);
    const nodes: KBEntityContextNode[] = nodeRows
      .map(row => ({ ...this.mapEntitySummary(row), depth: depths.get(String(row.id)) || 0 }))
      .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return {
      scope: scope.summary,
      root,
      facts,
      nodes,
      edges: [...edges.values()],
      depth,
      truncation: {
        truncated,
        node_limit: nodeLimit,
        edge_limit: edgeLimit,
        nodes_returned: nodes.length,
        edges_returned: edges.size,
        expandable_entity_ids: [...expandable].sort(),
      },
    };
  }

  private async entitySummaryRows(scope: ResolvedKBReadScope, entityIds: string[]): Promise<Record<string, unknown>[]> {
    if (entityIds.length === 0) return [];
    const resolvedScope = scope.predicate('e.kb_id');
    return this.db.query<Record<string, unknown>>(
      `${this.entitySummarySelect()} WHERE ${resolvedScope.sql}
       AND e.id IN (${entityIds.map(() => '?').join(',')})`,
      [...resolvedScope.params, ...entityIds],
    );
  }

  private entitySummarySelect(): string {
    return `SELECT e.id, e.name, e.type, e.identifier, e.created_at, e.updated_at,
      kb.id AS kb_id, kb.name AS kb_name,
      (SELECT COUNT(*) FROM kb_fact fact WHERE fact.entity_id = e.id AND fact.kb_id = e.kb_id) AS fact_count,
      (SELECT COUNT(*) FROM kb_relation incoming WHERE incoming.target_entity_id = e.id AND incoming.kb_id = e.kb_id) AS incoming_relation_count,
      (SELECT COUNT(*) FROM kb_relation outgoing WHERE outgoing.source_entity_id = e.id AND outgoing.kb_id = e.kb_id) AS outgoing_relation_count
      FROM kb_entity e JOIN knowledge_base kb ON kb.id = e.kb_id`;
  }

  private mapFactBrowseSummary(row: Record<string, unknown>): KBFactBrowseSummary {
    const sourceId = row.source_principal_id ? String(row.source_principal_id) : null;
    const entityId = row.entity_id ? String(row.entity_id) : null;
    return {
      id: String(row.id),
      title: String(row.title),
      excerpt: String(row.excerpt || ''),
      knowledge_base: { id: String(row.kb_id), name: String(row.kb_name) },
      category: String(row.category),
      confidence: Number(row.confidence),
      entity: entityId ? {
        id: entityId,
        name: String(row.entity_name),
        type: String(row.entity_type),
        identifier: row.entity_identifier === null || row.entity_identifier === undefined
          ? null : String(row.entity_identifier),
      } : null,
      source: sourceId ? {
        principal_id: sourceId,
        kind: row.source_kind ? String(row.source_kind) : null,
        display_name: row.source_display_name ? String(row.source_display_name) : null,
      } : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  private mapEntitySummary(row: Record<string, unknown>): KBEntitySummary {
    return {
      id: String(row.id),
      name: String(row.name),
      type: String(row.type),
      identifier: row.identifier === null || row.identifier === undefined ? null : String(row.identifier),
      knowledge_base: { id: String(row.kb_id), name: String(row.kb_name) },
      fact_count: Number(row.fact_count || 0),
      incoming_relation_count: Number(row.incoming_relation_count || 0),
      outgoing_relation_count: Number(row.outgoing_relation_count || 0),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  private mapEntityCandidate(row: Record<string, unknown>): KBEntityCandidate {
    return {
      id: String(row.id),
      name: String(row.name),
      type: String(row.type),
      identifier: row.identifier === null || row.identifier === undefined ? null : String(row.identifier),
      knowledge_base: { id: String(row.kb_id), name: String(row.kb_name) },
    };
  }

  private boundedInteger(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
      throw new ValidationError(`${field} must be an integer between ${min} and ${max}`, {
        field, minimum: min, maximum: max,
      });
    }
    return resolved;
  }

  // --- Aggregated Knowledge & Graph Queries ---

  async getEntityKnowledge(queryStr: string, kbIds?: string[], optionsOrAuth: PageOptions | AuthContext = {}, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<EntityKnowledgeResult | null> {
    const isAuth = 'principal' in optionsOrAuth || 'workspace_id' in optionsOrAuth;
    const options: PageOptions = isAuth ? {} : optionsOrAuth as PageOptions;
    if (isAuth) auth = optionsOrAuth as AuthContext;
    if (kbIds?.length) await assertResourcesWorkspace(this.db, auth, kbIds.map(id => ['knowledge_base', id]));
    let sql = 'SELECT id, kb_id, name, type, identifier, created_at, updated_at FROM kb_entity WHERE (id = ? OR identifier = ? OR LOWER(name) = LOWER(?))';
    const params: unknown[] = [queryStr, queryStr, queryStr];

    if (kbIds?.length) {
      sql += ` AND kb_id IN (${kbIds.map(() => '?').join(',')})`;
      params.push(...kbIds);
    }

    const entities = await this.db.query<KBEntity>(sql, params);
    if (!entities[0]) return null;

    const entity = entities[0];
    await assertResourceWorkspace(this.db, auth, 'kb_entity', entity.id);
    const limit = normalizePageLimit(options.limit);
    const scope = `entity-knowledge:${entity.id}`;
    const cursor = decodeCursor(options.cursor, scope, 3);
    const phase = cursor?.[0] || 'facts';
    const afterCreated = cursor?.[1] || '';
    const afterId = cursor?.[2] || '';
    let facts: KBFactSummary[] = [];
    let outgoing: Array<Omit<KBRelation, 'description'>> = [];
    let incoming: Array<Omit<KBRelation, 'description'>> = [];
    let rows: Array<KBFactSummary | Omit<KBRelation, 'description'>>;
    if (phase === 'facts') {
      const params: unknown[] = [entity.id];
      let factSql = `SELECT f.id, f.kb_id, f.entity_id, f.title, f.category, f.confidence,
        f.source_principal_id, f.created_at, f.updated_at, e.name as entity_name,
        e.identifier as entity_identifier FROM kb_fact f LEFT JOIN kb_entity e ON f.entity_id=e.id AND f.kb_id=e.kb_id
        WHERE f.entity_id = ?`;
      if (afterCreated) { factSql += ' AND (f.created_at > ? OR (f.created_at = ? AND f.id > ?))'; params.push(afterCreated, afterCreated, afterId); }
      factSql += ' ORDER BY f.created_at ASC, f.id ASC LIMIT ?'; params.push(limit + 1);
      rows = await this.db.query<KBFactSummary>(factSql, params); facts = rows.slice(0, limit) as KBFactSummary[];
    } else {
      const outgoingPhase = phase === 'outgoing';
      const params: unknown[] = [entity.id];
      let relSql = `SELECT r.id,r.kb_id,r.source_entity_id,r.target_entity_id,r.relation_type,r.created_at,
        e.name as ${outgoingPhase ? 'target' : 'source'}_entity_name FROM kb_relation r
        JOIN kb_entity e ON e.id=r.${outgoingPhase ? 'target' : 'source'}_entity_id AND e.kb_id=r.kb_id
        WHERE r.${outgoingPhase ? 'source' : 'target'}_entity_id = ? AND r.kb_id = ?`;
      params.push(entity.kb_id);
      if (afterCreated) { relSql += ' AND (r.created_at > ? OR (r.created_at = ? AND r.id > ?))'; params.push(afterCreated, afterCreated, afterId); }
      relSql += ' ORDER BY r.created_at ASC, r.id ASC LIMIT ?'; params.push(limit + 1);
      rows = await this.db.query<Omit<KBRelation, 'description'>>(relSql, params);
      if (outgoingPhase) outgoing = rows.slice(0, limit) as Array<Omit<KBRelation, 'description'>>;
      else incoming = rows.slice(0, limit) as Array<Omit<KBRelation, 'description'>>;
    }
    let moreInPhase = rows.length > limit;
    let nextPhase: string | null = moreInPhase ? phase : phase === 'facts' ? 'outgoing' : phase === 'outgoing' ? 'incoming' : null;
    let last = rows.slice(0, limit).at(-1);
    // Preserve the convenient legacy shape for small entity profiles while
    // enforcing one shared row budget across all three collections.
    if (!cursor && phase === 'facts' && !moreInPhase && facts.length < limit) {
      let remaining = limit - facts.length;
      const outgoingRows = await this.db.query<Omit<KBRelation, 'description'>>(
        `SELECT r.id,r.kb_id,r.source_entity_id,r.target_entity_id,r.relation_type,r.created_at,e.name target_entity_name
         FROM kb_relation r JOIN kb_entity e ON e.id=r.target_entity_id AND e.kb_id=r.kb_id
         WHERE r.source_entity_id=? AND r.kb_id=? ORDER BY r.created_at ASC,r.id ASC LIMIT ?`, [entity.id, entity.kb_id, remaining + 1]);
      outgoing = outgoingRows.slice(0, remaining);
      if (outgoingRows.length > remaining) {
        moreInPhase = true; nextPhase = 'outgoing'; last = outgoing.at(-1);
      } else {
        remaining -= outgoing.length;
        const incomingRows = await this.db.query<Omit<KBRelation, 'description'>>(
          `SELECT r.id,r.kb_id,r.source_entity_id,r.target_entity_id,r.relation_type,r.created_at,e.name source_entity_name
           FROM kb_relation r JOIN kb_entity e ON e.id=r.source_entity_id AND e.kb_id=r.kb_id
           WHERE r.target_entity_id=? AND r.kb_id=? ORDER BY r.created_at ASC,r.id ASC LIMIT ?`, [entity.id, entity.kb_id, remaining + 1]);
        incoming = incomingRows.slice(0, remaining);
        moreInPhase = incomingRows.length > remaining;
        nextPhase = moreInPhase ? 'incoming' : null;
        last = incoming.at(-1);
      }
    }

    return {
      entity,
      facts,
      outgoing_relations: outgoing,
      incoming_relations: incoming,
      page: {
        limit,
        has_more: nextPhase !== null,
        next_cursor: nextPhase ? encodeCursor(scope, [nextPhase, moreInPhase ? (last?.created_at || '') : '', moreInPhase ? (last?.id || '') : '']) : null,
      },
    };
  }

  async searchKnowledge(query: string, kbIds?: string[], limit: number = 20, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<{ facts: KBFact[]; entities: KBEntity[] }> {
    const normalizedQuery = normalizeKBSearchQuery(query);
    limit = normalizePageLimit(limit);
    const accessibleKbIds = kbIds?.length ? kbIds : (await this.list(undefined, auth)).map(kb => kb.id);
    await assertResourcesWorkspace(this.db, auth, accessibleKbIds.map(id => ['knowledge_base', id]));
    const scopedWorkspace = workspaceIdFor(auth);
    const factFields: KBSearchFields = {
      title: 'f.title',
      entityName: 'e.name',
      entityIdentifier: 'e.identifier',
      entityType: 'e.type',
      category: 'f.category',
      content: 'f.content',
    };
    const factRankParams: unknown[] = [];
    const factRank = this.searchRankExpression(normalizedQuery, factFields, factRankParams);
    let factSql = `SELECT f.*, e.name as entity_name, e.identifier as entity_identifier, ${factRank} AS search_rank
                   FROM kb_fact f
                   LEFT JOIN kb_entity e ON f.entity_id = e.id AND e.kb_id = f.kb_id
                   WHERE ${this.searchTermsPredicate(normalizedQuery, factFields, factRankParams)}`;
    const factParams: unknown[] = [...factRankParams];

    if (accessibleKbIds.length > 0) {
      factSql += ` AND f.kb_id IN (${accessibleKbIds.map(() => '?').join(',')})`;
      factParams.push(...accessibleKbIds);
    } else if (scopedWorkspace) {
      return { facts: [], entities: [] };
    }

    if (scopedWorkspace) {
      factSql += ` AND (
        f.entity_id IS NULL OR EXISTS (
          SELECT 1 FROM kb_entity fact_entity
          WHERE fact_entity.id = f.entity_id AND fact_entity.kb_id = f.kb_id
        )
      )`;
    }

    factSql += ' ORDER BY search_rank DESC, f.updated_at DESC, f.id DESC LIMIT ?';
    factParams.push(limit);

    const factRows = await this.db.query<Record<string, unknown>>(factSql, factParams);
    const facts = factRows.map(row => {
      const { search_rank: _searchRank, ...fact } = row;
      return fact as unknown as KBFact;
    });

    const entityFields: KBSearchFields = {
      title: 'e.name',
      entityName: 'e.name',
      entityIdentifier: 'e.identifier',
      entityType: 'e.type',
      category: 'NULL',
      content: 'NULL',
    };
    const entityRankParams: unknown[] = [];
    const entityRank = this.searchRankExpression(normalizedQuery, entityFields, entityRankParams);
    let entitySql = `SELECT e.*, ${entityRank} AS search_rank FROM kb_entity e
      WHERE ${this.searchTermsPredicate(normalizedQuery, entityFields, entityRankParams)}`;
    const entityParams: unknown[] = [...entityRankParams];

    if (accessibleKbIds.length > 0) {
      entitySql += ` AND e.kb_id IN (${accessibleKbIds.map(() => '?').join(',')})`;
      entityParams.push(...accessibleKbIds);
    }

    entitySql += ' ORDER BY search_rank DESC, e.updated_at DESC, e.id DESC LIMIT ?';
    entityParams.push(limit);

    const entityRows = await this.db.query<Record<string, unknown>>(entitySql, entityParams);
    const entities = entityRows.map(row => {
      const { search_rank: _searchRank, ...entity } = row;
      return entity as unknown as KBEntity;
    });

    return { facts, entities };
  }

  async searchKnowledgePage(
    query: string,
    kbIds?: string[],
    options: PageOptions = {},
    projectId?: string,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<{ facts: KBFactSummary[]; entities: KBEntity[]; page: PageInfo }> {
    const normalizedQuery = normalizeKBSearchQuery(query);
    const projectScope = projectId
      ? await this.readScopeResolver.resolve({ project_id: projectId }, auth)
      : null;
    if (kbIds?.length) await assertResourcesWorkspace(this.db, auth, kbIds.map(id => ['knowledge_base', id]));
    const scopedWorkspace = workspaceIdFor(auth);
    const limit = normalizePageLimit(options.limit ?? 20);
    const normalizedKbIds = kbIds ? [...kbIds].sort() : undefined;
    const scope = `knowledge-search:${JSON.stringify({
      query: normalizedQuery.canonical,
      search_rank_version: KB_SEARCH_RANK_VERSION,
      kbIds: normalizedKbIds || null,
      projectId: projectId || null,
      workspace: scopedWorkspace || null,
    })}`;
    const cursor = decodeCursor(options.cursor, scope, 4);
    const phase = cursor?.[0] || 'facts';
    if (phase !== 'facts' && phase !== 'entities') {
      throw new ValidationError('cursor is invalid, stale, or belongs to a different collection', {
        field: 'cursor', code: 'INVALID_CURSOR',
      });
    }
    let factRows: Array<Record<string, unknown>> = [];
    let entityRows: Array<Record<string, unknown>> = [];
    let facts: KBFactSummary[] = [];
    let entities: KBEntity[] = [];

    if (phase === 'facts') {
      const fields: KBSearchFields = {
        title: 'f.title',
        entityName: 'e.name',
        entityIdentifier: 'e.identifier',
        entityType: 'e.type',
        category: 'f.category',
        content: 'f.content',
      };
      const rankParams: unknown[] = [];
      const rankExpression = this.searchRankExpression(normalizedQuery, fields, rankParams);
      const factFields = `f.id, f.kb_id, f.entity_id, f.title, f.category, f.confidence,
        f.source_principal_id, f.created_at, f.updated_at, e.name as entity_name,
        e.identifier as entity_identifier`;
      const factOutputFields = `id, kb_id, entity_id, title, category, confidence,
        source_principal_id, created_at, updated_at, entity_name, entity_identifier`;
      let baseSql = `SELECT ${factFields}, ${rankExpression} AS search_rank FROM kb_fact f
        LEFT JOIN kb_entity e ON f.entity_id = e.id AND f.kb_id=e.kb_id
        WHERE ${this.searchTermsPredicate(normalizedQuery, fields, rankParams)}`;
      const params: unknown[] = [...rankParams];
      if (normalizedKbIds?.length) {
        baseSql += ` AND f.kb_id IN (${normalizedKbIds.map(() => '?').join(',')})`;
        params.push(...normalizedKbIds);
      }
      if (projectScope) {
        const resolved = projectScope.predicate('f.kb_id');
        baseSql += ` AND ${resolved.sql}`; params.push(...resolved.params);
      }
      if (scopedWorkspace) {
        baseSql += ' AND EXISTS (SELECT 1 FROM project_knowledge_base ok JOIN project p ON p.id=ok.project_id WHERE ok.kb_id=f.kb_id AND p.workspace_id=?) AND NOT EXISTS (SELECT 1 FROM project_knowledge_base bad JOIN project p2 ON p2.id=bad.project_id WHERE bad.kb_id=f.kb_id AND p2.workspace_id<>?) AND (f.entity_id IS NULL OR EXISTS (SELECT 1 FROM kb_entity valid_entity WHERE valid_entity.id=f.entity_id AND valid_entity.kb_id=f.kb_id))';
        params.push(scopedWorkspace, scopedWorkspace);
      }
      let sql = `SELECT ${factOutputFields}, search_rank FROM (${baseSql}) AS ranked`;
      if (cursor && cursor[1]) {
        const rank = this.searchCursorRank(cursor[1]);
        sql += ' WHERE (search_rank < ? OR (search_rank = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))))';
        params.push(rank, rank, cursor[2], cursor[2], cursor[3]);
      }
      sql += ' ORDER BY search_rank DESC, updated_at DESC, id DESC LIMIT ?';
      params.push(limit + 1);
      factRows = await this.db.query<Record<string, unknown>>(sql, params);
      facts = factRows.slice(0, limit).map(row => {
        const { search_rank: _searchRank, ...fact } = row;
        return fact as KBFactSummary;
      });
    }

    if (phase === 'entities') {
      const fields: KBSearchFields = {
        title: 'e.name',
        entityName: 'e.name',
        entityIdentifier: 'e.identifier',
        entityType: 'e.type',
        category: 'NULL',
        content: 'NULL',
      };
      const rankParams: unknown[] = [];
      const rankExpression = this.searchRankExpression(normalizedQuery, fields, rankParams);
      const entityFields = 'e.id,e.kb_id,e.name,e.type,e.identifier,e.created_at,e.updated_at';
      const entityOutputFields = 'id,kb_id,name,type,identifier,created_at,updated_at';
      let baseSql = `SELECT ${entityFields}, ${rankExpression} AS search_rank FROM kb_entity e
        WHERE ${this.searchTermsPredicate(normalizedQuery, fields, rankParams)}`;
      const params: unknown[] = [...rankParams];
      if (normalizedKbIds?.length) {
        baseSql += ` AND e.kb_id IN (${normalizedKbIds.map(() => '?').join(',')})`;
        params.push(...normalizedKbIds);
      }
      if (projectScope) {
        const resolved = projectScope.predicate('e.kb_id');
        baseSql += ` AND ${resolved.sql}`; params.push(...resolved.params);
      }
      if (scopedWorkspace) {
        baseSql += ' AND EXISTS (SELECT 1 FROM project_knowledge_base ok JOIN project p ON p.id=ok.project_id WHERE ok.kb_id=e.kb_id AND p.workspace_id=?) AND NOT EXISTS (SELECT 1 FROM project_knowledge_base bad JOIN project p2 ON p2.id=bad.project_id WHERE bad.kb_id=e.kb_id AND p2.workspace_id<>?)';
        params.push(scopedWorkspace, scopedWorkspace);
      }
      let sql = `SELECT ${entityOutputFields}, search_rank FROM (${baseSql}) AS ranked`;
      if (cursor && cursor[1]) {
        const rank = this.searchCursorRank(cursor[1]);
        sql += ' WHERE (search_rank < ? OR (search_rank = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))))';
        params.push(rank, rank, cursor[2], cursor[2], cursor[3]);
      }
      sql += ' ORDER BY search_rank DESC, updated_at DESC, id DESC LIMIT ?';
      params.push(limit + 1);
      entityRows = await this.db.query<Record<string, unknown>>(sql, params);
      entities = entityRows.slice(0, limit).map(row => {
        const { search_rank: _searchRank, ...entity } = row;
        return entity as unknown as KBEntity;
      });
    }

    let factMore = factRows.length > limit;
    let entityMore = entityRows.length > limit;
    const factItems = facts.slice(0, limit);
    const entityItems = entities.slice(0, limit);
    // Row limits alone do not bound bytes when user-controlled summary fields
    // approach their individual maxima. Keep headroom for the envelope/cursor.
    while (Buffer.byteLength(JSON.stringify({ facts: factItems, entities: entityItems }), 'utf8') > 90_000
      && factItems.length + entityItems.length > 1) {
      if (entityItems.length) { entityItems.pop(); entityMore = true; }
      else { factItems.pop(); factMore = true; }
    }
    const lastFact = factItems[factItems.length - 1];
    const lastEntity = entityItems[entityItems.length - 1];
    const hasMore = phase === 'facts' ? true : entityMore;
    const lastFactRow = factRows[factItems.length - 1];
    const lastEntityRow = entityRows[entityItems.length - 1];
    return {
      facts: factItems,
      entities: entityItems,
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore ? encodeCursor(scope, phase === 'facts' && factMore
          ? ['facts', String(lastFactRow?.search_rank || ''), lastFact?.updated_at || '', lastFact?.id || '']
          : phase === 'facts'
            ? ['entities', '', '', '']
            : ['entities', String(lastEntityRow?.search_rank || ''), lastEntity?.updated_at || '', lastEntity?.id || '']) : null,
      },
    };
  }

  async getGraphTree(kbId?: string, projectId?: string, optionsOrAuth: PageOptions | AuthContext = {}, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KBGraphTree> {
    const isAuth = 'principal' in optionsOrAuth || 'workspace_id' in optionsOrAuth;
    const options: PageOptions = isAuth ? {} : optionsOrAuth as PageOptions;
    if (isAuth) auth = optionsOrAuth as AuthContext;
    if (kbId) await assertResourceWorkspace(this.db, auth, 'knowledge_base', kbId);
    const projectScope = projectId
      ? await this.readScopeResolver.resolve({ project_id: projectId }, auth)
      : null;
    const scopedWorkspace = workspaceIdFor(auth);
    const limit = normalizePageLimit(options.limit);
    const scope = `kb-graph:${kbId || ''}:${projectId || ''}:${scopedWorkspace || 'open'}`;
    const cursor = decodeCursor(options.cursor, scope, 3);
    const phase = cursor?.[0] || 'nodes';
    const params: unknown[] = [];
    const filter = (alias: string) => {
      const clauses: string[] = [];
      if (kbId) { params.push(kbId); clauses.push(`${alias}.kb_id = ?`); }
      if (projectScope) {
        const resolved = projectScope.predicate(`${alias}.kb_id`);
        clauses.push(resolved.sql); params.push(...resolved.params);
      }
      if (scopedWorkspace) {
        clauses.push(`EXISTS (SELECT 1 FROM project_knowledge_base ok JOIN project p ON p.id=ok.project_id WHERE ok.kb_id=${alias}.kb_id AND p.workspace_id=?)`);
        clauses.push(`NOT EXISTS (SELECT 1 FROM project_knowledge_base bad JOIN project p2 ON p2.id=bad.project_id WHERE bad.kb_id=${alias}.kb_id AND p2.workspace_id<>?)`);
        params.push(scopedWorkspace, scopedWorkspace);
      }
      return clauses.length ? clauses.join(' AND ') : '1=1';
    };
    let entities: Array<KBEntity & { fact_count: number }> = [];
    let links: KBRelation[] = [];
    if (phase === 'nodes') {
      let sql = `SELECT e.id,e.kb_id,e.name,e.type,e.identifier,e.created_at,e.updated_at,COUNT(f.id) fact_count FROM kb_entity e LEFT JOIN kb_fact f ON e.id=f.entity_id AND e.kb_id=f.kb_id WHERE ${filter('e')}`;
      if (cursor?.[1]) { sql += ' AND (e.name > ? OR (e.name=? AND e.id>?))'; params.push(cursor[1], cursor[1], cursor[2]); }
      sql += ' GROUP BY e.id ORDER BY e.name ASC,e.id ASC LIMIT ?'; params.push(limit + 1);
      entities = await this.db.query(sql, params);
    } else {
      let sql = `SELECT r.id,r.kb_id,r.source_entity_id,r.target_entity_id,r.relation_type,r.created_at FROM kb_relation r JOIN kb_entity source ON source.id=r.source_entity_id AND source.kb_id=r.kb_id JOIN kb_entity target ON target.id=r.target_entity_id AND target.kb_id=r.kb_id WHERE ${filter('r')}`;
      if (cursor?.[1]) { sql += ' AND (r.created_at > ? OR (r.created_at=? AND r.id>?))'; params.push(cursor[1], cursor[1], cursor[2]); }
      sql += ' ORDER BY r.created_at ASC,r.id ASC LIMIT ?'; params.push(limit + 1);
      links = await this.db.query(sql, params);
    }
    // When a continued node page exhausts the node phase with spare capacity,
    // start the link phase in that same response. Restricting this fill to the
    // first request loses every link after a final partial node page.
    if (phase === 'nodes' && entities.length <= limit && entities.length < limit) {
      const remaining = limit - entities.length;
      const linkParams: unknown[] = [];
      const linkClauses: string[] = [];
      if (kbId) { linkClauses.push('r.kb_id=?'); linkParams.push(kbId); }
      if (projectScope) {
        const resolved = projectScope.predicate('r.kb_id');
        linkClauses.push(resolved.sql); linkParams.push(...resolved.params);
      }
      if (scopedWorkspace) {
        linkClauses.push('EXISTS (SELECT 1 FROM project_knowledge_base ok JOIN project p ON p.id=ok.project_id WHERE ok.kb_id=r.kb_id AND p.workspace_id=?)');
        linkClauses.push('NOT EXISTS (SELECT 1 FROM project_knowledge_base bad JOIN project p2 ON p2.id=bad.project_id WHERE bad.kb_id=r.kb_id AND p2.workspace_id<>?)');
        linkParams.push(scopedWorkspace, scopedWorkspace);
      }
      linkParams.push(remaining + 1);
      links = await this.db.query(`SELECT r.id,r.kb_id,r.source_entity_id,r.target_entity_id,r.relation_type,r.created_at
        FROM kb_relation r JOIN kb_entity source ON source.id=r.source_entity_id AND source.kb_id=r.kb_id JOIN kb_entity target ON target.id=r.target_entity_id AND target.kb_id=r.kb_id
        WHERE ${linkClauses.length ? linkClauses.join(' AND ') : '1=1'} ORDER BY r.created_at ASC,r.id ASC LIMIT ?`, linkParams);
    }

    const nodes: KBGraphNode[] = entities.map(e => ({
      id: e.id,
      name: e.name,
      type: e.type,
      identifier: e.identifier,
      kb_id: e.kb_id,
      fact_count: e.fact_count || 0,
    }));

    const graphLinks: KBGraphLink[] = links.map(l => ({
      id: l.id,
      source: l.source_entity_id,
      target: l.target_entity_id,
      relation_type: l.relation_type,
    }));
    const nodeItems = nodes.slice(0, limit);
    const remaining = Math.max(0, limit - nodeItems.length);
    const linkItems = graphLinks.slice(0, phase === 'nodes' ? remaining : limit);
    const nodeMore = entities.length > limit;
    const linkMore = links.length > (phase === 'nodes' ? remaining : limit);
    const hasMore = nodeMore || linkMore || (phase === 'nodes' && nodeItems.length === limit && !nodeMore);
    const nextPhase = nodeMore ? 'nodes' : 'links';
    // Cursor keys come from the database row, not the public link summary
    // (which intentionally omits created_at along with large descriptions).
    const included = nodeMore
      ? entities.slice(0, limit).at(-1)
      : links.slice(0, phase === 'nodes' ? remaining : limit).at(-1);
    return { nodes: nodeItems, links: linkItems, page: {
      limit, has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(scope, [nextPhase, nodeMore ? (included as KBEntity).name : linkMore ? ((included as unknown as KBRelation)?.created_at || '') : '', (nodeMore || linkMore) ? included?.id || '' : '']) : null,
    } };
  }

  private detectEntityType(str?: string | null): string {
    if (!str) return 'custom';
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(str)) return 'ip_address';
    if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(str)) return 'email';
    if (/^(server|host|node)-/i.test(str)) return 'server';
    if (/^(db|database|postgres|mysql|redis)-/i.test(str)) return 'database';
    if (/^(service|app|api)-/i.test(str)) return 'service';
    return 'custom';
  }
}
