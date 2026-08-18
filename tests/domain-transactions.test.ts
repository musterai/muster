import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter, ExecutionResult } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { EventService } from '../src/services/event.service.js';
import { BoardService } from '../src/services/board.service.js';
import { DocumentService } from '../src/services/document.service.js';
import { ProjectService } from '../src/services/project.service.js';
import { InvitationService } from '../src/services/invitation.service.js';
import { RoleService } from '../src/services/role.service.js';
import { CardService } from '../src/services/card.service.js';
import { KBService } from '../src/services/kb.service.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-domain-transactions.db');

/** Inject a failure at a chosen SQL boundary, including inside nested transactions. */
class FailingAdapter implements DatabaseAdapter {
  readonly dialect;

  constructor(
    private readonly inner: DatabaseAdapter,
    private readonly shouldFail: (sql: string) => boolean,
    private readonly state = { failed: false },
  ) {
    this.dialect = inner.dialect;
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.inner.query<T>(sql, params);
  }

  execute(sql: string, params: unknown[] = []): Promise<ExecutionResult> {
    if (!this.state.failed && this.shouldFail(sql)) {
      this.state.failed = true;
      return Promise.reject(new Error(`injected failure: ${sql}`));
    }
    return this.inner.execute(sql, params);
  }

  transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.inner.transaction(tx => fn(new FailingAdapter(tx, this.shouldFail, this.state)));
  }

  migrate(sql: string): Promise<void> { return this.inner.migrate(sql); }
  close(): Promise<void> { return this.inner.close(); }
}

describe('MUS-65: multi-write transaction rollback boundaries', () => {
  let db: DatabaseAdapter;
  let workspaceId: string;

  beforeEach(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* clean slate */ }
    }
    db = createDatabaseAdapter(TEST_DB);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    workspaceId = 'ws-domain-transactions';
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Transactions', 'transactions', now, now],
    );
  });

  afterEach(async () => {
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* cleanup */ }
    }
  });

  it('rolls back project, board, protocol document, and events together', async () => {
    const failing = new FailingAdapter(db, sql => /INSERT INTO document_version/i.test(sql));
    const events = new EventService(failing);
    const boards = new BoardService(failing, events);
    const documents = new DocumentService(failing, events);
    const projects = new ProjectService(failing, events, boards, documents);

    await expect(projects.create({ name: 'Should Roll Back' })).rejects.toThrow('injected failure');
    expect((await db.query('SELECT id FROM project')).length).toBe(0);
    expect((await db.query('SELECT id FROM board')).length).toBe(0);
    expect((await db.query('SELECT id FROM document')).length).toBe(0);
    expect((await db.query('SELECT id FROM event')).length).toBe(0);
  });

  it('rolls back document content/version/event as one unit', async () => {
    const events = new EventService(db);
    const boards = new BoardService(db, events);
    const projects = new ProjectService(db, events, boards);
    const documents = new DocumentService(db, events);
    const project = await projects.create({ name: 'Document Rollback' });
    const document = await documents.create({ project_id: project.id, title: 'Original', content: 'one' });

    const failing = new FailingAdapter(db, sql => /INSERT INTO document_version/i.test(sql));
    const failingDocuments = new DocumentService(failing, new EventService(failing));
    await expect(failingDocuments.update(document.id, { content: 'two', change_summary: 'break' })).rejects.toThrow('injected failure');

    const row = (await db.query<{ content: string; version: number }>('SELECT content, version FROM document WHERE id = ?', [document.id]))[0];
    expect(row).toEqual({ content: 'one', version: 1 });
    expect((await db.query("SELECT id FROM event WHERE entity_id = ? AND action = 'updated'", [document.id])).length).toBe(0);
  });

  it('rolls back invitation consumption when membership insertion fails', async () => {
    const roles = new RoleService(db);
    const seeded = await roles.seedPreset(workspaceId);
    const invitations = new InvitationService(db);
    const invite = await invitations.create({ workspace_id: workspaceId, email: 'member@example.com', role_id: seeded[0].id });
    const userId = 'user-invite-rollback';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [userId, 'user', now]);
    await db.execute('INSERT INTO app_user (id, email, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)', [userId, 'member@example.com', 'Member', 'active', now]);

    const failing = new FailingAdapter(db, sql => /INSERT INTO workspace_member/i.test(sql));
    await expect(new InvitationService(failing).accept(invite.id, userId)).rejects.toThrow('injected failure');
    expect((await db.query('SELECT accepted_at FROM invitation WHERE id = ?', [invite.id]))[0].accepted_at).toBeNull();
    expect((await db.query('SELECT * FROM workspace_member WHERE user_id = ?', [userId])).length).toBe(0);
  });

  it('rolls back card associations and creation event together', async () => {
    const events = new EventService(db);
    const boards = new BoardService(db, events);
    const projects = new ProjectService(db, events, boards);
    const project = await projects.create({ name: 'Card Rollback' });
    const board = (await boards.list(project.id))[0];
    const columns = await db.query<{ id: string }>('SELECT id FROM "column" WHERE board_id = ? LIMIT 1', [board.id]);
    const agentId = 'agent-card-rollback';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [agentId, 'agent', now]);
    await db.execute('INSERT INTO agent (id, name, status, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?)', [agentId, 'Agent', 'active', now, now]);
    const labelId = 'label-card-rollback';
    await db.execute('INSERT INTO label (id, board_id, name, color) VALUES (?, ?, ?, ?)', [labelId, board.id, 'Label', 'neutral']);

    const failing = new FailingAdapter(db, sql => /card_assignee/i.test(sql));
    const cards = new CardService(failing, new EventService(failing));
    await expect(cards.create({ column_id: columns[0].id, title: 'Should Roll Back', labels: [labelId], assignees: [agentId] })).rejects.toThrow('injected failure');
    expect((await db.query('SELECT * FROM card')).length).toBe(0);
    expect((await db.query('SELECT * FROM card_label')).length).toBe(0);
    expect((await db.query('SELECT * FROM card_assignee')).length).toBe(0);
    expect((await db.query("SELECT * FROM event WHERE entity_type = 'card'")).length).toBe(0);
  });

  it('rolls back knowledge entity, fact, and event together', async () => {
    const events = new EventService(db);
    const projects = new ProjectService(db, events);
    const project = await projects.create({ name: 'KB Rollback' });
    const kbId = 'kb-domain-rollback';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO knowledge_base (id, name, is_global, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [kbId, 'KB', 0, now, now]);
    await db.execute('INSERT INTO project_knowledge_base (project_id, kb_id, created_at) VALUES (?, ?, ?)', [project.id, kbId, now]);

    const failing = new FailingAdapter(db, sql => /INSERT INTO kb_fact/i.test(sql));
    const kb = new KBService(failing, new EventService(failing));
    await expect(kb.addFact({ kb_id: kbId, title: 'Fact', content: '10.0.0.1' })).rejects.toThrow('injected failure');
    expect((await db.query('SELECT * FROM kb_fact')).length).toBe(0);
    expect((await db.query('SELECT * FROM kb_entity')).length).toBe(0);
    expect((await db.query("SELECT * FROM event WHERE entity_type = 'knowledge_base'")).length).toBe(0);
  });
});
