import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { AgentService, BoardService, CardService, DocumentService, EventService, KBService, ProjectService } from '../src/services/index.js';
import { cardListQuerySchema, eventQuerySchema } from '../src/api/schemas.js';
import { decodeCursor, encodeCursor, normalizePageLimit } from '../src/shared/pagination.js';

describe('bounded collection pagination', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let cards: CardService;
  let boards: BoardService;
  let documents: DocumentService;
  let agents: AgentService;
  let events: EventService;
  let kbs: KBService;
  let projectId: string;
  let boardId: string;
  let columnId: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `muster-pagination-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    db = createDatabaseAdapter(dbPath);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    const now = new Date().toISOString();
    await db.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['pagination-ws', 'Pagination', 'pagination', now, now]);
    events = new EventService(db);
    boards = new BoardService(db, events);
    const projects = new ProjectService(db, events, boards);
    cards = new CardService(db, events);
    documents = new DocumentService(db, events);
    agents = new AgentService(db, events);
    kbs = new KBService(db, events);
    const project = await projects.create({ name: 'Pagination fixture' });
    projectId = project.id;
    const board = (await boards.list(project.id))[0];
    boardId = board.id;
    columnId = (await db.query<{ id: string }>('SELECT id FROM "column" WHERE board_id = ? ORDER BY position ASC LIMIT 1', [board.id]))[0].id;
  });

  afterEach(async () => {
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(`${dbPath}${suffix}`)) fs.unlinkSync(`${dbPath}${suffix}`);
    }
  });

  it('validates limits and binds canonical opaque cursors to one collection scope', () => {
    expect(normalizePageLimit(undefined)).toBe(50);
    for (const value of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizePageLimit(value)).toThrow(/limit must be an integer/);
    }
    const cursor = encodeCursor('cards:one', ['m', 'card-1']);
    expect(decodeCursor(cursor, 'cards:one', 2)).toEqual(['m', 'card-1']);
    expect(() => decodeCursor(cursor, 'cards:two', 2)).toThrow(/cursor is invalid/);
    expect(() => decodeCursor(`${cursor}=`, 'cards:one', 2)).toThrow(/cursor is invalid/);
  });

  it('rejects repeated, non-finite, fractional, negative, and oversized REST page inputs', () => {
    for (const limit of [['1', '2'], 'NaN', 'Infinity', '-1', '1.5', '101']) {
      expect(cardListQuerySchema.safeParse({ limit }).success).toBe(false);
      expect(eventQuerySchema.safeParse({ limit }).success).toBe(false);
    }
    expect(cardListQuerySchema.parse({ limit: '100' }).limit).toBe(100);
  });

  it('walks a large card fixture without duplicates, includes an appended concurrent insert, and omits descriptions', async () => {
    const largeBody = 'sensitive-markdown-'.repeat(700);
    for (let index = 0; index < 105; index++) {
      await cards.create({ column_id: columnId, title: `Card ${index.toString().padStart(3, '0')}`, description: largeBody });
    }

    const budgetStartedAt = performance.now();
    const budgetPage = await cards.listPage({ board_id: boardId }, { limit: 100 });
    const budgetElapsedMs = performance.now() - budgetStartedAt;
    expect(budgetPage.items).toHaveLength(100);
    expect(JSON.stringify(budgetPage).length).toBeLessThan(100_000);
    expect(budgetElapsedMs).toBeLessThan(250);

    const first = await cards.listPage({ board_id: boardId }, { limit: 25 });
    expect(first.items).toHaveLength(25);
    expect(first.page.has_more).toBe(true);
    expect(first.items.every(item => !('description' in item))).toBe(true);
    const searchDefault = await cards.searchByTitlePage(projectId, 'Card');
    expect(searchDefault.page.limit).toBe(20);
    expect(searchDefault.items).toHaveLength(20);

    const appended = await cards.create({ column_id: columnId, title: 'Concurrent append', description: largeBody });
    const seen = [...first.items];
    let cursor = first.page.next_cursor;
    while (cursor) {
      const page = await cards.listPage({ board_id: boardId }, { limit: 25, cursor });
      seen.push(...page.items);
      cursor = page.page.next_cursor;
    }
    expect(new Set(seen.map(card => card.id)).size).toBe(seen.length);
    expect(seen.map(card => card.id)).toContain(appended.id);
    expect(seen).toHaveLength(106);
    await expect(cards.listPage({ project_id: projectId }, { limit: 25, cursor: first.page.next_cursor! })).rejects.toThrow(/cursor is invalid/);
  }, 30_000);

  it('returns body-free document and knowledge summaries with authorized detail reads', async () => {
    const document = await documents.create({ project_id: projectId, title: 'Architecture', content: '# confidential body' });
    const documentPage = await documents.listPage(projectId, {}, { limit: 1 });
    expect(documentPage.items[0].id).toBe(document.id);
    expect(documentPage.items[0]).not.toHaveProperty('content');
    expect((await documents.getById(document.id))?.content).toBe('# confidential body');
    await documents.update(document.id, { content: '# revised confidential body', change_summary: 'Revise body' });
    const historyPage = await documents.getHistoryPage(document.id, { limit: 1 });
    expect(historyPage.items).toHaveLength(1);
    expect(historyPage.items[0]).not.toHaveProperty('content');
    expect(historyPage.page.has_more).toBe(true);
    const olderHistory = await documents.getHistoryPage(document.id, { limit: 1, cursor: historyPage.page.next_cursor! });
    expect(olderHistory.items).toHaveLength(1);
    expect(olderHistory.items[0].version).toBe(1);
    expect((await documents.getById(document.id, 1))?.content).toBe('# confidential body');

    const kb = await kbs.create({ name: 'Pagination KB', project_ids: [projectId] });
    const fact = await kbs.addFact({ kb_id: kb.id, title: 'Fact', content: 'private fact content' });
    const factPage = await kbs.listFactsPage(kb.id, {}, { limit: 1 });
    expect(factPage.items[0].id).toBe(fact.id);
    expect(factPage.items[0]).not.toHaveProperty('content');
    expect((await kbs.getFactById(fact.id))?.content).toBe('private fact content');
    const search = await kbs.searchKnowledgePage('private fact', [kb.id], { limit: 1 });
    expect(search.facts[0]).not.toHaveProperty('content');
  });

  it('paginates agents and activity deterministically and installs keyset indexes', async () => {
    for (let index = 0; index < 4; index++) await agents.register({ name: `Agent ${index}` });
    const firstAgents = await agents.listPage(undefined, { limit: 2 });
    const secondAgents = await agents.listPage(undefined, { limit: 2, cursor: firstAgents.page.next_cursor! });
    expect(new Set([...firstAgents.items, ...secondAgents.items].map(agent => agent.id)).size).toBe(4);

    const firstEvents = await events.listPage(projectId, {}, { limit: 2 });
    expect(firstEvents.items.length).toBeLessThanOrEqual(2);
    if (firstEvents.page.next_cursor) {
      const secondEvents = await events.listPage(projectId, {}, { limit: 2, cursor: firstEvents.page.next_cursor });
      expect(secondEvents.items.some(event => firstEvents.items.some(first => first.id === event.id))).toBe(false);
    }

    const indexes = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%_id'");
    expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining([
      'idx_card_column_archived_position_id',
      'idx_document_project_title_id',
      'idx_event_project_created_id',
      'idx_kb_fact_kb_created_id',
    ]));
  });

  it('bounds the 105-row label, work-link, graph, entity-knowledge and 10MB metadata adversarial collections', async () => {
    for (let index = 0; index < 105; index++) {
      await boards.createLabel({ board_id: boardId, name: `Label ${index.toString().padStart(3, '0')}`, color: 'neutral' });
    }
    const labelPage = await boards.listLabelsPage(boardId, { limit: 100 });
    expect(labelPage.items).toHaveLength(100);
    expect(labelPage.page.has_more).toBe(true);
    expect((await boards.listLabelsPage(boardId, { limit: 100, cursor: labelPage.page.next_cursor! })).items).toHaveLength(5);
    await expect(boards.listLabelsPage('another-board', { cursor: labelPage.page.next_cursor! })).rejects.toThrow(/cursor is invalid/);

    const card = await cards.create({ column_id: columnId, title: 'Work-link fixture' });
    for (let index = 0; index < 105; index++) {
      await cards.addWorkLink(card.id, { kind: 'commit', provider: 'other', url: `https://example.test/${index}` });
    }
    const workLinks = await cards.listWorkLinksPage(card.id, { limit: 100 });
    expect(workLinks.items).toHaveLength(100);
    expect((await cards.listWorkLinksPage(card.id, { limit: 100, cursor: workLinks.page.next_cursor! })).items).toHaveLength(5);

    const kb = await kbs.create({ name: 'Adversarial KB', project_ids: [projectId] });
    const metadata = JSON.stringify({ payload: 'x'.repeat(99_900) });
    const now = new Date().toISOString();
    for (let index = 0; index < 105; index++) {
      const entityId = `bulk-entity-${index.toString().padStart(3, '0')}`;
      await db.execute('INSERT INTO kb_entity (id,kb_id,name,type,identifier,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [entityId, kb.id, `Bulk ${index.toString().padStart(3, '0')}`, 'custom', entityId, metadata, now, now]);
    }
    for (let index = 0; index < 105; index++) {
      await db.execute('INSERT INTO kb_fact (id,kb_id,entity_id,title,content,category,confidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [`bulk-fact-${index.toString().padStart(3, '0')}`, kb.id, 'bulk-entity-000', `Bulk fact ${index}`, 'private body '.repeat(100), 'test', 1, now, now]);
    }

    const searchFacts = await kbs.searchKnowledgePage('Bulk', [kb.id], { limit: 100 });
    expect(searchFacts.facts.length + searchFacts.entities.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(searchFacts).length).toBeLessThan(100_000);
    expect(searchFacts.facts.every(fact => !('content' in fact))).toBe(true);
    const searchEntities = await kbs.searchKnowledgePage('Bulk', [kb.id], { limit: 100, cursor: searchFacts.page.next_cursor! });
    expect(searchEntities.facts.length + searchEntities.entities.length).toBeLessThanOrEqual(100);
    expect(searchEntities.entities.every(entity => !('metadata' in entity))).toBe(true);
    expect(JSON.stringify(searchEntities).length).toBeLessThan(100_000);

    const graphFirst = await kbs.getGraphTree(kb.id, undefined, { limit: 100 });
    expect(graphFirst.nodes).toHaveLength(100);
    expect(graphFirst.page.has_more).toBe(true);
    expect(JSON.stringify(graphFirst).length).toBeLessThan(100_000);
    const graphSecond = await kbs.getGraphTree(kb.id, undefined, { limit: 100, cursor: graphFirst.page.next_cursor! });
    expect(graphSecond.nodes).toHaveLength(5);

    const knowledgeFirst = await kbs.getEntityKnowledge('bulk-entity-000', [kb.id], { limit: 100 });
    expect(knowledgeFirst?.facts).toHaveLength(100);
    expect(knowledgeFirst?.facts.every(fact => !('content' in fact))).toBe(true);
    expect(JSON.stringify(knowledgeFirst).length).toBeLessThan(100_000);
    const knowledgeSecond = await kbs.getEntityKnowledge('bulk-entity-000', [kb.id], { limit: 100, cursor: knowledgeFirst!.page.next_cursor! });
    expect(knowledgeSecond?.facts).toHaveLength(5);
  }, 30_000);
});
