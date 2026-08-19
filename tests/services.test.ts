// File: tests/services.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import {
  ProjectService,
  BoardService,
  ColumnService,
  CardService,
  CommentService,
  DocumentService,
  AgentService,
  EventService,
  KBService,
} from '../src/services/index.js';
import { rankBetween } from '../src/shared/lexorank.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test.db');

describe('Domain Services Integration Tests', () => {
  let db: DatabaseAdapter;
  let projectService: ProjectService;
  let boardService: BoardService;
  let columnService: ColumnService;
  let cardService: CardService;
  let commentService: CommentService;
  let documentService: DocumentService;
  let agentService: AgentService;
  let eventService: EventService;
  let kbService: KBService;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) {
      fs.unlinkSync(TEST_DB);
    }
    db = createDatabaseAdapter(TEST_DB);

    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    // Bootstrap a default workspace for tests that create projects
    const wsId = 'test-ws-01';
    const now = new Date().toISOString();
    await db.execute(
      `INSERT OR IGNORE INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [wsId, 'Test Workspace', 'test', now, now]
    );

    eventService = new EventService(db);
    boardService = new BoardService(db, eventService);
    projectService = new ProjectService(db, eventService, boardService);
    columnService = new ColumnService(db, eventService);
    cardService = new CardService(db, eventService);
    commentService = new CommentService(db, eventService);
    documentService = new DocumentService(db, eventService);
    agentService = new AgentService(db, eventService);
    kbService = new KBService(db, eventService);
  });

  afterEach(async () => {
    if (db) await db.close();
    if (fs.existsSync(TEST_DB)) {
      fs.unlinkSync(TEST_DB);
    }
  });

  it('Bug 1.1: project creation creates default board and columns', async () => {
    const project = await projectService.create({ name: 'Test Project', description: 'Desc' });
    expect(project.id).toBeDefined();
    expect(project.slug).toBe('test-project');

    const boards = await boardService.list(project.id);
    expect(boards.length).toBe(1);
    expect(boards[0].name).toBe('Sprint 1');
    expect(boards[0].slug).toBe('sprint-1');

    const columns = await columnService.list(boards[0].id);
    expect(columns.length).toBe(5);
    expect(columns.map(c => c.name)).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'Done']);
  });

  it('Feature: project update (name and description) works correctly and emits event', async () => {
    const project = await projectService.create({ name: 'Old Project Name', description: 'Old Desc' });
    const updated = await projectService.update(project.id, { name: 'New Project Name', description: 'Updated Desc' });

    expect(updated.name).toBe('New Project Name');
    expect(updated.slug).toBe('old-project-name');
    expect(updated.description).toBe('Updated Desc');

    const fetched = await projectService.getById(project.id);
    expect(fetched?.name).toBe('New Project Name');
    expect(fetched?.description).toBe('Updated Desc');

    const events = await eventService.list(project.id);
    const updateEvt = events.find(e => e.entity_type === 'project' && e.action === 'updated');
    expect(updateEvt).toBeDefined();
  });

  it('Feature: project summary includes not_done_card_count', async () => {
    const project = await projectService.create({ name: 'Summary Project' });
    const boards = await boardService.list(project.id);
    const cols = await columnService.list(boards[0].id);
    const todoCol = cols.find(c => c.name === 'To Do')!;
    const doneCol = cols.find(c => c.name === 'Done')!;

    await cardService.create({ column_id: todoCol.id, title: 'Card 1' });
    await cardService.create({ column_id: todoCol.id, title: 'Card 2' });
    await cardService.create({ column_id: doneCol.id, title: 'Card 3' });

    const summary = await projectService.getSummary(project.id);
    expect(summary.card_count).toBe(3);
    expect(summary.not_done_card_count).toBe(2);
  });

  it('Feature: board creation supports simple 3-lane template and custom columns', async () => {
    const project = await projectService.create({ name: 'Simplified Project' });

    // 3-lane board
    const simpleBoard = await boardService.create({ project_id: project.id, name: 'Simple Board', template: 'simple' });
    const simpleCols = await columnService.list(simpleBoard.id);
    expect(simpleCols.length).toBe(3);
    expect(simpleCols.map(c => c.name)).toEqual(['To Do', 'In Progress', 'Done']);
    expect(simpleBoard.slug).toBe('simple-board');

    // Custom columns board
    const customBoard = await boardService.create({
      project_id: project.id,
      name: 'Custom Board',
      columns: ['Idea', 'Building', 'QA', 'Shipped'],
    });
    const customCols = await columnService.list(customBoard.id);
    expect(customCols.length).toBe(4);
    expect(customCols.map(c => c.name)).toEqual(['Idea', 'Building', 'QA', 'Shipped']);
    expect(customBoard.slug).toBe('custom-board');
  });

  it('Feature: board update (rename) works correctly and emits event', async () => {
    const project = await projectService.create({ name: 'P' });
    const agent = await agentService.register({
      name: 'Agent 1',
    });
    const boards = await boardService.list(project.id);
    const initialBoard = boards[0];

    const updated = await boardService.update(initialBoard.id, { name: 'Sprint 1 - Renamed' }, agent.id);
    expect(updated.name).toBe('Sprint 1 - Renamed');
    expect(updated.slug).toBe('sprint-1');

    const fetched = await boardService.getById(initialBoard.id);
    expect(fetched?.name).toBe('Sprint 1 - Renamed');

    const events = await eventService.list(project.id);
    const renameEvent = events.find(e => e.entity_type === 'board' && e.action === 'updated');
    expect(renameEvent).toBeDefined();
    expect(renameEvent?.actor_id).toBe(agent.id);
  });

  it('Bug 1.2: column wip_limit works correctly', async () => {
    const project = await projectService.create({ name: 'P' });
    const boards = await boardService.list(project.id);
    const col = await columnService.create({ board_id: boards[0].id, name: 'Testing', wip_limit: 5 });

    expect(col.wip_limit).toBe(5);

    const updated = await columnService.update(col.id, { wip_limit: 10 });
    expect(updated.wip_limit).toBe(10);
  });

  it('MUS-19: reordering a column via position moves it in list() order', async () => {
    const project = await projectService.create({ name: 'P' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);
    expect(columns.length).toBeGreaterThanOrEqual(3);

    const [first, second, third] = columns;

    // Move the last of the three columns to the front.
    const newPosition = rankBetween(null, first.position);
    await columnService.update(third.id, { position: newPosition });

    const reordered = await columnService.list(boards[0].id);
    expect(reordered[0].id).toBe(third.id);
    expect(reordered[1].id).toBe(first.id);
    expect(reordered[2].id).toBe(second.id);

    const events = await eventService.list(project.id);
    const moveEvent = events.find(e => e.entity_type === 'column' && e.entity_id === third.id && e.action === 'updated');
    expect(moveEvent).toBeDefined();
  });

  it('Bug 1.3: commentService.create executes without SQL syntax error', async () => {
    const project = await projectService.create({ name: 'P' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);
    const card = await cardService.create({ column_id: columns[0].id, title: 'Card 1' });

    const agent = await agentService.register({
      name: 'Agent 1',
      capabilities: 'code',
      status: 'active'
    });

    const comment = await commentService.create({ card_id: card.id, author_id: agent.id, content: 'Test comment' });
    expect(comment.content).toBe('Test comment');

    const comments = await commentService.listByCard(card.id);
    expect(comments.length).toBe(1);

    // Test card deletion
    await cardService.delete(card.id);
    await expect(cardService.getById(card.id)).rejects.toThrow('not found');
  });

  it('MUS-36: commentService.update edits content, .delete removes the comment', async () => {
    const project = await projectService.create({ name: 'P' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);
    const card = await cardService.create({ column_id: columns[0].id, title: 'Card 1' });
    const agent = await agentService.register({ name: 'Agent 1', capabilities: 'code', status: 'active' });

    const comment = await commentService.create({ card_id: card.id, author_id: agent.id, content: 'Original' });

    const updated = await commentService.update(comment.id, 'Edited', agent.id);
    expect(updated.content).toBe('Edited');
    expect((await commentService.getById(comment.id))!.content).toBe('Edited');

    await commentService.delete(comment.id, agent.id);
    expect(await commentService.getById(comment.id)).toBeNull();

    await expect(commentService.update('nonexistent', 'x')).rejects.toThrow('not found');
    await expect(commentService.delete('nonexistent')).rejects.toThrow('not found');
  });

  it('unregistering an agent preserves an inert attribution tombstone', async () => {
    const project = await projectService.create({ name: 'P' });
    const agent = await agentService.register({
      name: 'Agent To Remove',
    });
    expect(agent.name).toBe('Agent To Remove');

    let agents = await agentService.list();
    expect(agents.some(a => a.id === agent.id)).toBe(true);

    await agentService.unregister(agent.id);

    agents = await agentService.list();
    const tombstone = agents.find(a => a.id === agent.id);
    expect(tombstone).toMatchObject({
      status: 'offline',
      operator_user_id: null,
      role_id: null,
      capabilities: [],
    });
  });

  it('Bug 1.4: document creation and update succeed without version title error', async () => {
    const project = await projectService.create({ name: 'P' });
    const agent = await agentService.register({
      name: 'Agent 1',
      capabilities: 'code',
      status: 'active'
    });

    const doc = await documentService.create({
      project_id: project.id,
      title: 'Spec',
      content: 'v1 content',
      author_id: agent.id
    });
    expect(doc.version).toBe(1);

    const updated = await documentService.update(doc.id, {
      title: 'Spec v2',
      content: 'v2 content',
      change_summary: 'Updated content',
      author_id: agent.id
    });
    expect(updated.version).toBe(2);
    expect(updated.title).toBe('Spec v2');

    const history = await documentService.getHistory(doc.id);
    expect(history.length).toBe(2);
  });

  it('Feature: document version history attributes each edit to its actual author', async () => {
    const project = await projectService.create({ name: 'P' });
    const author = await agentService.register({
      name: 'Original Author',
    });
    const editor = await agentService.register({
      name: 'Later Editor',
    });

    const doc = await documentService.create(
      { project_id: project.id, title: 'Spec', content: 'v1' },
      author.id
    );

    // Edit by a different actor, passed as actorId rather than in the payload.
    await documentService.update(doc.id, { content: 'v2', change_summary: 'Revised' }, editor.id);

    // Edit by an unidentified caller must not inherit the previous author.
    await documentService.update(doc.id, { content: 'v3', change_summary: 'Anonymous' });

    const history = await documentService.getHistory(doc.id);
    expect(history.map(v => v.version)).toEqual([3, 2, 1]);

    const [v3, v2, v1] = history;
    expect(v1.author_id).toBe(author.id);
    expect(v1.author_name).toBe('Original Author');
    expect(v2.author_id).toBe(editor.id);
    expect(v2.author_name).toBe('Later Editor');
    expect(v3.author_id).toBeNull();
    expect(v3.author_name).toBeNull();

    // The document row keeps its last known author rather than going null.
    const current = await documentService.getById(doc.id);
    expect(current?.author_id).toBe(editor.id);

    // Document deletion cleans up versions and document record
    await documentService.delete(doc.id);
    const deleted = await documentService.getById(doc.id);
    expect(deleted).toBeNull();
    const deletedHistory = await documentService.getHistory(doc.id);
    expect(deletedHistory).toEqual([]);
  });

  it('MUS-59: credential-derived document and KB actors override legacy payload attribution', async () => {
    const project = await projectService.create({ name: 'Attribution precedence project' });
    const realActor = await agentService.register({ name: 'Credential actor' });
    const spoofedActor = await agentService.register({ name: 'Payload spoof target' });

    const doc = await documentService.create({
      project_id: project.id,
      title: 'Credential-derived author',
      content: 'v1',
      author_id: spoofedActor.id,
    }, realActor.id);
    expect(doc.author_id).toBe(realActor.id);

    await documentService.update(doc.id, {
      content: 'v2',
      author_id: spoofedActor.id,
    }, realActor.id);
    const history = await documentService.getHistory(doc.id);
    expect(history[0].author_id).toBe(realActor.id);

    const kb = await kbService.create({ name: 'Attribution precedence KB', project_ids: [project.id] }, realActor.id);
    const fact = await kbService.addFact({
      kb_id: kb.id,
      title: 'Credential-derived source',
      content: 'fact',
      source_principal_id: spoofedActor.id,
    }, realActor.id);
    expect(fact.source_principal_id).toBe(realActor.id);
  });

  it('Feature: agent registration and session re-binding', async () => {
    // Register initial agent
    const initialAgent = await agentService.register({
      name: 'Claude 3.7',
      capabilities: ['code', 'testing']
    });
    expect(initialAgent.id).toBeDefined();

    // Re-bind session using existing agent_id
    const reboundAgent = await agentService.register({
      agent_id: initialAgent.id,
      name: 'Claude 3.7 (Rebound)'
    });

    expect(reboundAgent.id).toBe(initialAgent.id);
    expect(reboundAgent.name).toBe('Claude 3.7 (Rebound)');
    expect(reboundAgent.status).toBe('active');

    // Update agent attributes
    const updatedAgent = await agentService.update(initialAgent.id, {
      name: 'Claude 3.7 Sonnet (Updated)',
      capabilities: ['code', 'architecture', 'review'],
    });

    expect(updatedAgent.name).toBe('Claude 3.7 Sonnet (Updated)');
    expect(updatedAgent.capabilities).toEqual(['code', 'architecture', 'review']);
  });

  it('includes assignee summaries when listing board cards', async () => {
    const project = await projectService.create({ name: 'Assigned Cards Project' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);
    const card = await cardService.create({
      column_id: columns[0].id,
      title: 'Assigned task',
    });
    const assignedAgent = await agentService.register({
      name: 'Working Agent',
      status: 'active',
    });
    await cardService.assign(card.id, assignedAgent.id);

    const listedCards = await cardService.list({ board_id: boards[0].id });

    expect(listedCards).toHaveLength(1);
    expect(listedCards[0].assignees).toEqual([
      {
        id: assignedAgent.id,
        name: 'Working Agent',
        kind: 'agent',
        status: 'active',
      },
    ]);
  });

  it('Feature: card-to-card linking supports blocks/blocked_by/relates_to and title search', async () => {
    const project = await projectService.create({ name: 'Linking Project' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);

    const cardA = await cardService.create({ column_id: columns[0].id, title: 'Implement login API' });
    const cardB = await cardService.create({ column_id: columns[0].id, title: 'Design login UI' });
    const cardC = await cardService.create({ column_id: columns[0].id, title: 'Write login docs' });

    // A blocks B -> B should see "blocked_by" A
    await cardService.linkCard(cardA.key, cardB.key, 'blocks');
    const detailsA = await cardService.getById(cardA.id);
    const detailsB = await cardService.getById(cardB.id);
    expect(detailsA.linked_cards.find(l => l.card.id === cardB.id)?.relation_type).toBe('blocks');
    expect(detailsB.linked_cards.find(l => l.card.id === cardA.id)?.relation_type).toBe('blocked_by');

    // Choosing "blocked_by" from the other side stores the inverse direction
    await cardService.linkCard(cardC.key, cardA.key, 'blocked_by');
    const detailsC = await cardService.getById(cardC.id);
    expect(detailsC.linked_cards.find(l => l.card.id === cardA.id)?.relation_type).toBe('blocked_by');
    const detailsA2 = await cardService.getById(cardA.id);
    expect(detailsA2.linked_cards.find(l => l.card.id === cardC.id)?.relation_type).toBe('blocks');

    // Symmetric relation
    await cardService.linkCard(cardB.key, cardC.key, 'relates_to');
    const detailsB2 = await cardService.getById(cardB.id);
    const detailsC2 = await cardService.getById(cardC.id);
    expect(detailsB2.linked_cards.find(l => l.card.id === cardC.id)?.relation_type).toBe('relates_to');
    expect(detailsC2.linked_cards.find(l => l.card.id === cardB.id)?.relation_type).toBe('relates_to');

    // Self-linking is rejected
    await expect(cardService.linkCard(cardA.id, cardA.id, 'relates_to')).rejects.toThrow();

    // Title search is project-scoped and excludes the given card
    const results = await cardService.searchByTitle(project.id, 'login', { excludeCardId: cardA.id });
    expect(results.map(r => r.id).sort()).toEqual([cardB.id, cardC.id].sort());
    const resultsByKey = await cardService.searchByTitle(project.id, 'LOGIN', { excludeCardId: cardB.key, limit: 1 });
    expect(resultsByKey).toHaveLength(1);
    expect(resultsByKey[0].id).not.toBe(cardB.id);

    const literalWildcard = await cardService.create({ column_id: columns[0].id, title: 'Handle 100% completion' });
    const wildcardResults = await cardService.searchByTitle(project.id, '100%');
    expect(wildcardResults.map(r => r.id)).toEqual([literalWildcard.id]);

    // Unlinking removes the relation from both sides
    const linkId = detailsA2.linked_cards.find(l => l.card.id === cardB.id)!.id;
    await cardService.unlinkCard(cardA.id, linkId);
    const detailsA3 = await cardService.getById(cardA.id);
    const detailsB3 = await cardService.getById(cardB.id);
    expect(detailsA3.linked_cards.some(l => l.card.id === cardB.id)).toBe(false);
    expect(detailsB3.linked_cards.some(l => l.card.id === cardA.id)).toBe(false);

    // Deleting a card cleans up its links
    await cardService.delete(cardC.id);
    const detailsA4 = await cardService.getById(cardA.id);
    expect(detailsA4.linked_cards.some(l => l.card.id === cardC.id)).toBe(false);
  });

  it('resolves human-readable card keys for all card-scoped writers', async () => {
    const project = await projectService.create({ name: 'Keyed Writes Project' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);
    const source = await cardService.create({ column_id: columns[0].id, title: 'Keyed source' });
    const target = await cardService.create({ column_id: columns[0].id, title: 'Keyed target' });
    const agent = await agentService.register({ name: 'Keyed Writes Agent' });

    const updated = await cardService.update(source.key, { title: 'Updated by key' });
    expect(updated.id).toBe(source.id);
    expect(updated.title).toBe('Updated by key');

    const moved = await cardService.move(source.key, { target_column_id: columns[1].id });
    expect(moved.id).toBe(source.id);
    expect(moved.column_id).toBe(columns[1].id);

    await cardService.assign(source.key, agent.id);
    expect((await cardService.getById(source.id)).assignees.some(a => a.id === agent.id)).toBe(true);
    await cardService.unassign(source.key, agent.id);
    expect((await cardService.getById(source.id)).assignees.some(a => a.id === agent.id)).toBe(false);

    const document = await documentService.create({
      project_id: project.id,
      title: 'Keyed link document',
      content: 'content',
    });
    await cardService.linkDocument(source.key, document.id);
    expect((await cardService.getById(source.id)).linked_documents.some(d => d.id === document.id)).toBe(true);
    await cardService.unlinkDocument(source.key, document.id);
    expect((await cardService.getById(source.id)).linked_documents.some(d => d.id === document.id)).toBe(false);

    const workLink = await cardService.addWorkLink(source.key, {
      kind: 'branch',
      provider: 'github',
      url: 'https://github.com/example/repo/tree/feature/keyed-card',
    });
    expect(workLink.card_id).toBe(source.id);
    expect((await cardService.listWorkLinks(source.key)).map(link => link.card_id)).toEqual([source.id]);
    await cardService.removeWorkLink(source.key, workLink.id);
    expect(await cardService.listWorkLinks(source.key)).toEqual([]);

    const comment = await commentService.create({
      card_id: source.key,
      author_id: agent.id,
      content: 'Comment created by key',
    });
    expect(comment.card_id).toBe(source.id);
    expect((await commentService.listByCard(source.key)).map(item => item.id)).toEqual([comment.id]);

    const claim = await cardService.claim(target.key, agent.id);
    expect('success' in claim ? claim.success : claim.claimed_by).not.toBe(false);
    await cardService.archive(target.key);
    expect((await cardService.getById(target.id)).archived).toBe(1);
    await cardService.delete(target.key);
    await expect(cardService.getById(target.id)).rejects.toThrow(/not found/);
  });

  it('Feature: epic cards flag themselves and link to children via parent_of/child_of', async () => {
    const project = await projectService.create({ name: 'Epic Project' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);

    const epic = await cardService.create({ column_id: columns[0].id, title: 'Ship the rewrite', is_epic: true });
    const child1 = await cardService.create({ column_id: columns[0].id, title: 'Squash the schema' });
    const child2 = await cardService.create({ column_id: columns[0].id, title: 'Enforce permissions' });

    expect(epic.is_epic).toBeTruthy();

    // Epic -> child, stored canonically as parent_of
    await cardService.linkCard(epic.id, child1.id, 'parent_of');
    const epicDetails = await cardService.getById(epic.id);
    const child1Details = await cardService.getById(child1.id);
    expect(epicDetails.linked_cards.find(l => l.card.id === child1.id)?.relation_type).toBe('parent_of');
    expect(child1Details.linked_cards.find(l => l.card.id === epic.id)?.relation_type).toBe('child_of');

    // Declaring it from the child's side ("child_of") stores the same inverse direction
    await cardService.linkCard(child2.id, epic.id, 'child_of');
    const epicDetails2 = await cardService.getById(epic.id);
    const child2Details = await cardService.getById(child2.id);
    expect(epicDetails2.linked_cards.find(l => l.card.id === child2.id)?.relation_type).toBe('parent_of');
    expect(child2Details.linked_cards.find(l => l.card.id === epic.id)?.relation_type).toBe('child_of');

    // A plain card is not an epic by default
    const plain = await cardService.create({ column_id: columns[0].id, title: 'Ordinary task' });
    expect(plain.is_epic).toBeFalsy();

    // is_epic can be toggled after creation via update()
    const updated = await cardService.update(plain.id, { is_epic: true });
    expect(updated.is_epic).toBeTruthy();
  });

  it('Card keys: cards get short, sequential, project-scoped keys', async () => {
    const project = await projectService.create({ name: 'Collaborative Agent Platform' });
    expect(project.key_prefix).toBe('CAP');

    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);

    const cardA = await cardService.create({ column_id: columns[0].id, title: 'A' });
    const cardB = await cardService.create({ column_id: columns[0].id, title: 'B' });
    expect(cardA.key).toBe('CAP-1');
    expect(cardB.key).toBe('CAP-2');

    // A second project with a colliding acronym gets a disambiguated prefix,
    // and its card sequence starts independently from 1.
    const otherProject = await projectService.create({ name: 'Client Approval Portal' });
    expect(otherProject.key_prefix).toBe('CAP2');

    const otherBoards = await boardService.list(otherProject.id);
    const otherColumns = await columnService.list(otherBoards[0].id);
    const otherCard = await cardService.create({ column_id: otherColumns[0].id, title: 'C' });
    expect(otherCard.key).toBe('CAP2-1');

    // Keys round-trip through getById/list.
    const fetched = await cardService.getById(cardA.id);
    expect(fetched.key).toBe('CAP-1');
    const listed = await cardService.list({ column_id: columns[0].id });
    expect(listed.map(c => c.key).sort()).toEqual(['CAP-1', 'CAP-2']);
  });

  it('Card keys: legacy rows without a key are backfilled on migrator startup', async () => {
    const project = await projectService.create({ name: 'Muster' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);
    const card = await cardService.create({ column_id: columns[0].id, title: 'Legacy' });
    expect(card.key).toBe('MUS-1');

    // Simulate rows written before migration 010 by wiping the derived columns.
    await db.execute('UPDATE project SET key_prefix = NULL, card_seq = 0 WHERE id = ?', [project.id]);
    await db.execute('UPDATE card SET key = NULL WHERE id = ?', [card.id]);

    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    const backfilledProject = await projectService.getById(project.id);
    expect(backfilledProject?.key_prefix).toBe('MUS');
    const backfilledCard = await cardService.getById(card.id);
    expect(backfilledCard.key).toBe('MUS-1');

    // Running the migrator again must not change already-assigned keys.
    await migrator.run();
    const stableCard = await cardService.getById(card.id);
    expect(stableCard.key).toBe('MUS-1');
  });

  it('Feature: work links can be attached, listed, removed, reject unsafe schemes, and cascade on delete', async () => {
    const project = await projectService.create({ name: 'Work Links Project' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);

    const card = await cardService.create({ column_id: columns[0].id, title: 'Implement atomic claim' });

    const branchLink = await cardService.addWorkLink(card.id, {
      kind: 'branch',
      provider: 'forgejo',
      url: 'https://forgejo.example/org/repo/src/branch/feat/atomic-claim',
      external_ref: 'feat/atomic-claim',
    });
    expect(branchLink.id).toBeTruthy();

    await cardService.addWorkLink(card.id, {
      kind: 'pull_request',
      provider: 'forgejo',
      url: 'https://forgejo.example/org/repo/pulls/42',
      external_ref: '#42',
      title: 'Atomic card claiming',
    });

    const details = await cardService.getById(card.id);
    expect(details.work_links).toHaveLength(2);
    expect(details.work_links.map(l => l.kind).sort()).toEqual(['branch', 'pull_request']);

    const listed = await cardService.listWorkLinks(card.id);
    expect(listed).toHaveLength(2);

    // Reject unsafe URL schemes at the service layer
    await expect(cardService.addWorkLink(card.id, {
      kind: 'commit',
      provider: 'github',
      url: 'javascript:alert(1)',
    })).rejects.toThrow();

    await expect(cardService.addWorkLink(card.id, {
      kind: 'commit',
      provider: 'github',
      url: 'data:text/html,<script>alert(1)</script>',
    })).rejects.toThrow();

    // Removing a link drops it from the list
    await cardService.removeWorkLink(card.id, branchLink.id);
    const afterRemove = await cardService.getById(card.id);
    expect(afterRemove.work_links.some(l => l.id === branchLink.id)).toBe(false);
    expect(afterRemove.work_links).toHaveLength(1);

    // Deleting a card cleans up its work links
    await cardService.delete(card.id);
    await expect(cardService.getById(card.id)).rejects.toThrow();
  });
});
