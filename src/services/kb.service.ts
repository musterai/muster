// File: src/services/kb.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import {
  KnowledgeBase,
  CreateKnowledgeBase,
  KBEntity,
  UpsertKBEntity,
  KBFact,
  AddGainedKnowledge,
  KBRelation,
  AddKBRelation,
  EntityKnowledgeResult,
  KBGraphTree,
  KBGraphNode,
  KBGraphLink
} from '../shared/types.js';
import { EventService } from './event.service.js';
import type { AuthContext } from '../shared/auth-context.js';
import { OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import {
  assertResourceWorkspace,
  assertResourcesShareWorkspace,
  assertResourcesWorkspace,
  workspaceIdFor,
} from './helpers/workspace-scope.helper.js';

export class KBService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService
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
    const projectIds = await this.getLinkedProjectIds(kbId, adapter);
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
    kb.linked_project_ids = await this.getLinkedProjectIds(id);
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
               AND (kb.is_global = 1 OR selected_link.project_id IS NOT NULL)
             ORDER BY kb.created_at DESC`,
            [projectId, scopedWorkspace],
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
         WHERE p.workspace_id = ? ORDER BY kb.created_at DESC`,
        [scopedWorkspace],
      );
    } else {
      kbs = await this.db.query<KnowledgeBase>('SELECT * FROM knowledge_base ORDER BY created_at DESC');
    }

    for (const kb of kbs) {
      kb.linked_project_ids = await this.getLinkedProjectIds(kb.id);
    }

    return kbs;
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

  async getLinkedProjectIds(kbId: string, adapter: DatabaseAdapter = this.db): Promise<string[]> {
    const rows = await adapter.query<{ project_id: string }>(
      'SELECT project_id FROM project_knowledge_base WHERE kb_id = ?',
      [kbId]
    );
    return rows.map(r => r.project_id);
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
    let sql = `SELECT f.*, e.name as entity_name, e.identifier as entity_identifier 
               FROM kb_fact f 
               LEFT JOIN kb_entity e ON f.entity_id = e.id`;
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

    if (clauses.length > 0) {
      sql += ' WHERE ' + clauses.join(' AND ');
    }

    sql += ' ORDER BY f.created_at DESC';

    return this.db.query<KBFact>(sql, params);
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

  // --- Aggregated Knowledge & Graph Queries ---

  async getEntityKnowledge(queryStr: string, kbIds?: string[], auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<EntityKnowledgeResult | null> {
    const accessibleKbIds = kbIds?.length ? kbIds : (await this.list(undefined, auth)).map(kb => kb.id);
    await assertResourcesWorkspace(this.db, auth, accessibleKbIds.map(id => ['knowledge_base', id]));
    let sql = 'SELECT * FROM kb_entity WHERE (id = ? OR identifier = ? OR LOWER(name) = LOWER(?))';
    const params: unknown[] = [queryStr, queryStr, queryStr];

    if (accessibleKbIds.length > 0) {
      sql += ` AND kb_id IN (${accessibleKbIds.map(() => '?').join(',')})`;
      params.push(...accessibleKbIds);
    } else if (workspaceIdFor(auth)) {
      return null;
    }

    const entities = await this.db.query<KBEntity>(sql, params);
    if (!entities[0]) return null;

    const entity = entities[0];
    const facts = await this.listFacts(undefined, entity.id, undefined, auth);

    const outgoing = await this.db.query<KBRelation>(
      `SELECT r.*, e.name as target_entity_name 
       FROM kb_relation r 
       JOIN kb_entity e ON r.target_entity_id = e.id 
       WHERE r.source_entity_id = ?`,
      [entity.id]
    );

    const incoming = await this.db.query<KBRelation>(
      `SELECT r.*, e.name as source_entity_name 
       FROM kb_relation r 
       JOIN kb_entity e ON r.source_entity_id = e.id 
       WHERE r.target_entity_id = ?`,
      [entity.id]
    );

    return {
      entity,
      facts,
      outgoing_relations: outgoing,
      incoming_relations: incoming,
    };
  }

  async searchKnowledge(query: string, kbIds?: string[], limit: number = 20, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<{ facts: KBFact[]; entities: KBEntity[] }> {
    const accessibleKbIds = kbIds?.length ? kbIds : (await this.list(undefined, auth)).map(kb => kb.id);
    await assertResourcesWorkspace(this.db, auth, accessibleKbIds.map(id => ['knowledge_base', id]));
    const pattern = `%${query}%`;
    let factSql = `SELECT f.*, e.name as entity_name, e.identifier as entity_identifier
                   FROM kb_fact f
                   LEFT JOIN kb_entity e ON f.entity_id = e.id
                   WHERE (f.title LIKE ? OR f.content LIKE ? OR f.category LIKE ?)`;
    const factParams: unknown[] = [pattern, pattern, pattern];

    if (accessibleKbIds.length > 0) {
      factSql += ` AND f.kb_id IN (${accessibleKbIds.map(() => '?').join(',')})`;
      factParams.push(...accessibleKbIds);
    } else if (workspaceIdFor(auth)) {
      return { facts: [], entities: [] };
    }

    factSql += ' ORDER BY f.created_at DESC LIMIT ?';
    factParams.push(limit);

    const facts = await this.db.query<KBFact>(factSql, factParams);

    let entitySql = `SELECT * FROM kb_entity WHERE (name LIKE ? OR identifier LIKE ? OR type LIKE ?)`;
    const entityParams: unknown[] = [pattern, pattern, pattern];

    if (accessibleKbIds.length > 0) {
      entitySql += ` AND kb_id IN (${accessibleKbIds.map(() => '?').join(',')})`;
      entityParams.push(...accessibleKbIds);
    }

    entitySql += ' ORDER BY updated_at DESC LIMIT ?';
    entityParams.push(limit);

    const entities = await this.db.query<KBEntity>(entitySql, entityParams);

    return { facts, entities };
  }

  async getGraphTree(kbId?: string, projectId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<KBGraphTree> {
    let targetKbIds: string[] = [];

    if (kbId) {
      await assertResourceWorkspace(this.db, auth, 'knowledge_base', kbId);
      targetKbIds = [kbId];
    } else if (projectId) {
      const kbs = await this.list(projectId, auth);
      targetKbIds = kbs.map(k => k.id);
    } else {
      const kbs = await this.list(undefined, auth);
      targetKbIds = kbs.map(k => k.id);
    }

    if (targetKbIds.length === 0) {
      return { nodes: [], links: [] };
    }

    const inClause = targetKbIds.map(() => '?').join(',');
    const entities = await this.db.query<KBEntity>(
      `SELECT e.*, COUNT(f.id) as fact_count
       FROM kb_entity e
       LEFT JOIN kb_fact f ON e.id = f.entity_id
       WHERE e.kb_id IN (${inClause})
       GROUP BY e.id`,
      targetKbIds
    );

    const links = await this.db.query<KBRelation>(
      `SELECT * FROM kb_relation WHERE kb_id IN (${inClause})`,
      targetKbIds
    );

    const nodes: KBGraphNode[] = entities.map(e => ({
      id: e.id,
      name: e.name,
      type: e.type,
      identifier: e.identifier,
      kb_id: e.kb_id,
      fact_count: (e as unknown as { fact_count: number }).fact_count || 0,
    }));

    const graphLinks: KBGraphLink[] = links.map(l => ({
      id: l.id,
      source: l.source_entity_id,
      target: l.target_entity_id,
      relation_type: l.relation_type,
      description: l.description,
    }));

    return { nodes, links: graphLinks };
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
