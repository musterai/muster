import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { Migrator } from '../src/db/migrator.js';
import { createApplicationServices } from '../src/application/composition.js';
import { createKBRouter } from '../src/api/routes/kb.routes.js';
import { errorHandler } from '../src/api/middleware/error-handler.js';
import { KBReadScopeResolver, KBService } from '../src/services/index.js';
import type { AuthContext } from '../src/shared/auth-context.js';

describe('bounded KB read contracts', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let server: Server | undefined;
  let baseUrl = '';

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `muster-kb-read-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    db = createDatabaseAdapter(dbPath);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)',
      ['kb-read-ws', 'KB Read', 'kb-read', now, now],
    );
  });

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(`${dbPath}${suffix}`)) fs.unlinkSync(`${dbPath}${suffix}`);
    }
  });

  async function fixture() {
    const services = createApplicationServices(db);
    const selectedProject = await services.projectService.create({ name: 'Selected' });
    const ownerProject = await services.projectService.create({ name: 'Global owner' });
    const linked = await services.kbService.create({ name: 'Linked', project_ids: [selectedProject.id] });
    const global = await services.kbService.create({
      name: 'Workspace global', is_global: true, project_ids: [ownerProject.id],
    });
    const privateKb = await services.kbService.create({ name: 'Private', project_ids: [ownerProject.id] });
    const sharedA = await services.kbService.upsertEntity({
      kb_id: linked.id, name: 'shared-host', type: 'server', identifier: 'duplicate.local',
    });
    const neighborA = await services.kbService.upsertEntity({
      kb_id: linked.id, name: 'database-a', type: 'database', identifier: 'db-a.local',
    });
    const neighborB = await services.kbService.upsertEntity({
      kb_id: linked.id, name: 'database-b', type: 'database', identifier: 'db-b.local',
    });
    await services.kbService.upsertEntity({
      kb_id: global.id, name: 'shared-host', type: 'server', identifier: 'duplicate.local',
    });
    await services.kbService.addFact({
      kb_id: linked.id, entity_id: sharedA.id, title: 'Attached architecture',
      content: 'A'.repeat(400), category: 'architecture', confidence: 0.9,
    });
    await services.kbService.addFact({
      kb_id: linked.id, title: 'Unattached note', content: 'unattached', category: 'general',
    });
    await services.kbService.addFact({
      kb_id: global.id, title: 'Global note', content: 'global', category: 'general',
    });
    await services.kbService.addFact({
      kb_id: privateKb.id, title: 'Private note', content: 'must not appear', category: 'private',
    });
    await services.kbService.addRelation({
      kb_id: linked.id, source_entity_id: sharedA.id, target_entity_id: neighborA.id,
      relation_type: 'depends_on',
    });
    await services.kbService.addRelation({
      kb_id: linked.id, source_entity_id: sharedA.id, target_entity_id: neighborB.id,
      relation_type: 'depends_on',
    });
    return { services, selectedProject, linked, global, privateKb, sharedA };
  }

  it('resolves linked-or-global scope and returns body-free overview/browse/entity summaries', async () => {
    const { services, selectedProject, linked, global, privateKb } = await fixture();
    const overview = await services.kbService.getKnowledgeOverview({ project_id: selectedProject.id });
    expect(overview.scope.knowledge_base_count).toBe(2);
    expect(overview.totals).toMatchObject({ facts: 3, attached_facts: 1, unattached_facts: 2, entities: 4, relations: 2 });
    expect(overview.facets.knowledge_bases.items.map(item => item.value)).toEqual(
      expect.arrayContaining([linked.id, global.id]),
    );
    expect(overview.facets.knowledge_bases.items.map(item => item.value)).not.toContain(privateKb.id);

    const first = await services.kbService.listKnowledgePage(
      { project_id: selectedProject.id }, {}, { limit: 2 },
    );
    expect(first.items).toHaveLength(2);
    expect(first.page.has_more).toBe(true);
    expect(first.items.every(item => !('content' in item))).toBe(true);
    expect(first.items.every(item => item.excerpt.length <= 280)).toBe(true);
    const second = await services.kbService.listKnowledgePage(
      { project_id: selectedProject.id }, {}, { limit: 2, cursor: first.page.next_cursor! },
    );
    const all = [...first.items, ...second.items];
    expect(new Set(all.map(item => item.id)).size).toBe(3);
    expect(all.map(item => item.knowledge_base.id)).not.toContain(privateKb.id);
    expect((await services.kbService.listKnowledgePage(
      { project_id: selectedProject.id }, { attached: false }, { limit: 10 },
    )).items).toHaveLength(2);
    expect((await services.kbService.listKnowledgePage(
      { project_id: selectedProject.id }, { q: 'architecture' }, { limit: 10 },
    )).items.map(item => item.title)).toEqual(['Attached architecture']);
    expect((await services.kbService.listKnowledgePage(
      { project_id: selectedProject.id }, { q: '   ' }, { limit: 10 },
    )).items).toHaveLength(3);

    const entities = await services.kbService.listScopedEntitiesPage(
      { project_id: selectedProject.id }, { type: 'server' }, { limit: 10 },
    );
    expect(entities.items).toHaveLength(2);
    expect(entities.items.every(item => !('metadata' in item))).toBe(true);
    await expect(services.kbService.listKnowledgePage({}, {}, {})).rejects.toThrow(/Exactly one/);
    await expect(services.kbService.listKnowledgePage(
      { kb_id: linked.id, project_id: selectedProject.id }, {}, {},
    )).rejects.toThrow(/Exactly one/);
  });

  it('normalizes PostgreSQL-style aggregate strings at the shared service boundary', async () => {
    const { selectedProject } = await fixture();
    const countFields = /(?:^count$|_count$|^facts$|^attached_facts$|^unattached_facts$|^entities$|^relations$)/;
    const postgresLike: DatabaseAdapter = {
      dialect: 'postgres',
      query: async <T>(sql: string, params?: unknown[]) => {
        const rows = await db.query<Record<string, unknown>>(sql, params);
        return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [
          key,
          countFields.test(key) && typeof value === 'number' ? String(value) : value,
        ]))) as T[];
      },
      execute: (sql, params) => db.execute(sql, params),
      transaction: fn => db.transaction(fn),
      migrate: sql => db.migrate(sql),
      close: () => Promise.resolve(),
    };
    const service = new KBService(postgresLike, undefined, new KBReadScopeResolver(postgresLike));

    const overview = await service.getKnowledgeOverview({ project_id: selectedProject.id });
    const entities = await service.listScopedEntitiesPage(
      { project_id: selectedProject.id }, {}, { limit: 10 },
    );
    expect(overview.totals).toEqual({
      facts: 3,
      attached_facts: 1,
      unattached_facts: 2,
      entities: 4,
      relations: 2,
    });
    expect(entities.items.every(entity =>
      typeof entity.fact_count === 'number'
      && typeof entity.incoming_relation_count === 'number'
      && typeof entity.outgoing_relation_count === 'number')).toBe(true);
  });

  it('keeps workspace-global inclusion inside the authenticated workspace', async () => {
    const { services, selectedProject } = await fixture();
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)',
      ['foreign-ws', 'Foreign', 'foreign-ws', now, now],
    );
    await db.execute(
      `INSERT INTO project (id,workspace_id,name,description,key_prefix,card_seq,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['foreign-project', 'foreign-ws', 'Foreign project', null, 'FOR', 0, now, now],
    );
    await db.execute(
      'INSERT INTO knowledge_base (id,name,description,is_global,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      ['foreign-global', 'Foreign global', null, 1, now, now],
    );
    await db.execute(
      'INSERT INTO project_knowledge_base (project_id,kb_id,created_at) VALUES (?,?,?)',
      ['foreign-project', 'foreign-global', now],
    );
    await db.execute(
      `INSERT INTO kb_fact (id,kb_id,entity_id,title,content,category,confidence,source_principal_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ['foreign-fact', 'foreign-global', null, 'Foreign fact', 'secret', 'private', 1, null, now, now],
    );
    const auth: AuthContext = {
      principal: { id: 'kb-reader', kind: 'user' },
      workspace_id: 'kb-read-ws',
      is_workspace_member: true,
      permissions: ['kb.read'],
      is_operator_override: false,
      role_name: 'observer',
    };

    const overview = await services.kbService.getKnowledgeOverview(
      { project_id: selectedProject.id }, {}, auth,
    );
    expect(overview.totals.facts).toBe(3);
    expect(overview.facets.knowledge_bases.items.map(item => item.value)).not.toContain('foreign-global');
    await expect(services.kbService.getKnowledgeOverview(
      { project_id: 'foreign-project' }, {}, auth,
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns deterministic ambiguity and independently caps nodes, edges, and facts', async () => {
    const { services, selectedProject, sharedA } = await fixture();
    await expect(services.kbService.getEntityContext(
      { project_id: selectedProject.id }, { query: 'duplicate.local' },
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'KB_ENTITY_AMBIGUOUS',
      details: { candidates_truncated: false },
    });
    const context = await services.kbService.getEntityContext(
      { project_id: selectedProject.id },
      { entity_id: sharedA.id },
      { depth: 1, max_nodes: 2, max_edges: 10, fact_limit: 1 },
    );
    expect(context.root.id).toBe(sharedA.id);
    expect(context.nodes).toHaveLength(2);
    expect(context.edges).toHaveLength(1);
    expect(context.truncation).toMatchObject({ truncated: true, node_limit: 2, nodes_returned: 2 });
    expect(context.facts.items).toHaveLength(1);
    expect(context.facts.items[0]).not.toHaveProperty('content');
    expect(context.truncation.expandable_entity_ids).toContain(sharedA.id);
  });

  it('exposes strict REST overview, browse, entity, and context routes without changing detail routes', async () => {
    const { services, selectedProject, sharedA } = await fixture();
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createKBRouter(services.kbService));
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    const overview = await fetch(`${baseUrl}/kbs/overview?project_id=${selectedProject.id}`);
    expect(overview.status).toBe(200);
    expect((await overview.json()).totals.facts).toBe(3);
    const browse = await fetch(`${baseUrl}/kbs/facts?project_id=${selectedProject.id}&limit=2`);
    expect(browse.status).toBe(200);
    expect((await browse.json()).items).toHaveLength(2);
    const attached = await fetch(`${baseUrl}/kbs/facts?project_id=${selectedProject.id}&entity_id=${sharedA.id}`);
    expect(attached.status).toBe(200);
    expect((await attached.json()).items).toHaveLength(1);
    const searched = await fetch(`${baseUrl}/kbs/facts?project_id=${selectedProject.id}&q=architecture`);
    expect(searched.status).toBe(200);
    expect((await searched.json()).items.map((item: { title: string }) => item.title))
      .toEqual(['Attached architecture']);
    const emptySearch = await fetch(`${baseUrl}/kbs/facts?project_id=${selectedProject.id}&q=`);
    expect(emptySearch.status).toBe(200);
    expect((await emptySearch.json()).items).toHaveLength(3);
    const entities = await fetch(`${baseUrl}/kbs/entities?project_id=${selectedProject.id}&type=server`);
    expect(entities.status).toBe(200);
    expect((await entities.json()).items).toHaveLength(2);
    const context = await fetch(`${baseUrl}/kbs/entity-context?project_id=${selectedProject.id}&entity_id=${sharedA.id}&max_nodes=2`);
    expect(context.status).toBe(200);
    expect((await context.json()).root.id).toBe(sharedA.id);
    expect((await fetch(`${baseUrl}/kbs/overview`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/kbs/facts?project_id=${selectedProject.id}&limit=1.5`)).status).toBe(400);
  });
});
