import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplicationServices, type ApplicationServices } from '../src/application/composition.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { Migrator } from '../src/db/migrator.js';

describe('root-injected card operation collaborators', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let services: ApplicationServices;
  let projectId: string;
  let boardId: string;
  let todoId: string;
  let doneId: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `muster-card-operations-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    db = createDatabaseAdapter(dbPath);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['operations-ws', 'Operations', 'operations', now, now],
    );
    services = createApplicationServices(db);
    const project = await services.projectService.create({ name: 'Operation seams' });
    projectId = project.id;
    const board = (await services.boardService.list(project.id))[0];
    boardId = board.id;
    const columns = await services.columnService.list(board.id);
    todoId = columns.find(column => column.name === 'To Do')!.id;
    doneId = columns.find(column => column.name === 'Done')!.id;
  });

  afterEach(async () => {
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(`${dbPath}${suffix}`)) fs.unlinkSync(`${dbPath}${suffix}`);
    }
  });

  it('owns the full move/rank transaction and completion events directly', async () => {
    const card = await services.cardService.create({ column_id: todoId, title: 'Move directly' });
    const canonicalId = await services.cardMoveOperations.move(
      card.id,
      { target_column_id: doneId, position: 'm' },
    );
    expect(canonicalId).toBe(card.id);
    const row = (await db.query<{ column_id: string; position: string }>(
      'SELECT column_id, position FROM card WHERE id = ?',
      [card.id],
    ))[0];
    expect(row.column_id).toBe(doneId);
    expect(row.position).toMatch(/^[a-z]+$/);
    const actions = (await services.eventService.list(projectId))
      .filter(event => event.entity_id === card.id)
      .map(event => event.action);
    expect(actions).toEqual(expect.arrayContaining(['moved', 'completed']));
  });

  it('owns assignment, claim CAS and expiry release directly', async () => {
    const card = await services.cardService.create({ column_id: todoId, title: 'Claim directly' });
    const agent = await services.agentService.register({ name: 'Operation Agent' });
    await services.cardAssignmentOperations.assign(card.id, agent.id);
    expect(await db.query(
      'SELECT card_id FROM card_assignee WHERE card_id = ? AND principal_id = ?',
      [card.id, agent.id],
    )).toHaveLength(1);

    const claim = await services.cardAssignmentOperations.claim(card.id, agent.id, 30);
    expect(claim).toEqual({ success: true, cardId: card.id });
    await db.execute(
      'UPDATE card SET claim_expires_at = ? WHERE id = ?',
      [new Date(Date.now() - 1000).toISOString(), card.id],
    );
    expect(await services.cardAssignmentOperations.releaseExpiredLeases()).toEqual([card.id]);
    expect((await db.query<{ claimed_by: string | null }>(
      'SELECT claimed_by FROM card WHERE id = ?',
      [card.id],
    ))[0].claimed_by).toBeNull();
  });

  it('owns relation/work-link transactions and the facade delegates exact instances', async () => {
    const source = await services.cardService.create({ column_id: todoId, title: 'Relations source' });
    const target = await services.cardService.create({ column_id: todoId, title: 'Relations target' });
    const document = await services.documentService.create({
      project_id: projectId,
      title: 'Related design',
      content: '# relation',
    });

    await services.cardRelationOperations.linkDocument(source.id, document.id);
    await services.cardRelationOperations.linkCard(source.id, target.id, 'relates_to');
    const link = await services.cardRelationOperations.addWorkLink(source.id, {
      kind: 'commit',
      provider: 'other',
      url: 'https://local.invalid/commit/direct',
    });
    expect((await services.cardRelationOperations.listWorkLinksPage(source.id)).items)
      .toContainEqual(link);

    const moveSpy = vi.spyOn(services.cardMoveOperations, 'move');
    const assignmentSpy = vi.spyOn(services.cardAssignmentOperations, 'assign');
    const relationSpy = vi.spyOn(services.cardRelationOperations, 'addWorkLink');
    await services.cardService.move(source.id, { position: 'a' });
    const agent = await services.agentService.register({ name: 'Facade Agent' });
    await services.cardService.assign(source.id, agent.id);
    await services.cardService.addWorkLink(source.id, {
      kind: 'branch',
      provider: 'other',
      url: 'https://local.invalid/branch/facade',
    });
    expect(moveSpy).toHaveBeenCalledOnce();
    expect(assignmentSpy).toHaveBeenCalledOnce();
    expect(relationSpy).toHaveBeenCalledOnce();
    expect((await services.cardService.list({ board_id: boardId })).map(card => card.id))
      .toContain(source.id);
  });
});
