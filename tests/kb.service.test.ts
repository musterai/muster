// File: tests/kb.service.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { KBReadScopeResolver, KBService, ProjectService, EventService } from '../src/services/index.js';

const TEST_DB = path.join(process.cwd(), 'data', 'kb-test.db');

describe('KBService Knowledge Base & Graph Integration Tests', () => {
  let db: DatabaseAdapter;
  let kbService: KBService;
  let projectService: ProjectService;
  let eventService: EventService;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) {
      fs.unlinkSync(TEST_DB);
    }
    db = createDatabaseAdapter(TEST_DB);

    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    // Bootstrap a default workspace for tests
    const wsId = 'test-ws-01';
    const now = new Date().toISOString();
    await db.execute(
      `INSERT OR IGNORE INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [wsId, 'Test Workspace', 'test', now, now]
    );

    eventService = new EventService(db);
    kbService = new KBService(db, eventService, new KBReadScopeResolver(db));
    projectService = new ProjectService(db, eventService);
  });

  afterEach(async () => {
    if (db) await db.close();
    if (fs.existsSync(TEST_DB)) {
      fs.unlinkSync(TEST_DB);
    }
  });

  it('creates Home KB and Work KB and links to projects', async () => {
    const projectHome = await projectService.create({ name: 'Home Automation' });
    const projectWork = await projectService.create({ name: 'Work Muster' });

    const homeKb = await kbService.create({
      name: 'Home KB',
      description: 'Local network & homelab hardware',
      project_ids: [projectHome.id],
    });

    const workKb = await kbService.create({
      name: 'Work KB',
      description: 'Work codebase knowledge',
      project_ids: [projectWork.id],
    });

    expect(homeKb.name).toBe('Home KB');
    expect(workKb.name).toBe('Work KB');
    expect(homeKb.linked_project_ids).toContain(projectHome.id);
    expect(workKb.linked_project_ids).toContain(projectWork.id);
  });

  it('supports entity CRUD and knowledge graph relations', async () => {
    const project = await projectService.create({ name: 'KB Project' });
    const kb = await kbService.create({
      name: 'Dev KB',
      project_ids: [project.id],
    });

    // Entity CRUD
    const server = await kbService.upsertEntity({
      kb_id: kb.id,
      name: 'web-server-01',
      type: 'server',
      identifier: '192.168.1.100',
    });
    expect(server.name).toBe('web-server-01');
    expect(server.type).toBe('server');
    expect(server.identifier).toBe('192.168.1.100');

    const dbServer = await kbService.upsertEntity({
      kb_id: kb.id,
      name: 'db-server-01',
      type: 'server',
      identifier: '192.168.1.101',
    });

    // Add facts
    const fact = await kbService.addFact({
      kb_id: kb.id,
      title: 'Web server config',
      content: 'Runs on Ubuntu 24.04 with Nginx',
      entity_id: server.id,
    });
    expect(fact.title).toBe('Web server config');
    expect(fact.entity_id).toBe(server.id);

    // Graph relations
    const relation = await kbService.addRelation({
      kb_id: kb.id,
      source_entity_id: server.id,
      target_entity_id: dbServer.id,
      relation_type: 'connects_to',
      description: 'Web server connects to database',
    });
    expect(relation.relation_type).toBe('connects_to');

    // Get entity knowledge
    const entityResult = await kbService.getEntityKnowledge(server.id);
    expect(entityResult).toBeDefined();
    expect(entityResult!.entity.id).toBe(server.id);
    expect(entityResult!.facts).toHaveLength(1);
    expect(entityResult!.outgoing_relations).toHaveLength(1);
    expect(entityResult!.incoming_relations).toHaveLength(0);

    // Update fact
    const updatedFact = await kbService.updateFact(fact.id, {
      title: 'Web server config (updated)',
      content: 'Now runs on Ubuntu 24.04 with Caddy',
    });
    expect(updatedFact.title).toBe('Web server config (updated)');

    // Search knowledge
    const searchResults = await kbService.searchKnowledge('Ubuntu', [kb.id]);
    expect(searchResults.facts.length).toBeGreaterThanOrEqual(1);
    expect(searchResults.facts[0].title).toContain('Web server');

    // Graph tree
    const tree = await kbService.getGraphTree(kb.id);
    expect(tree.nodes.length).toBe(2);
    expect(tree.links.length).toBe(1);
  });
});
