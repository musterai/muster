import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { AgentService } from '../src/services/agent.service.js';
import { RoleService } from '../src/services/role.service.js';
import { SessionService } from '../src/services/session.service.js';
import { TokenService } from '../src/services/token.service.js';
import { UserService } from '../src/services/user.service.js';

describe('MUS-57: fail-closed agent lifecycle and atomic offboarding', () => {
  let db: DatabaseAdapter;
  let tempDir: string;
  let roleService: RoleService;
  let userService: UserService;
  let agentService: AgentService;
  let tokenService: TokenService;
  let sessionService: SessionService;
  const workspaceId = 'lifecycle-workspace';
  const otherWorkspaceId = 'other-workspace';
  const ownerId = 'lifecycle-owner';
  const memberId = 'lifecycle-member';
  const agentId = 'lifecycle-agent';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-agent-lifecycle-'));
    db = createDatabaseAdapter(path.join(tempDir, 'muster.db'));
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    roleService = new RoleService(db);
    userService = new UserService(db);
    agentService = new AgentService(db);
    tokenService = new TokenService(db);
    sessionService = new SessionService(db);

    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Lifecycle Workspace', 'lifecycle', now, now],
    );
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [otherWorkspaceId, 'Other Workspace', 'other', now, now],
    );
    await roleService.seedPreset(workspaceId);
    await roleService.seedPreset(otherWorkspaceId);
    await addUser(ownerId, 'Owner', 'owner', workspaceId);
    await addUser(memberId, 'Member', 'senior_engineer', workspaceId);
    await seedAgent();
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function addUser(id: string, name: string, roleKey: string, targetWorkspace: string): Promise<void> {
    const now = new Date().toISOString();
    const role = await roleService.getByKey(targetWorkspace, roleKey);
    await db.execute('INSERT OR IGNORE INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [id, 'user', now]);
    await db.execute(
      'INSERT OR IGNORE INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)',
      [id, name, 'active', now],
    );
    await db.execute(
      'INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)',
      [targetWorkspace, id, role!.id, now],
    );
  }

  async function seedAgent(): Promise<void> {
    const now = new Date().toISOString();
    const role = await roleService.getByKey(workspaceId, 'junior_engineer');
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [agentId, 'agent', now]);
    await db.execute(
      `INSERT INTO agent
       (id, name, capabilities, status, last_seen_at, operator_user_id, role_id, workspace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Lifecycle Agent', '["code"]', 'active', now, memberId, role!.id, workspaceId, now],
    );
  }

  async function seedClaimAndAttribution(): Promise<{ cardId: string; commentId: string }> {
    const now = new Date().toISOString();
    const cardId = 'lifecycle-card';
    const commentId = 'lifecycle-comment';
    await db.execute(
      `INSERT INTO project (id, workspace_id, name, slug, key_prefix, card_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['lifecycle-project', workspaceId, 'Lifecycle Project', 'lifecycle-project', 'LIF', 1, now, now],
    );
    await db.execute(
      'INSERT INTO board (id, project_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['lifecycle-board', 'lifecycle-project', 'Board', 'board', now, now],
    );
    await db.execute(
      'INSERT INTO "column" (id, board_id, name, position, wip_limit, is_terminal) VALUES (?, ?, ?, ?, ?, ?)',
      ['lifecycle-column', 'lifecycle-board', 'In Progress', 'a', null, 0],
    );
    await db.execute(
      `INSERT INTO card
       (id, key, column_id, title, position, priority, created_at, updated_at, claimed_by, claimed_at, claim_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cardId, 'LIF-1', 'lifecycle-column', 'Claimed card', 'a', 'medium', now, now, agentId, now, new Date(Date.now() + 60_000).toISOString()],
    );
    await db.execute(
      'INSERT INTO comment (id, card_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [commentId, cardId, agentId, 'Historical agent comment', now],
    );
    await db.execute(
      `INSERT INTO event (id, project_id, entity_type, entity_id, action, actor_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['lifecycle-event', 'lifecycle-project', 'card', cardId, 'commented', agentId, '{}', now],
    );
    return { cardId, commentId };
  }

  async function seedCredentials(): Promise<{
    memberToken: Awaited<ReturnType<TokenService['create']>>;
    agentToken: Awaited<ReturnType<TokenService['create']>>;
    sessionToken: string;
  }> {
    const memberToken = await tokenService.create({
      principal_id: memberId,
      workspace_id: workspaceId,
      name: 'member token',
    });
    const agentToken = await tokenService.create({
      principal_id: agentId,
      workspace_id: workspaceId,
      name: 'agent token',
    });
    const session = await sessionService.create(memberId);
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    await db.execute(
      `INSERT INTO device_grant
       (id, device_code_hash, user_code, status, principal_id, workspace_id, interval_seconds, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['lifecycle-device', 'lifecycle-device-hash', 'LIFE-CODE', 'approved', agentId, workspaceId, 5, future, now],
    );
    await db.execute(
      `INSERT INTO oauth_client (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['lifecycle-client', 'Lifecycle Client', '["http://localhost/callback"]', 'none', now],
    );
    await db.execute(
      `INSERT INTO oauth_authorization_code
       (code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, resource,
        agent_principal_id, operator_user_id, workspace_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['lifecycle-code-hash', 'lifecycle-client', 'http://localhost/callback', 'challenge', 'S256', 'muster', agentId, memberId, workspaceId, future, now],
    );
    await db.execute(
      `INSERT INTO oauth_refresh_token
       (token_hash, family_id, client_id, agent_principal_id, workspace_id, resource,
        current_api_token_id, used, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['lifecycle-refresh-hash', 'lifecycle-family', 'lifecycle-client', agentId, workspaceId, 'muster', agentToken.id, 0, 0, now],
    );
    return { memberToken, agentToken, sessionToken: session.token };
  }

  it('gives orphaned, removed, and cross-workspace agents zero effective permissions', async () => {
    expect(await roleService.getEffectivePermissions(agentId, workspaceId)).not.toEqual([]);
    expect(await roleService.getEffectivePermissions(agentId, otherWorkspaceId)).toEqual([]);

    await db.execute('DELETE FROM workspace_member WHERE workspace_id = ? AND user_id = ?', [workspaceId, memberId]);
    expect(await roleService.getEffectivePermissions(agentId, workspaceId)).toEqual([]);

    const role = await roleService.getByKey(workspaceId, 'junior_engineer');
    await db.execute('UPDATE agent SET operator_user_id = NULL, role_id = ? WHERE id = ?', [role!.id, agentId]);
    expect(await roleService.getEffectivePermissions(agentId, workspaceId)).toEqual([]);
  });

  it('atomically offboards a member, revokes credentials, releases claims, and preserves attribution', async () => {
    const { cardId, commentId } = await seedClaimAndAttribution();
    const credentials = await seedCredentials();

    await userService.removeMember(workspaceId, memberId);

    expect(await userService.isWorkspaceMember(workspaceId, memberId)).toBe(false);
    expect(await tokenService.verify(credentials.memberToken.token)).toBeNull();
    expect(await tokenService.verify(credentials.agentToken.token)).toBeNull();
    expect(await sessionService.verify(credentials.sessionToken)).toBeNull();
    expect(await db.query('SELECT id FROM device_grant WHERE id = ?', ['lifecycle-device'])).toEqual([]);
    expect(await db.query('SELECT code_hash FROM oauth_authorization_code WHERE code_hash = ?', ['lifecycle-code-hash'])).toEqual([]);
    expect(await db.query<{ revoked: number }>('SELECT revoked FROM oauth_refresh_token WHERE token_hash = ?', ['lifecycle-refresh-hash']))
      .toEqual([{ revoked: 1 }]);
    expect(await db.query('SELECT claimed_by FROM card WHERE id = ?', [cardId])).toEqual([{ claimed_by: null }]);
    expect(await db.query('SELECT id, author_id FROM comment WHERE id = ?', [commentId]))
      .toEqual([{ id: commentId, author_id: agentId }]);
    expect(await db.query('SELECT id, actor_id FROM event WHERE id = ?', ['lifecycle-event']))
      .toEqual([{ id: 'lifecycle-event', actor_id: agentId }]);
    expect(await db.query('SELECT id FROM principal WHERE id IN (?, ?) ORDER BY id', [agentId, memberId]))
      .toHaveLength(2);
    expect(await db.query('SELECT status, operator_user_id, role_id FROM agent WHERE id = ?', [agentId]))
      .toEqual([{ status: 'offline', operator_user_id: null, role_id: null }]);
  });

  it('rolls back every offboarding mutation when a later lifecycle write fails', async () => {
    const { cardId } = await seedClaimAndAttribution();
    const credentials = await seedCredentials();
    const originalExecute = db.execute.bind(db);
    (db as DatabaseAdapter).execute = async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE agent')) throw new Error('injected agent-disable failure');
      return originalExecute(sql, params);
    };

    await expect(userService.removeMember(workspaceId, memberId)).rejects.toThrow('injected agent-disable failure');
    (db as DatabaseAdapter).execute = originalExecute;

    expect(await userService.isWorkspaceMember(workspaceId, memberId)).toBe(true);
    expect(await tokenService.verify(credentials.memberToken.token)).not.toBeNull();
    expect(await tokenService.verify(credentials.agentToken.token)).not.toBeNull();
    expect(await sessionService.verify(credentials.sessionToken)).not.toBeNull();
    expect(await db.query('SELECT claimed_by FROM card WHERE id = ?', [cardId])).toEqual([{ claimed_by: agentId }]);
    expect(await db.query('SELECT status, operator_user_id FROM agent WHERE id = ?', [agentId]))
      .toEqual([{ status: 'active', operator_user_id: memberId }]);
  });

  it('rejects cross-workspace roles and rotates credentials after a valid member role change', async () => {
    const credentials = await seedCredentials();
    const crossWorkspaceRole = await roleService.getByKey(otherWorkspaceId, 'observer');
    await expect(userService.changeMemberRole(workspaceId, memberId, crossWorkspaceRole!.id))
      .rejects.toThrow('does not belong to this workspace');
    expect(await tokenService.verify(credentials.memberToken.token)).not.toBeNull();

    const observer = await roleService.getByKey(workspaceId, 'observer');
    await userService.changeMemberRole(workspaceId, memberId, observer!.id);
    expect(await tokenService.verify(credentials.memberToken.token)).toBeNull();
    expect(await tokenService.verify(credentials.agentToken.token)).toBeNull();
    expect(await sessionService.verify(credentials.sessionToken)).toBeNull();
    expect(await roleService.getEffectivePermissions(agentId, workspaceId)).toEqual(['kb.read']);
  });

  it('guards agent identity changes, validates workspace targets, and preserves history on unregister', async () => {
    const { cardId, commentId } = await seedClaimAndAttribution();
    const { agentToken } = await seedCredentials();
    const observer = await roleService.getByKey(workspaceId, 'observer');
    const otherRole = await roleService.getByKey(otherWorkspaceId, 'observer');

    await expect(agentService.update(agentId, { role_id: observer!.id }))
      .rejects.toThrow('administrator authority');
    await expect(agentService.update(agentId, { role_id: otherRole!.id }, {
      workspaceId,
      allowIdentityChanges: true,
    })).rejects.toThrow('does not belong to the agent workspace');

    await agentService.update(agentId, { role_id: observer!.id }, {
      workspaceId,
      allowIdentityChanges: true,
    });
    expect(await tokenService.verify(agentToken.token)).toBeNull();

    const replacement = await tokenService.create({
      principal_id: agentId,
      workspace_id: workspaceId,
      name: 'replacement',
    });
    await agentService.unregister(agentId);
    expect(await tokenService.verify(replacement.token)).toBeNull();
    expect(await db.query('SELECT claimed_by FROM card WHERE id = ?', [cardId])).toEqual([{ claimed_by: null }]);
    expect(await db.query('SELECT id, author_id FROM comment WHERE id = ?', [commentId]))
      .toEqual([{ id: commentId, author_id: agentId }]);
    expect(await db.query('SELECT id FROM principal WHERE id = ?', [agentId])).toHaveLength(1);
    expect(await roleService.getEffectivePermissions(agentId, workspaceId)).toEqual([]);
  });
});
