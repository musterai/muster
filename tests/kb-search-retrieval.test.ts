import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplicationServices } from '../src/application/composition.js';
import { createKBRouter } from '../src/api/routes/kb.routes.js';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { Migrator } from '../src/db/migrator.js';
import { createMcpServer } from '../src/mcp/server.js';
import { OPEN_AUTH_CONTEXT } from '../src/shared/auth-context.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';

describe('KB answer-first search retrieval', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let services: ReturnType<typeof createApplicationServices>;
  let projectId: string;
  let kbId: string;
  let titleFactId: string;
  let entityFactId: string;
  let bodyFactId: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `muster-kb-search-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    db = createDatabaseAdapter(dbPath);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)',
      ['kb-search-ws', 'KB Search', 'kb-search', now, now],
    );
    services = createApplicationServices(db);
    const project = await services.projectService.create({ name: 'Search project' });
    projectId = project.id;
    const kb = await services.kbService.create({ name: 'Search KB', project_ids: [projectId] });
    kbId = kb.id;
    const registry = await services.kbService.upsertEntity({
      kb_id: kbId, name: 'application-image-deployment-service', type: 'service', identifier: 'image-service',
    });
    const titleFact = await services.kbService.addFact({
      kb_id: kbId, title: 'Application image deployment',
      content: 'The release process deploys application images from the registry.', category: 'deployment',
    });
    titleFactId = titleFact.id;
    const entityFact = await services.kbService.addFact({
      kb_id: kbId, entity_id: registry.id, title: 'Registry configuration',
      content: 'Images are deployed by this service after a release is approved.', category: 'deployment',
    });
    entityFactId = entityFact.id;
    const bodyFact = await services.kbService.addFact({
      kb_id: kbId, title: 'Operations note',
      content: 'Application images are deployed by the release process.', category: 'operations',
    });
    bodyFactId = bodyFact.id;
  });

  afterEach(async () => {
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(`${dbPath}${suffix}`)) fs.unlinkSync(`${dbPath}${suffix}`);
    }
  });

  function searchRouteHandler() {
    const router = createKBRouter(services.kbService) as any;
    return router.stack.find((layer: any) => layer.route?.path === '/kbs/search' && layer.route.methods.get)
      .route.stack.at(-1).handle;
  }

  it('normalizes question wording and ranks title/entity identity before body-only matches', async () => {
    const question = await services.kbService.listKnowledgePage(
      { kb_id: kbId }, { q: 'How are application images deployed?' }, { limit: 10 },
    );
    const keywords = await services.kbService.listKnowledgePage(
      { kb_id: kbId }, { q: 'application images' }, { limit: 10 },
    );
    expect(question.items.map(item => item.id)).toEqual(keywords.items.map(item => item.id));
    expect(question.items.map(item => item.id)).toEqual([titleFactId, entityFactId, bodyFactId]);
    expect(question.items.every(item => !('content' in item) && item.excerpt.length <= 280)).toBe(true);

    const punctuation = await services.kbService.listKnowledgePage(
      { kb_id: kbId }, { q: 'HOW, application-images deployed!!!' }, { limit: 10 },
    );
    expect(punctuation.items.map(item => item.id)).toEqual(question.items.map(item => item.id));
  });

  it('keeps project knowledge ahead of newer shared knowledge across browse and search cursors', async () => {
    const sharedKb = await services.kbService.create({
      name: 'Shared KB', is_global: true, project_ids: [projectId],
    });
    const sharedFact = await services.kbService.addFact({
      kb_id: sharedKb.id,
      title: 'Application image deployment shared note',
      content: 'Application images are deployed by a shared fallback process.',
      category: 'deployment',
    });

    const browseIds: string[] = [];
    let browseCursor: string | null = null;
    do {
      const page = await services.kbService.listKnowledgePage(
        { project_id: projectId }, {}, { limit: 1, ...(browseCursor ? { cursor: browseCursor } : {}) },
      );
      browseIds.push(...page.items.map(item => item.id));
      browseCursor = page.page.next_cursor;
    } while (browseCursor);
    expect(browseIds.at(-1)).toBe(sharedFact.id);

    const searchIds: string[] = [];
    let searchCursor: string | null = null;
    do {
      const page = await services.kbService.listKnowledgePage(
        { project_id: projectId },
        { q: 'How are application images deployed?' },
        { limit: 1, ...(searchCursor ? { cursor: searchCursor } : {}) },
      );
      searchIds.push(...page.items.map(item => item.id));
      searchCursor = page.page.next_cursor;
    } while (searchCursor);
    expect(searchIds.at(-1)).toBe(sharedFact.id);
    expect(searchIds.slice(0, -1)).toEqual(expect.arrayContaining([titleFactId, entityFactId, bodyFactId]));
  });

  it('rejects empty and stop-word-only searches instead of browsing', async () => {
    await expect(services.kbService.listKnowledgePage(
      { kb_id: kbId }, { q: 'how are the' }, { limit: 10 },
    )).rejects.toThrow(/meaningful term/);
    await expect(services.kbService.searchKnowledgePage(
      'the and of', [kbId], { limit: 10 },
    )).rejects.toThrow(/meaningful term/);
  });

  it('keeps ranked keyset cursors bound to the normalized query and avoids page duplicates', async () => {
    const first = await services.kbService.listKnowledgePage(
      { kb_id: kbId }, { q: 'application images' }, { limit: 1 },
    );
    expect(first.page.next_cursor).toBeTruthy();
    const second = await services.kbService.listKnowledgePage(
      { kb_id: kbId }, { q: 'application images' }, { limit: 1, cursor: first.page.next_cursor! },
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    await expect(services.kbService.listKnowledgePage(
      { kb_id: kbId }, { q: 'application images deploy now' }, { limit: 1, cursor: first.page.next_cursor! },
    )).rejects.toThrow(/cursor is invalid/);

    const legacyFirst = await services.kbService.searchKnowledgePage(
      'How are application images deployed?', [kbId], { limit: 1 },
    );
    const legacySecond = await services.kbService.searchKnowledgePage(
      'How are application images deployed?', [kbId], { limit: 1, cursor: legacyFirst.page.next_cursor! },
    );
    expect(legacyFirst.facts).toHaveLength(1);
    expect(legacySecond.facts[0].id).not.toBe(legacyFirst.facts[0].id);
    let cursor = legacySecond.page.next_cursor;
    const seenFacts = [...legacyFirst.facts, ...legacySecond.facts].map(fact => fact.id);
    const seenEntities: string[] = [];
    while (cursor) {
      const page = await services.kbService.searchKnowledgePage(
        'How are application images deployed?', [kbId], { limit: 1, cursor },
      );
      seenFacts.push(...page.facts.map(fact => fact.id));
      seenEntities.push(...page.entities.map(entity => entity.id));
      cursor = page.page.next_cursor;
    }
    expect(new Set(seenFacts).size).toBe(3);
    expect(seenEntities).toHaveLength(1);
  });

  it('returns the same bounded ranked facts through REST and MCP', async () => {
    const query = 'How are application images deployed?';
    let restPayload: any;
    await searchRouteHandler()(
      { query: { q: query.toUpperCase(), kb_id: kbId, limit: 10 }, authContext: OPEN_AUTH_CONTEXT },
      { json: (payload: any) => { restPayload = payload; } },
      (error?: unknown) => { if (error) throw error; },
    );
    const mcp = createMcpServer(services, undefined, OPEN_AUTH_CONTEXT) as any;
    const mcpResult = await mcp._registeredTools.search_knowledge.handler({
      query, kb_id: kbId, limit: 10,
    }, {});
    const mcpPayload = JSON.parse(mcpResult.content[0].text);
    expect(restPayload.facts.map((fact: { id: string }) => fact.id))
      .toEqual(mcpPayload.facts.map((fact: { id: string }) => fact.id));
    expect(restPayload.facts.map((fact: { id: string }) => fact.id))
      .toEqual([titleFactId, entityFactId, bodyFactId]);
    expect(restPayload.facts.every((fact: { content?: unknown }) => fact.content === undefined)).toBe(true);
    expect(mcpResult.structuredContent).toEqual(mcpPayload);
  });
});
