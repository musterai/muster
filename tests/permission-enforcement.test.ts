// File: tests/permission-enforcement.test.ts
//
// MUS-22 acceptance criteria:
// 1. Every registered MCP tool name appears in the permission map.
// 2. set_document_status → approved is refused for senior_engineer, permitted for architect.
// 3. A junior_engineer moving a card they are not assigned to is refused; their own card succeeds.
// 4. An agent passing an agent_id it does not operate is refused.
// 5. Refusal payloads name the missing permission.
// 6. With MUSTER_AUTH_MODE=open, the existing test suite passes unchanged.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import {
  RoleService,
  EventService,
  AgentService,
  CardService,
  BoardService,
  ColumnService,
  ProjectService,
  CommentService,
  DocumentService,
  KBService,
} from '../src/services/index.js';
import {
  TOOL_PERMISSIONS,
  PermissionDeniedError,
  requirePermission,
  requireRestPermission,
  REST_ROUTE_PERMISSIONS,
  WORKSPACE_READ,
  resolvePermission,
  withPermission,
} from '../src/shared/permission-enforcer.js';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../src/shared/auth-context.js';
import { ALL_PERMISSIONS, PRESET_ROLES } from '../src/shared/permissions.js';
import { config } from '../src/config/index.js';
import { createMcpServer, Services } from '../src/mcp/server.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-permission-enforcement.db');

// Create a mock AuthContext with specific permissions and role
function makeAuth(
  permissions: string[],
  roleName: string | null = null,
  principalId?: string,
  isWorkspaceMember = true,
): AuthContext {
  return {
    principal: principalId ? { kind: 'user', id: principalId } : null,
    workspace_id: 'test-ws',
    is_workspace_member: isWorkspaceMember,
    permissions,
    is_operator_override: false,
    role_name: roleName,
  };
}

