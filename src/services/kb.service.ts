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
  KBGraphLink
} from '../shared/types.js';
import { EventService } from './event.service.js';
import { decodeCursor, encodeCursor, normalizePageLimit, Page, PageInfo, PageOptions, toPage } from '../shared/pagination.js';

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


  async create(data: CreateKnowledgeBase, actorId?: string, adapter?: DatabaseAdapter): Promise<KnowledgeBase> {
    if (!adapter) return this.db.transaction(tx => this.create(data, actorId, tx));
    const db = adapter;
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
        await this.linkProject(id, projectId, actorId, db);
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

  async getById(id: string): Promise<KnowledgeBase | null> {
    const rows = await this.db.query<KnowledgeBase>('SELECT * FROM knowledge_base WHERE id = ?', [id]);
    if (!rows[0]) return null;

    const kb = rows[0];
    kb.linked_project_ids = await this.getLinkedProjectIds(id);
    return kb;
  }

  async list(projectId?: string): Promise<KnowledgeBase[]> {
    let kbs: KnowledgeBase[];
    if (projectId) {
      kbs = await this.db.query<KnowledgeBase>(
        `SELECT DISTINCT kb.* FROM knowledge_base kb
         LEFT JOIN project_knowledge_base pkb ON kb.id = pkb.kb_id
         WHERE kb.is_global = 1 OR pkb.project_id = ?
         ORDER BY kb.created_at DESC`,
        [projectId]
      );
    } else {
      kbs = await this.db.query<KnowledgeBase>('SELECT * FROM knowledge_base ORDER BY created_at DESC');
    }

    for (const kb of kbs) {
      kb.linked_project_ids = await this.getLinkedProjectIds(kb.id);
    }

    return kbs;
  }

  async listPage(projectId?: string, options: PageOptions = {}): Promise<Page<KnowledgeBase>> {
    const limit = normalizePageLimit(options.limit);
    const scope = `knowledge-bases:${projectId || 'global'}`;
    const cursor = decodeCursor(options.cursor, scope, 2);
    const params: unknown[] = [];
    let sql = projectId
      ? `SELECT DISTINCT kb.* FROM knowledge_base kb
         LEFT JOIN project_knowledge_base pkb ON kb.id = pkb.kb_id
         WHERE (kb.is_global = 1 OR pkb.project_id = ?)`
      : 'SELECT kb.* FROM knowledge_base kb WHERE 1 = 1';
    if (projectId) params.push(projectId);
    if (cursor) {
      sql += ' AND (kb.created_at < ? OR (kb.created_at = ? AND kb.id < ?))';
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    sql += ' ORDER BY kb.created_at DESC, kb.id DESC LIMIT ?';
    params.push(limit + 1);
    const rows = await this.db.query<KnowledgeBase>(sql, params);
    for (const kb of rows.slice(0, limit)) kb.linked_project_ids = await this.getLinkedProjectIds(kb.id);
    return toPage(rows, limit, row => encodeCursor(scope, [row.created_at, row.id]));
  }

  async linkProject(kbId: string, projectId: string, actorId?: string, adapter?: DatabaseAdapter): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.linkProject(kbId, projectId, actorId, tx));
    const db = adapter;
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

  async unlinkProject(kbId: string, projectId: string): Promise<void> {
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

  async delete(id: string): Promise<void> {
    await this.db.execute('DELETE FROM knowledge_base WHERE id = ?', [id]);
  }

  // --- Entities ---

  async upsertEntity(data: UpsertKBEntity, actorId?: string, adapter?: DatabaseAdapter): Promise<KBEntity> {
    if (!adapter) return this.db.transaction(tx => this.upsertEntity(data, actorId, tx));
    const db = adapter;
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

  async getEntityById(id: string, adapter: DatabaseAdapter = this.db): Promise<KBEntity | null> {
    const rows = await adapter.query<KBEntity>('SELECT * FROM kb_entity WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async listEntities(kbId: string, type?: string): Promise<KBEntity[]> {
    if (type) {
      return this.db.query<KBEntity>(
        'SELECT * FROM kb_entity WHERE kb_id = ? AND type = ? ORDER BY name ASC',
        [kbId, type]
      );
    }
    return this.db.query<KBEntity>('SELECT * FROM kb_entity WHERE kb_id = ? ORDER BY name ASC', [kbId]);
  }

  async listEntitiesPage(kbId: string, type?: string, options: PageOptions = {}): Promise<Page<KBEntity>> {
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

  async deleteEntity(id: string): Promise<void> {
    await this.db.execute('DELETE FROM kb_entity WHERE id = ?', [id]);
  }

  async updateEntity(id: string, data: Partial<UpsertKBEntity>, actorId?: string, adapter?: DatabaseAdapter): Promise<KBEntity> {
    if (!adapter) return this.db.transaction(tx => this.updateEntity(id, data, actorId, tx));
    const db = adapter;
    const existing = await this.getEntityById(id, db);
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

  async addFact(data: AddGainedKnowledge, actorId?: string, adapter?: DatabaseAdapter): Promise<KBFact> {
    if (!adapter) return this.db.transaction(tx => this.addFact(data, actorId, tx));
    const db = adapter;
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
      }, actorId, db);
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
        }, actorId, db);
        entityId = entity.id;
      } else if (emailMatch) {
        const entity = await this.upsertEntity({
          kb_id: data.kb_id,
          name: emailMatch[0],
          identifier: emailMatch[0],
          type: 'email',
        }, actorId, db);
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
      const entity = await this.getEntityById(entityId, db);
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

  async listFacts(kbId?: string, entityId?: string, category?: string): Promise<KBFact[]> {
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

  async listFactsPage(
    kbId: string,
    filters: { entityId?: string; category?: string } = {},
    options: PageOptions = {},
  ): Promise<Page<KBFactSummary>> {
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

  async getFactById(id: string): Promise<KBFact | null> {
    const rows = await this.db.query<KBFact>(
      `SELECT f.*, e.name as entity_name, e.identifier as entity_identifier
       FROM kb_fact f LEFT JOIN kb_entity e ON f.entity_id = e.id WHERE f.id = ?`, [id],
    );
    return rows[0] || null;
  }

  async deleteFact(id: string, actorId?: string, adapter?: DatabaseAdapter): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.deleteFact(id, actorId, tx));
    const db = adapter;
    const existingRows = await db.query<KBFact>('SELECT * FROM kb_fact WHERE id = ?', [id]);
    if (!existingRows[0]) return;
    await db.execute('DELETE FROM kb_fact WHERE id = ?', [id]);
    await this.logEventForKb(existingRows[0].kb_id, 'fact_deleted', id, actorId, { title: existingRows[0].title, kb_id: existingRows[0].kb_id }, db);
  }

  async updateFact(id: string, data: Partial<AddGainedKnowledge>, actorId?: string, adapter?: DatabaseAdapter): Promise<KBFact> {
    if (!adapter) return this.db.transaction(tx => this.updateFact(id, data, actorId, tx));
    const db = adapter;
    const existingRows = await db.query<KBFact>('SELECT * FROM kb_fact WHERE id = ?', [id]);
    if (!existingRows[0]) throw new Error(`KBFact with ID ${id} not found`);
    const existing = existingRows[0];

    const now = new Date().toISOString();
    const title = data.title !== undefined ? data.title : existing.title;
    const content = data.content !== undefined ? data.content : existing.content;
    const category = data.category !== undefined ? data.category : existing.category;
    const confidence = data.confidence !== undefined ? data.confidence : existing.confidence;

    let entityId = data.entity_id !== undefined ? data.entity_id : existing.entity_id;

    if (data.entity_name || data.entity_identifier) {
      const entity = await this.upsertEntity({
        kb_id: existing.kb_id,
        name: data.entity_name || data.entity_identifier || 'Unknown Entity',
        identifier: data.entity_identifier,
        type: data.entity_type,
      }, actorId, db);
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
      const entity = await this.getEntityById(entityId, db);
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

  async addRelation(data: AddKBRelation, actorId?: string, adapter?: DatabaseAdapter): Promise<KBRelation> {
    if (!adapter) return this.db.transaction(tx => this.addRelation(data, actorId, tx));
    const db = adapter;
    const id = ulid();
    const created_at = new Date().toISOString();

    await db.execute(
      `INSERT INTO kb_relation (id, kb_id, source_entity_id, target_entity_id, relation_type, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, data.kb_id, data.source_entity_id, data.target_entity_id, data.relation_type, data.description || null, created_at]
    );

    const source = await this.getEntityById(data.source_entity_id, db);
    const target = await this.getEntityById(data.target_entity_id, db);

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


  async deleteRelation(id: string): Promise<void> {
    await this.db.execute('DELETE FROM kb_relation WHERE id = ?', [id]);
  }

  // --- Aggregated Knowledge & Graph Queries ---

  async getEntityKnowledge(queryStr: string, kbIds?: string[], options: PageOptions = {}): Promise<EntityKnowledgeResult | null> {
    let sql = 'SELECT id, kb_id, name, type, identifier, created_at, updated_at FROM kb_entity WHERE (id = ? OR identifier = ? OR LOWER(name) = LOWER(?))';
    const params: unknown[] = [queryStr, queryStr, queryStr];

    if (kbIds && kbIds.length > 0) {
      sql += ` AND kb_id IN (${kbIds.map(() => '?').join(',')})`;
      params.push(...kbIds);
    }

    const entities = await this.db.query<KBEntity>(sql, params);
    if (!entities[0]) return null;

    const entity = entities[0];
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
        e.identifier as entity_identifier FROM kb_fact f LEFT JOIN kb_entity e ON f.entity_id=e.id
        WHERE f.entity_id = ?`;
      if (afterCreated) { factSql += ' AND (f.created_at > ? OR (f.created_at = ? AND f.id > ?))'; params.push(afterCreated, afterCreated, afterId); }
      factSql += ' ORDER BY f.created_at ASC, f.id ASC LIMIT ?'; params.push(limit + 1);
      rows = await this.db.query<KBFactSummary>(factSql, params); facts = rows.slice(0, limit) as KBFactSummary[];
    } else {
      const outgoingPhase = phase === 'outgoing';
      const params: unknown[] = [entity.id];
      let relSql = `SELECT r.id,r.kb_id,r.source_entity_id,r.target_entity_id,r.relation_type,r.created_at,
        e.name as ${outgoingPhase ? 'target' : 'source'}_entity_name FROM kb_relation r
        JOIN kb_entity e ON e.id=r.${outgoingPhase ? 'target' : 'source'}_entity_id
        WHERE r.${outgoingPhase ? 'source' : 'target'}_entity_id = ?`;
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
         FROM kb_relation r JOIN kb_entity e ON e.id=r.target_entity_id
         WHERE r.source_entity_id=? ORDER BY r.created_at ASC,r.id ASC LIMIT ?`, [entity.id, remaining + 1]);
      outgoing = outgoingRows.slice(0, remaining);
      if (outgoingRows.length > remaining) {
        moreInPhase = true; nextPhase = 'outgoing'; last = outgoing.at(-1);
      } else {
        remaining -= outgoing.length;
        const incomingRows = await this.db.query<Omit<KBRelation, 'description'>>(
          `SELECT r.id,r.kb_id,r.source_entity_id,r.target_entity_id,r.relation_type,r.created_at,e.name source_entity_name
           FROM kb_relation r JOIN kb_entity e ON e.id=r.source_entity_id
           WHERE r.target_entity_id=? ORDER BY r.created_at ASC,r.id ASC LIMIT ?`, [entity.id, remaining + 1]);
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

  async searchKnowledge(query: string, kbIds?: string[], limit: number = 20): Promise<{ facts: KBFact[]; entities: KBEntity[] }> {
    limit = normalizePageLimit(limit);
    const pattern = `%${query}%`;
    let factSql = `SELECT f.*, e.name as entity_name, e.identifier as entity_identifier
                   FROM kb_fact f
                   LEFT JOIN kb_entity e ON f.entity_id = e.id
                   WHERE (f.title LIKE ? OR f.content LIKE ? OR f.category LIKE ?)`;
    const factParams: unknown[] = [pattern, pattern, pattern];

    if (kbIds && kbIds.length > 0) {
      factSql += ` AND f.kb_id IN (${kbIds.map(() => '?').join(',')})`;
      factParams.push(...kbIds);
    }

    factSql += ' ORDER BY f.created_at DESC LIMIT ?';
    factParams.push(limit);

    const facts = await this.db.query<KBFact>(factSql, factParams);

    let entitySql = `SELECT * FROM kb_entity WHERE (name LIKE ? OR identifier LIKE ? OR type LIKE ?)`;
    const entityParams: unknown[] = [pattern, pattern, pattern];

    if (kbIds && kbIds.length > 0) {
      entitySql += ` AND kb_id IN (${kbIds.map(() => '?').join(',')})`;
      entityParams.push(...kbIds);
    }

    entitySql += ' ORDER BY updated_at DESC LIMIT ?';
    entityParams.push(limit);

    const entities = await this.db.query<KBEntity>(entitySql, entityParams);

    return { facts, entities };
  }

  async searchKnowledgePage(
    query: string,
    kbIds?: string[],
    options: PageOptions = {},
    projectId?: string,
  ): Promise<{ facts: KBFactSummary[]; entities: KBEntity[]; page: PageInfo }> {
    const limit = normalizePageLimit(options.limit ?? 20);
    const normalizedKbIds = kbIds ? [...kbIds].sort() : undefined;
    const scope = `knowledge-search:${JSON.stringify({ query, kbIds: normalizedKbIds || null, projectId: projectId || null })}`;
    const cursor = decodeCursor(options.cursor, scope, 3);
    const phase = cursor?.[0] || 'facts';
    const pattern = `%${query}%`;
    let facts: KBFactSummary[] = [];
    let entities: KBEntity[] = [];

    if (phase === 'facts') {
      let sql = `SELECT f.id, f.kb_id, f.entity_id, f.title, f.category, f.confidence,
        f.source_principal_id, f.created_at, f.updated_at, e.name as entity_name,
        e.identifier as entity_identifier FROM kb_fact f
        LEFT JOIN kb_entity e ON f.entity_id = e.id
        WHERE (f.title LIKE ? OR f.content LIKE ? OR f.category LIKE ?)`;
      const params: unknown[] = [pattern, pattern, pattern];
      if (normalizedKbIds?.length) {
        sql += ` AND f.kb_id IN (${normalizedKbIds.map(() => '?').join(',')})`;
        params.push(...normalizedKbIds);
      }
      if (projectId) { sql += ' AND EXISTS (SELECT 1 FROM project_knowledge_base pkb WHERE pkb.kb_id=f.kb_id AND pkb.project_id=?)'; params.push(projectId); }
      if (cursor && cursor[1]) {
        sql += ' AND (f.created_at < ? OR (f.created_at = ? AND f.id < ?))';
        params.push(cursor[1], cursor[1], cursor[2]);
      }
      sql += ' ORDER BY f.created_at DESC, f.id DESC LIMIT ?';
      params.push(limit + 1);
      facts = await this.db.query<KBFactSummary>(sql, params);
    }

    if (phase === 'entities') {
      let sql = 'SELECT id,kb_id,name,type,identifier,created_at,updated_at FROM kb_entity WHERE (name LIKE ? OR identifier LIKE ? OR type LIKE ?)';
      const params: unknown[] = [pattern, pattern, pattern];
      if (normalizedKbIds?.length) {
        sql += ` AND kb_id IN (${normalizedKbIds.map(() => '?').join(',')})`;
        params.push(...normalizedKbIds);
      }
      if (projectId) { sql += ' AND EXISTS (SELECT 1 FROM project_knowledge_base pkb WHERE pkb.kb_id=kb_entity.kb_id AND pkb.project_id=?)'; params.push(projectId); }
      if (cursor && cursor[1]) {
        sql += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
        params.push(cursor[1], cursor[1], cursor[2]);
      }
      sql += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
      params.push(limit + 1);
      entities = await this.db.query<KBEntity>(sql, params);
    }

    let factMore = facts.length > limit;
    let entityMore = entities.length > limit;
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
    return {
      facts: factItems,
      entities: entityItems,
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore ? encodeCursor(scope, phase === 'facts' && factMore
          ? ['facts', lastFact?.created_at || '', lastFact?.id || '']
          : ['entities', phase === 'entities' ? (lastEntity?.updated_at || '') : '', phase === 'entities' ? (lastEntity?.id || '') : '']) : null,
      },
    };
  }

  async getGraphTree(kbId?: string, projectId?: string, options: PageOptions = {}): Promise<KBGraphTree> {
    const limit = normalizePageLimit(options.limit);
    const scope = `kb-graph:${kbId || ''}:${projectId || ''}`;
    const cursor = decodeCursor(options.cursor, scope, 3);
    const phase = cursor?.[0] || 'nodes';
    const params: unknown[] = [];
    const filter = (alias: string) => {
      if (kbId) { params.push(kbId); return `${alias}.kb_id = ?`; }
      if (projectId) { params.push(projectId); return `EXISTS (SELECT 1 FROM project_knowledge_base pkb WHERE pkb.kb_id=${alias}.kb_id AND pkb.project_id=?)`; }
      return '1=1';
    };
    let entities: Array<KBEntity & { fact_count: number }> = [];
    let links: KBRelation[] = [];
    if (phase === 'nodes') {
      let sql = `SELECT e.id,e.kb_id,e.name,e.type,e.identifier,e.created_at,e.updated_at,COUNT(f.id) fact_count FROM kb_entity e LEFT JOIN kb_fact f ON e.id=f.entity_id WHERE ${filter('e')}`;
      if (cursor?.[1]) { sql += ' AND (e.name > ? OR (e.name=? AND e.id>?))'; params.push(cursor[1], cursor[1], cursor[2]); }
      sql += ' GROUP BY e.id ORDER BY e.name ASC,e.id ASC LIMIT ?'; params.push(limit + 1);
      entities = await this.db.query(sql, params);
    } else {
      let sql = `SELECT r.id,r.kb_id,r.source_entity_id,r.target_entity_id,r.relation_type,r.created_at FROM kb_relation r WHERE ${filter('r')}`;
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
      let linkFilter = '1=1';
      if (kbId) { linkFilter = 'r.kb_id=?'; linkParams.push(kbId); }
      else if (projectId) { linkFilter = 'EXISTS (SELECT 1 FROM project_knowledge_base pkb WHERE pkb.kb_id=r.kb_id AND pkb.project_id=?)'; linkParams.push(projectId); }
      linkParams.push(remaining + 1);
      links = await this.db.query(`SELECT r.id,r.kb_id,r.source_entity_id,r.target_entity_id,r.relation_type,r.created_at
        FROM kb_relation r WHERE ${linkFilter} ORDER BY r.created_at ASC,r.id ASC LIMIT ?`, linkParams);
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
