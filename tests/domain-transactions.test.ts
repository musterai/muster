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
import { AuditService } from '../src/services/audit.service.js';
import { TokenService } from '../src/services/token.service.js';
import type { AuthContext } from '../src/shared/auth-context.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { Services } from '../src/shared/services.js';

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
  afterCommit(callback: () => void | Promise<void>): void | Promise<void> {
    return this.inner.afterCommit?.(callback);
  }
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
    const published: unknown[] = [];
    const events = new EventService(failing, event => { published.push(event); });
    const boards = new BoardService(failing, events);
    const documents = new DocumentService(failing, events);
    const projects = new ProjectService(failing, events, boards, documents);

    await expect(projects.create({ name: 'Should Roll Back' })).rejects.toThrow('injected failure');
    expect((await db.query('SELECT id FROM project')).length).toBe(0);
    expect((await db.query('SELECT id FROM board')).length).toBe(0);
    expect((await db.query('SELECT id FROM document')).length).toBe(0);
    expect((await db.query('SELECT id FROM event')).length).toBe(0);
    expect(published).toHaveLength(0);
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

  it('rolls back board, column, comment, and KB event boundaries', async () => {
    const events = new EventService(db);
    const boards = new BoardService(db, events);
    const projects = new ProjectService(db, events, boards);
    const project = await projects.create({ name: 'Boundary inventory' });
    const board = (await boards.list(project.id))[0];

    const failingBoardDb = new FailingAdapter(db, sql => /INSERT INTO event/i.test(sql));
    await expect(new BoardService(failingBoardDb, new EventService(failingBoardDb)).update(board.id, { name: 'Should roll back' }))
      .rejects.toThrow('injected failure');
    expect((await db.query<{ name: string }>('SELECT name FROM board WHERE id = ?', [board.id]))[0].name).toBe(board.name);

    const failingColumnDb = new FailingAdapter(db, sql => /INSERT INTO event/i.test(sql));
    const { ColumnService } = await import('../src/services/column.service.js');
    await expect(new ColumnService(failingColumnDb, new EventService(failingColumnDb)).create({ board_id: board.id, name: 'Transient' }))
      .rejects.toThrow('injected failure');
    expect((await db.query('SELECT id FROM "column" WHERE board_id = ? AND name = ?', [board.id, 'Transient'])).length).toBe(0);

    const cardColumns = await db.query<{ id: string }>('SELECT id FROM "column" WHERE board_id = ? ORDER BY position LIMIT 1', [board.id]);
    const cards = new CardService(db, events);
    const card = await cards.create({ column_id: cardColumns[0].id, title: 'Comment boundary' });
    const boundaryNow = new Date().toISOString();
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['boundary-author', 'user', boundaryNow]);
    const failingCommentDb = new FailingAdapter(db, sql => /INSERT INTO event/i.test(sql));
    const { CommentService } = await import('../src/services/comment.service.js');
    await expect(new CommentService(failingCommentDb, new EventService(failingCommentDb)).create({
      card_id: card.id, author_id: 'boundary-author', content: 'Transient comment',
    })).rejects.toThrow('injected failure');
    expect((await db.query('SELECT id FROM comment WHERE card_id = ?', [card.id])).length).toBe(0);

    const kb = new KBService(db, events);
    const knowledgeBase = await kb.create({ name: 'Boundary KB', project_ids: [project.id] });
    const entity = await kb.upsertEntity({ kb_id: knowledgeBase.id, name: 'Original', type: 'service' });
    const failingKbDb = new FailingAdapter(db, sql => /INSERT INTO event/i.test(sql));
    await expect(new KBService(failingKbDb, new EventService(failingKbDb)).updateEntity(entity.id, { name: 'Transient' }))
      .rejects.toThrow('injected failure');
    expect((await db.query<{ name: string }>('SELECT name FROM kb_entity WHERE id = ?', [entity.id]))[0].name).toBe('Original');
  });

  it('rolls back a committed mutation when its privileged audit insert fails', async () => {
    const projects = new ProjectService(db);
    const project = await projects.create({ name: 'Audit rollback' });
    const failing = new FailingAdapter(db, sql => /INSERT INTO audit_log/i.test(sql));
    const audit = new AuditService(failing);

    await expect(failing.transaction(async tx => {
      await projects.delete(project.id, 'actor-audit', tx);
      await audit.log({
        workspace_id: workspaceId,
        actor: { id: 'actor-audit', kind: 'user' },
        action: 'project.delete',
        target_type: 'project',
        target_id: project.id,
      }, tx);
    })).rejects.toThrow('injected failure');

    expect(await projects.getById(project.id)).not.toBeNull();
    expect((await db.query('SELECT id FROM audit_log WHERE target_id = ?', [project.id])).length).toBe(0);
  });

  it('deletes production-wired projects and leaves a workspace-scoped audit tombstone', async () => {
    const events = new EventService(db);
    const projects = new ProjectService(db, events);
    const project = await projects.create({ name: 'Production delete' });
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['delete-actor', 'user', new Date().toISOString()]);
    const audit = new AuditService(db);
    await db.transaction(async tx => {
      await projects.delete(project.id, 'delete-actor', tx);
      await audit.log({
        workspace_id: workspaceId,
        actor: { id: 'delete-actor', kind: 'user' },
        action: 'project.delete',
        target_type: 'project',
        target_id: project.id,
        payload: { name: project.name },
      }, tx);
    });
    expect(await projects.getById(project.id)).toBeNull();
    expect((await db.query<{ action: string }>('SELECT action FROM audit_log WHERE target_id = ?', [project.id]))[0].action)
      .toBe('project.delete');
    expect((await db.query("SELECT id FROM event WHERE entity_type = 'project' AND entity_id = ? AND action = 'deleted'", [project.id])).length)
      .toBe(0);
  });

  it('rolls back token issuance and revocation with their audit records', async () => {
    const roles = new RoleService(db);
    const owner = (await roles.seedPreset(workspaceId)).find(role => role.key === 'owner')!;
    const userId = 'audit-token-user';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [userId, 'user', now]);
    await db.execute('INSERT INTO app_user (id, email, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)', [userId, 'audit-token@example.com', 'Audit Token', 'active', now]);
    await db.execute('INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)', [workspaceId, userId, owner.id, now]);
    const auth: AuthContext = { principal: { id: userId, kind: 'user' }, workspace_id: workspaceId, is_workspace_member: true, permissions: owner.permissions, is_operator_override: false, role_name: owner.name };
    const tokenService = new TokenService(db);
    const created = await tokenService.create({ principal_id: userId, workspace_id: workspaceId, name: 'rollback target' });
    const failing = new FailingAdapter(db, sql => /INSERT INTO audit_log/i.test(sql));
    const failingTokens = new TokenService(failing);
    const audit = new AuditService(failing);

    await expect(failing.transaction(async tx => {
      const issued = await failingTokens.issue(auth, { name: 'should roll back' }, tx);
      await audit.log({ workspace_id: workspaceId, actor: auth.principal, action: 'token.create', target_type: 'api_token', target_id: issued.id }, tx);
    })).rejects.toThrow('injected failure');
    expect((await db.query('SELECT id FROM api_token WHERE name = ?', ['should roll back'])).length).toBe(0);

    const failingRevoke = new FailingAdapter(db, sql => /INSERT INTO audit_log/i.test(sql));
    const revokeTokens = new TokenService(failingRevoke);
    const revokeAudit = new AuditService(failingRevoke);
    await expect(failingRevoke.transaction(async tx => {
      await revokeTokens.revoke(created.id, tx);
      await revokeAudit.log({ workspace_id: workspaceId, actor: auth.principal, action: 'token.revoke', target_type: 'api_token', target_id: created.id }, tx);
    })).rejects.toThrow('injected failure');
    expect((await db.query<{ revoked_at: string | null }>('SELECT revoked_at FROM api_token WHERE id = ?', [created.id]))[0].revoked_at).toBeNull();
  });

  it('serializes duplicate invitation acceptance and concurrent bootstrap writes', async () => {
    const roles = new RoleService(db);
    const owner = (await roles.seedPreset(workspaceId)).find(role => role.key === 'owner')!;
    const invitations = new InvitationService(db);
    const invite = await invitations.create({ workspace_id: workspaceId, email: 'race@example.com', role_id: owner.id });
    const now = new Date().toISOString();
    for (const userId of ['race-user-a', 'race-user-b']) {
      await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [userId, 'user', now]);
      await db.execute('INSERT INTO app_user (id, email, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)', [userId, `${userId}@example.com`, userId, 'active', now]);
    }
    const accepted = await Promise.allSettled([
      invitations.accept(invite.id, 'race-user-a'),
      invitations.accept(invite.id, 'race-user-b'),
    ]);
    expect(accepted.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await db.query('SELECT user_id FROM workspace_member WHERE workspace_id = ?', [workspaceId])).length).toBe(1);

    const events = new EventService(db);
    const boards = new BoardService(db, events);
    const documents = new DocumentService(db, events);
    const projects = new ProjectService(db, events, boards, documents);
    const createdProjects = await Promise.all([
      projects.create({ name: 'Concurrent bootstrap A' }),
      projects.create({ name: 'Concurrent bootstrap B' }),
    ]);
    expect(new Set(createdProjects.map(project => project.id)).size).toBe(2);
    expect((await db.query('SELECT id FROM board WHERE project_id IN (?, ?)', createdProjects.map(project => project.id))).length).toBe(2);
  });

  it('serializes document versions and emits one event for duplicate association retries', async () => {
    const events = new EventService(db);
    const boards = new BoardService(db, events);
    const documents = new DocumentService(db, events);
    const projects = new ProjectService(db, events, boards, documents);
    const project = await projects.create({ name: 'Concurrent document' });
    const document = await documents.create({ project_id: project.id, title: 'Versioned', content: 'v1' });
    await Promise.all([
      documents.update(document.id, { content: 'v2', change_summary: 'first' }),
      documents.update(document.id, { content: 'v3', change_summary: 'second' }),
    ]);
    expect((await db.query<{ version: number }>('SELECT version FROM document WHERE id = ?', [document.id]))[0].version).toBe(3);
    expect((await db.query('SELECT id FROM document_version WHERE document_id = ?', [document.id])).length).toBe(3);

    const board = (await boards.list(project.id))[0];
    const column = (await db.query<{ id: string }>('SELECT id FROM "column" WHERE board_id = ? LIMIT 1', [board.id]))[0];
    const cards = new CardService(db, events);
    const card = await cards.create({ column_id: column.id, title: 'Association retry' });
    await Promise.all([cards.linkDocument(card.id, document.id), cards.linkDocument(card.id, document.id)]);
    expect((await db.query('SELECT card_id FROM card_document WHERE card_id = ?', [card.id])).length).toBe(1);
    expect((await db.query("SELECT id FROM event WHERE entity_id = ? AND action = 'document_linked'", [card.id])).length).toBe(1);
  });

  it('uses a scoped adapter for nested services and keeps unrelated root writes outside the transaction', async () => {
    let resolveStarted!: () => void;
    const txStarted = new Promise<void>(resolve => { resolveStarted = resolve; });
    const transaction = db.transaction(async tx => {
        resolveStarted();
        await tx.transaction(async nested => {
          await nested.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
            'nested-workspace', 'Nested', 'nested', new Date().toISOString(), new Date().toISOString(),
          ]);
        });
        await expect(db.execute(
          'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          ['forbidden-root', 'Forbidden', 'forbidden', new Date().toISOString(), new Date().toISOString()],
        )).rejects.toThrow(/scoped adapter/);
    });
    await txStarted;
    const unrelated = db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['unrelated-workspace', 'Unrelated', 'unrelated', new Date().toISOString(), new Date().toISOString()],
    );
    await unrelated;
    await transaction;
    expect((await db.query('SELECT id FROM workspace WHERE id IN (?, ?)', ['nested-workspace', 'unrelated-workspace'])).length).toBe(2);
  });

  it('runs after-commit callbacks after the FIFO advances and invalidates retained scopes', async () => {
    let retained: DatabaseAdapter | undefined;
    await db.transaction(async tx => {
      retained = tx;
      tx.afterCommit(async () => {
        await db.execute(
          'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          ['after-commit-workspace', 'After commit', 'after-commit', new Date().toISOString(), new Date().toISOString()],
        );
      });
    });
    expect((await db.query('SELECT id FROM workspace WHERE id = ?', ['after-commit-workspace'])).length).toBe(1);
    expect(() => retained!.query('SELECT 1')).toThrow(/no longer active/);
  });

  it('keeps MCP audit atomic, uses result target IDs, and refuses missing db before mutation', async () => {
    const events = new EventService(db);
    const projectService = new ProjectService(db, events);
    const boardService = new BoardService(db, events);
    const columnService = new (await import('../src/services/column.service.js')).ColumnService(db, events);
    const cardService = new CardService(db, events);
    const commentService = new (await import('../src/services/comment.service.js')).CommentService(db, events);
    const documentService = new DocumentService(db, events);
    const agentService = new (await import('../src/services/agent.service.js')).AgentService(db, events);
    const kbService = new KBService(db, events);
    const roleService = new RoleService(db, events);
    const auditService = new AuditService(db);
    await db.execute(
      'INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)',
      ['mcp-audit-actor', 'user', new Date().toISOString()],
    );
    const services = {
      db,
      projectService,
      boardService,
      columnService,
      cardService,
      commentService,
      documentService,
      agentService,
      eventService: events,
      kbService,
      roleService,
      tokenService: {} as TokenService,
      sessionService: {} as Services['sessionService'],
      oidcService: {} as Services['oidcService'],
      invitationService: {} as Services['invitationService'],
      userService: {} as Services['userService'],
      deviceGrantService: {} as Services['deviceGrantService'],
      mcpOAuthService: {} as Services['mcpOAuthService'],
      auditService,
    } satisfies Services;
    const auth: AuthContext = {
      principal: { id: 'mcp-audit-actor', kind: 'user' },
      workspace_id: workspaceId,
      is_workspace_member: true,
      permissions: [],
      is_operator_override: false,
      role_name: null,
    };
    const server = createMcpServer(services, { headers: {} } as any, auth) as any;

    const createdResult = await server._registeredTools.create_role.handler({
      workspace_id: workspaceId,
      key: 'mcp_audited_role',
      name: 'MCP Audited Role',
      permissions: ['kb.read'],
    }, {});
    const created = JSON.parse(createdResult.content[0].text);
    const createdAudit = await db.query<{ action: string; target_id: string }>(
      'SELECT action, target_id FROM audit_log WHERE action = ? AND target_id = ?',
      ['role.create', created.id],
    );
    expect(createdAudit).toHaveLength(1);

    const owner = (await roleService.seedPreset(workspaceId)).find(role => role.key === 'owner')!;
    const cloneResult = await server._registeredTools.clone_role.handler({
      role_id: owner.id,
      new_key: 'mcp_audited_clone',
      new_name: 'MCP Audited Clone',
    }, {});
    const clone = JSON.parse(cloneResult.content[0].text);
    const cloneAudit = await db.query<{ action: string; target_id: string }>(
      'SELECT action, target_id FROM audit_log WHERE action = ? AND target_id = ?',
      ['role.clone', clone.id],
    );
    expect(cloneAudit).toHaveLength(1);

    const project = await projectService.create({ name: 'MCP status audit' });
    const document = await documentService.create({ project_id: project.id, title: 'MCP doc', content: 'draft' });
    await server._registeredTools.set_document_status.handler({ document_id: document.id, status: 'approved' }, {});
    await server._registeredTools.set_document_status.handler({ document_id: document.id, status: 'draft' }, {});
    const documentAudits = await db.query<{ action: string }>(
      'SELECT action FROM audit_log WHERE target_id = ?',
      [document.id],
    );
    expect(documentAudits).toHaveLength(2);
    expect(documentAudits.map(row => row.action)).toEqual(expect.arrayContaining(['document.approve', 'document.status_changed']));

    const beforeRoleCount = (await db.query('SELECT id FROM role WHERE key = ?', ['mcp_missing_db'])).length;
    const noDbServices = { ...services, db: undefined } as Services;
    const noDbServer = createMcpServer(noDbServices, { headers: {} } as any, auth) as any;
    await expect(noDbServer._registeredTools.create_role.handler({
      workspace_id: workspaceId,
      key: 'mcp_missing_db',
      name: 'Must not mutate',
      permissions: ['kb.read'],
    }, {})).rejects.toThrow(/Atomic MCP mutation requires services\.db/);
    expect((await db.query('SELECT id FROM role WHERE key = ?', ['mcp_missing_db'])).length).toBe(beforeRoleCount);
    expect((await db.query("SELECT id FROM audit_log WHERE action = 'role.create' AND payload LIKE '%mcp_missing_db%'")).length).toBe(0);
  });
});