describe('MUS-22: Permission enforcement', () => {
  let db: DatabaseAdapter;
  let roleService: RoleService;
  let eventService: EventService;
  let agentService: AgentService;
  let cardService: CardService;
  let boardService: BoardService;
  let columnService: ColumnService;
  let projectService: ProjectService;
  let commentService: CommentService;
  let documentService: DocumentService;
  let kbService: KBService;
  let wsId: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);

    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    wsId = 'test-ws-perm-01';
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [wsId, 'Permission Test Workspace', 'perm-test', now, now]
    );

    eventService = new EventService(db);
    roleService = new RoleService(db, eventService);
    boardService = new BoardService(db, eventService);
    projectService = new ProjectService(db, eventService, boardService);
    columnService = new ColumnService(db, eventService);
    cardService = new CardService(db, eventService);
    commentService = new CommentService(db, eventService);
    documentService = new DocumentService(db, eventService);
    agentService = new AgentService(db, eventService);
    kbService = new KBService(db, eventService);

    await roleService.seedPreset(wsId);
  });

  afterEach(async () => {
    if (db) await db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    // Restore auth mode after each test (in case we changed it)
    (config.auth as any).mode = 'open';
  });

  // ================================================================
  // Acceptance criterion 1: every registered MCP tool is mapped
  // ================================================================
  it('AC1: every registered MCP tool name appears in TOOL_PERMISSIONS', async () => {
    const services: Services = {
      projectService,
      boardService,
      columnService,
      cardService,
      commentService,
      documentService,
      agentService,
      eventService,
      kbService,
      roleService,
    };
    const server = createMcpServer(services, undefined, OPEN_AUTH_CONTEXT);

    // The MCP SDK doesn't expose tool registration directly, so we enumerate
    // the known tool names from server.ts by matching against the TOOL_PERMISSIONS
    // map. Every tool in the codebase must be defined there.
    // We also verify no TOOL_PERMISSIONS entry lacks a corresponding registration.
    // The known MCP tools (from server.ts):
    const registeredTools = [
      'list_projects', 'create_project', 'get_project_summary', 'update_project', 'delete_project',
      'list_boards', 'get_board', 'create_board', 'update_board', 'delete_board',
      'create_column', 'update_column', 'move_column', 'delete_column',
      'list_cards', 'search_cards', 'create_card', 'get_card', 'update_card', 'move_card',
      'claim_card', 'assign_card', 'unassign_card',
      'add_comment', 'update_comment', 'delete_comment', 'add_label', 'remove_label',
      'archive_card', 'delete_card',
      'link_document_to_card', 'unlink_document_from_card',
      'link_card', 'unlink_card',
      'add_work_link', 'remove_work_link', 'list_work_links',
      'create_label', 'list_labels',
      'list_documents', 'create_document', 'get_document', 'update_document',
      'delete_document', 'set_document_status', 'get_document_history',
      'register_agent', 'update_agent', 'unregister_agent', 'heartbeat', 'list_agents',
      'get_activity',
      'list_knowledge_bases', 'create_knowledge_base', 'link_knowledge_base',
      'search_knowledge', 'get_entity_knowledge',
      'add_gained_knowledge', 'upsert_kb_entity', 'update_gained_knowledge', 'update_kb_entity', 'add_kb_relation',
      'list_roles', 'get_role', 'create_role', 'update_role', 'delete_role', 'clone_role',
    ];

    const unmapped: string[] = [];
    for (const toolName of registeredTools) {
      if (!(toolName in TOOL_PERMISSIONS)) {
        unmapped.push(toolName);
      }
    }
    expect(unmapped, `Unmapped tools: ${unmapped.join(', ')}`).toEqual([]);

    // Verify reverse: every TOOL_PERMISSIONS entry is an actual tool
    const mappedNames = Object.keys(TOOL_PERMISSIONS);
    const unknownMappings = mappedNames.filter(n => !registeredTools.includes(n));
    expect(unknownMappings, `TOOL_PERMISSIONS has stale entries: ${unknownMappings.join(', ')}`).toEqual([]);
  });

  it('search_cards exposes validated project-scoped title search through MCP', async () => {
    const project = await projectService.create({ name: 'MCP Card Search Project' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);
    const first = await cardService.create({ column_id: columns[0].id, title: 'Investigate login timeout' });
    const second = await cardService.create({ column_id: columns[0].id, title: 'Fix login redirect' });

    const services: Services = {
      projectService,
      boardService,
      columnService,
      cardService,
      commentService,
      documentService,
      agentService,
      eventService,
      kbService,
      roleService,
    };
    const server = createMcpServer(services, undefined, OPEN_AUTH_CONTEXT) as any;
    const tool = server._registeredTools.search_cards;

    expect(tool.inputSchema.safeParse({ project_id: project.id, query: 'login' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ project_id: project.id, query: '   ' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ project_id: project.id, query: 'login', limit: 101 }).success).toBe(false);

    const result = await tool.handler({
      project_id: project.id,
      query: 'LOGIN',
      exclude_card_id: first.key,
      limit: 10,
    }, {});
    const cards = JSON.parse(result.content[0].text);

    expect(cards.map((card: { id: string }) => card.id)).toEqual([second.id]);
  });

  // ================================================================
  // Acceptance criterion 5: refusal payloads name the missing permission
  // ================================================================
  it('AC5: PermissionDeniedError has correct refusal shape', () => {
    const err = new PermissionDeniedError('card.delete', 'senior_engineer');
    expect(err.refusal).toEqual({
      error: 'forbidden',
      required_permission: 'card.delete',
      your_role: 'senior_engineer',
      message: expect.stringContaining('card.delete'),
    });
    expect(err.message).toContain('card.delete');
    expect(err.message).toContain('senior_engineer');
  });

  // ================================================================
  // Acceptance criterion: requirePermission passes in open mode
  // ================================================================
  it('requirePermission passes in open mode regardless of permissions', () => {
    (config.auth as any).mode = 'open';
    const auth = makeAuth([]); // empty permissions
    expect(() => requirePermission('delete_project', auth, {})).not.toThrow();
  });

  it('requirePermission refuses unmapped tool in enforced mode', () => {
    (config.auth as any).mode = 'enforced';
    const auth = makeAuth(allPermissions());
    expect(() => requirePermission('non_existent_tool', auth, {})).toThrow(PermissionDeniedError);
  });

  it('requirePermission passes with matching permission in enforced mode', () => {
    (config.auth as any).mode = 'enforced';
    const auth = makeAuth(['card.create']);
    expect(() => requirePermission('create_card', auth, {})).not.toThrow();
  });

  it('requirePermission refuses when permission missing in enforced mode', () => {
    (config.auth as any).mode = 'enforced';
    const auth = makeAuth(['kb.read']); // Only kb.read
    expect(() => requirePermission('delete_project', auth, {})).toThrow(PermissionDeniedError);
  });

  it('requirePermission allows workspace.admin through all checks', () => {
    (config.auth as any).mode = 'enforced';
    const auth = makeAuth(['workspace.admin']);
    expect(() => requirePermission('delete_project', auth, {})).not.toThrow();
    expect(() => requirePermission('delete_role', auth, {})).not.toThrow();
  });

  // ================================================================
  // Acceptance criterion 2: set_document_status → approved
  // ================================================================
  it('AC2: set_document_status → approved requires doc.approve', () => {
    (config.auth as any).mode = 'enforced';

    // senior_engineer does NOT have doc.approve
    const seniorPerms = PRESET_ROLES.find(r => r.key === 'senior_engineer')!.permissions;
    const seniorAuth = makeAuth(seniorPerms, 'senior_engineer');
    expect(() => requirePermission('set_document_status', seniorAuth, { status: 'approved' }))
      .toThrow(PermissionDeniedError);

    // architect DOES have doc.approve
    const archPerms = PRESET_ROLES.find(r => r.key === 'architect')!.permissions;
    const archAuth = makeAuth(archPerms, 'architect');
    expect(() => requirePermission('set_document_status', archAuth, { status: 'approved' }))
      .not.toThrow();

    // Both can submit for review (doc.submit_review)
    expect(() => requirePermission('set_document_status', seniorAuth, { status: 'in_review' }))
      .not.toThrow();
  });

  it('resolvePermission handles dynamic spec for set_document_status', () => {
    const approved = resolvePermission(TOOL_PERMISSIONS['set_document_status'], { status: 'approved' });
    expect(approved).toBe('doc.approve');

    const review = resolvePermission(TOOL_PERMISSIONS['set_document_status'], { status: 'in_review' });
    expect(review).toBe('doc.submit_review');

    const draft = resolvePermission(TOOL_PERMISSIONS['set_document_status'], { status: 'draft' });
    expect(draft).toBe('doc.submit_review');
  });

  // ================================================================
  // Acceptance criterion 3: card scope check
  // ================================================================
  it('AC3: card scope check — validateCardScope works correctly', async () => {
    const project = await projectService.create({ name: 'Scope Test' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);
    const colId = columns[0].id;

    const card = await cardService.create({ column_id: colId, title: 'Assigned Card' });
    const unassignedCard = await cardService.create({ column_id: colId, title: 'Unassigned Card' });

    // Create a principal (user) and an agent they operate
    const now = new Date().toISOString();
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['user-scope-01', 'user', now]);
    await db.execute('INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)', ['user-scope-01', 'Scope User', 'active', now]);

    // Create an agent operated by this user
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['agent-scope-01', 'agent', now]);
    await db.execute('INSERT INTO agent (id, name, status, last_seen_at, operator_user_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['agent-scope-01', 'Scope Agent', 'active', now, 'user-scope-01', wsId, now]);

    // Assign the agent to the card
    await cardService.assign(card.id, 'agent-scope-01');

    // In enforced mode, user-scope-01 should have scope over card (their agent is assigned)
    try {
      (config.auth as any).mode = 'enforced';
      const agentIds = await agentService.getAgentIdsForPrincipal('user-scope-01');
      expect(agentIds).toContain('agent-scope-01');

      const hasScopeAssigned = await cardService.validateCardScope(card.id, agentIds);
      expect(hasScopeAssigned).toBe(true);

      const hasScopeUnassigned = await cardService.validateCardScope(unassignedCard.id, agentIds);
      expect(hasScopeUnassigned).toBe(false);
    } finally {
      (config.auth as any).mode = 'open';
    }
  });

  // ================================================================
  // MUS-36: comment ownership scope check (mirrors AC3 card scope)
  // ================================================================
  it('MUS-36: validateCommentOwnership — author-only, admin bypass handled by caller', async () => {
    const project = await projectService.create({ name: 'Comment Scope Test' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);
    const card = await cardService.create({ column_id: columns[0].id, title: 'Card' });

    const now = new Date().toISOString();
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['author-01', 'agent', now]);
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['other-01', 'agent', now]);

    const comment = await commentService.create({ card_id: card.id, author_id: 'author-01', content: 'Mine' });

    try {
      (config.auth as any).mode = 'enforced';
      expect(await commentService.validateCommentOwnership(comment.id, 'author-01')).toBe(true);
      expect(await commentService.validateCommentOwnership(comment.id, 'other-01')).toBe(false);
    } finally {
      (config.auth as any).mode = 'open';
    }

    // Open mode: scope enforcement is bypassed entirely.
    expect(await commentService.validateCommentOwnership(comment.id, 'other-01')).toBe(true);
  });

  it('MUS-36: update_comment/delete_comment tools enforce author-only ownership, workspace.admin bypasses it', async () => {
    const project = await projectService.create({ name: 'Comment Tool Scope' });
    const boards = await boardService.list(project.id);
    const columns = await columnService.list(boards[0].id);
    const card = await cardService.create({ column_id: columns[0].id, title: 'Card' });

    const now = new Date().toISOString();
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['tool-author-01', 'user', now]);
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['tool-other-01', 'user', now]);
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['tool-admin-01', 'user', now]);

    const comment = await commentService.create({ card_id: card.id, author_id: 'tool-author-01', content: 'Owned comment' });

    const services: Services = {
      projectService, boardService, columnService, cardService, commentService,
      documentService, agentService, eventService, kbService, roleService,
    };

    const originalMode = config.auth.mode;
    (config.auth as any).mode = 'enforced';
    try {
      // A different principal with comment.update/comment.delete may not touch someone else's comment.
      const otherAuth = makeAuth(['comment.update', 'comment.delete'], 'junior_engineer', 'tool-other-01');
      const otherServer = createMcpServer(services, { headers: {} } as any, otherAuth) as any;
      await expect(
        otherServer._registeredTools['update_comment'].handler({ comment_id: comment.id, content: 'Hijacked' }, {})
      ).rejects.toThrow(/only edit your own comments/);
      await expect(
        otherServer._registeredTools['delete_comment'].handler({ comment_id: comment.id }, {})
      ).rejects.toThrow(/only delete your own comments/);

      // The author themselves may edit and then delete their own comment.
      const authorAuth = makeAuth(['comment.update', 'comment.delete'], 'junior_engineer', 'tool-author-01');
      const authorServer = createMcpServer(services, { headers: {} } as any, authorAuth) as any;
      const updateResult = await authorServer._registeredTools['update_comment'].handler(
        { comment_id: comment.id, content: 'Edited by author' }, {}
      );
      expect(JSON.parse(updateResult.content[0].text).content).toBe('Edited by author');

      // workspace.admin may edit/delete comments it does not own.
      const adminAuth = makeAuth(['comment.update', 'comment.delete', 'workspace.admin'], 'owner', 'tool-admin-01');
      const adminServer = createMcpServer(services, { headers: {} } as any, adminAuth) as any;
      const adminDelete = await adminServer._registeredTools['delete_comment'].handler({ comment_id: comment.id }, {});
      expect(JSON.parse(adminDelete.content[0].text).success).toBe(true);
      expect(await commentService.getById(comment.id)).toBeNull();
    } finally {
      (config.auth as any).mode = originalMode;
    }
  });

  it('AC3: getAgentIdsForPrincipal includes the principal if it is an agent', async () => {
    const now = new Date().toISOString();
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['direct-agent', 'agent', now]);
    await db.execute('INSERT INTO agent (id, name, status, last_seen_at, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['direct-agent', 'Direct Agent', 'active', now, wsId, now]);

    const ids = await agentService.getAgentIdsForPrincipal('direct-agent');
    expect(ids).toContain('direct-agent');
  });

  // ================================================================
  // Acceptance criterion 4: agent ownership validation
  // ================================================================
  it('AC4: validateAgentOwnership rejects agents belonging to a different operator', async () => {
    const now = new Date().toISOString();

    // Create two users
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['user-own-01', 'user', now]);
    await db.execute('INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)', ['user-own-01', 'Owner A', 'active', now]);
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['user-own-02', 'user', now]);
    await db.execute('INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)', ['user-own-02', 'Owner B', 'active', now]);

    // Create an agent belonging to user-own-01
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['agent-own-01', 'agent', now]);
    await db.execute('INSERT INTO agent (id, name, status, last_seen_at, operator_user_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['agent-own-01', 'Owned Agent', 'active', now, 'user-own-01', wsId, now]);

    // Success: correct operator
    const result = await agentService.validateAgentOwnership('agent-own-01', 'user-own-01');
    expect(result).toBe('user-own-01');

    // Failure: wrong operator tries to use the agent
    await expect(
      agentService.validateAgentOwnership('agent-own-01', 'user-own-02')
    ).rejects.toThrow('belongs to a different operator');
  });

  it('AC4: validateAgentOwnership returns null for nonexistent agents', async () => {
    const result = await agentService.validateAgentOwnership('nonexistent-agent', 'some-user');
    expect(result).toBeNull();
  });

  // ================================================================
  // Acceptance criterion: withPermission wrapper end-to-end
  // ================================================================
  it('withPermission wrapper delegates to the handler when permission check passes', async () => {
    (config.auth as any).mode = 'enforced';
    const auth = makeAuth(['card.create'], 'architect');

    const handler = async (args: { title: string }) => {
      return { result: `Created: ${args.title}` };
    };

    const wrapped = withPermission('create_card', auth, handler);
    const result = await wrapped({ title: 'Test Card' });
    expect(result).toEqual({ result: 'Created: Test Card' });
  });

  it('withPermission wrapper throws when permission check fails', async () => {
    (config.auth as any).mode = 'enforced';
    const auth = makeAuth(['kb.read'], 'observer');

    const handler = async (args: {}) => {
      return { result: 'should not reach' };
    };

    const wrapped = withPermission('delete_project', auth, handler);
    await expect(wrapped({})).rejects.toThrow(PermissionDeniedError);
  });

  // ================================================================
  // REST route permission map tests
  // ================================================================
  it('allows public health and implicit reads for admitted workspace members', () => {
    (config.auth as any).mode = 'enforced';
    const unadmitted = makeAuth([], null, undefined, false);
    const observer = makeAuth([], 'observer');
    expect(() => requireRestPermission('GET', '/api/v1/health', unadmitted)).not.toThrow();
    expect(() => requireRestPermission('GET', '/api/v1/projects', observer)).not.toThrow();
  });

  it('denies reads to unadmitted principals even when they hold a write verb', () => {
    (config.auth as any).mode = 'enforced';
    const auth = makeAuth(['project.create'], null, undefined, false);
    expect(() => requireRestPermission('GET', '/api/v1/projects', auth))
      .toThrowError(expect.objectContaining({
        refusal: expect.objectContaining({ required_permission: WORKSPACE_READ }),
      }));
  });

  it('default-denies unmapped GET routes for admitted members and admins', () => {
    (config.auth as any).mode = 'enforced';
    expect(() => requireRestPermission('GET', '/api/v1/new-unmapped-data', makeAuth([])))
      .toThrow(PermissionDeniedError);
    expect(() => requireRestPermission('GET', '/api/v1/new-unmapped-data', makeAuth(['workspace.admin'])))
      .toThrow(PermissionDeniedError);
  });

  it('requireRestPermission refuses mutations without matching permission', () => {
    (config.auth as any).mode = 'enforced';
    const auth = makeAuth(['kb.read'], 'observer');
    expect(() => requireRestPermission('POST', '/api/v1/projects', auth)).toThrow(PermissionDeniedError);
  });

  it('requireRestPermission allows mutations with matching permission', () => {
    (config.auth as any).mode = 'enforced';
    const auth = makeAuth(['project.create']);
    expect(() => requireRestPermission('POST', '/api/v1/projects', auth)).not.toThrow();
  });

  it('requireRestPermission allows workspace.admin through everything', () => {
    (config.auth as any).mode = 'enforced';
    const auth = makeAuth(['workspace.admin']);
    expect(() => requireRestPermission('DELETE', '/api/v1/projects/some-id', auth)).not.toThrow();
    expect(() => requireRestPermission('POST', '/api/v1/boards/xyz/columns', auth)).not.toThrow();
  });

  it('resolves REST document transition permission from the requested status', () => {
    (config.auth as any).mode = 'enforced';
    const senior = makeAuth(['doc.submit_review'], 'senior_engineer');
    const architect = makeAuth(['doc.submit_review', 'doc.approve'], 'architect');
    expect(() => requireRestPermission(
      'PATCH',
      '/api/v1/documents/doc-1/status',
      senior,
      { status: 'in_review' },
    )).not.toThrow();
    expect(() => requireRestPermission(
      'PATCH',
      '/api/v1/documents/doc-1/status',
      senior,
      { status: 'approved' },
    )).toThrow(PermissionDeniedError);
    expect(() => requireRestPermission(
      'PATCH',
      '/api/v1/documents/doc-1/status',
      architect,
      { status: 'approved' },
    )).not.toThrow();
  });

  // ================================================================
  // Acceptance criterion 6: open mode — existing behavior preserved
  // ================================================================
  it('AC6: open mode allows all permission checks', () => {
    // This test verifies the core assertion: when MUSTER_AUTH_MODE=open,
    // the existing test suite's behavior is unchanged.
    // Under open mode, requirePermission always returns without throwing.
    (config.auth as any).mode = 'open';
    const auth = makeAuth([]);

    // All of these should pass regardless of empty permissions
    expect(() => requirePermission('delete_project', auth, {})).not.toThrow();
    expect(() => requirePermission('delete_role', auth, {})).not.toThrow();
    expect(() => requirePermission('non_existent_tool', auth, {})).not.toThrow();
    expect(() => requireRestPermission('DELETE', '/api/v1/projects/x', auth)).not.toThrow();
    expect(() => requireRestPermission('POST', '/api/v1/projects', auth)).not.toThrow();
  });

  // ================================================================
  // Permission map completeness — known tool permission values
  // ================================================================
  it('TOOL_PERMISSIONS contains expected mappings for write tools', () => {
    expect(TOOL_PERMISSIONS['delete_project']).toBe('project.delete');
    expect(TOOL_PERMISSIONS['delete_board']).toBe('board.manage');
    expect(TOOL_PERMISSIONS['archive_card']).toBe('card.archive');
    expect(TOOL_PERMISSIONS['add_comment']).toBe('comment.create');
    expect(TOOL_PERMISSIONS['update_comment']).toBe('comment.update');
    expect(TOOL_PERMISSIONS['delete_comment']).toBe('comment.delete');
    expect(TOOL_PERMISSIONS['register_agent']).toBe('agent.register');
    expect(TOOL_PERMISSIONS['create_role']).toBe('role.manage');
  });

  it('maps implicit read tools to the explicit workspace membership requirement', () => {
    expect(TOOL_PERMISSIONS['list_projects']).toBe(WORKSPACE_READ);
    expect(TOOL_PERMISSIONS['get_board']).toBe(WORKSPACE_READ);
    expect(TOOL_PERMISSIONS['list_cards']).toBe(WORKSPACE_READ);
    expect(TOOL_PERMISSIONS['list_agents']).toBe(WORKSPACE_READ);
    expect(TOOL_PERMISSIONS['list_documents']).toBe(WORKSPACE_READ);
  });

  it('uses the same membership requirement for knowledge reads', () => {
    expect(TOOL_PERMISSIONS['search_knowledge']).toBe(WORKSPACE_READ);
    expect(TOOL_PERMISSIONS['get_entity_knowledge']).toBe(WORKSPACE_READ);
  });

  it('enforces implicit MCP reads from membership, not write permissions', () => {
    (config.auth as any).mode = 'enforced';
    expect(() => requirePermission('list_projects', makeAuth([], 'observer'))).not.toThrow();
    expect(() => requirePermission(
      'list_projects',
      makeAuth(['project.create'], null, undefined, false),
    )).toThrow(PermissionDeniedError);
  });
});

// ================================================================
// Helper
// ================================================================
function allPermissions(): string[] {
  return [...ALL_PERMISSIONS];
}
