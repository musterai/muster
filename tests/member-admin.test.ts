// File: tests/member-admin.test.ts
//
// MUS-26 acceptance criteria:
// - demoting/removing the last owner is refused with a clear reason
// - a principal cannot grant a role/permission set it does not itself hold

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { RoleService, UserService } from '../src/services/index.js';
import { assertPermissionsGrantable, PermissionDeniedError } from '../src/shared/permission-enforcer.js';
import { AuthContext } from '../src/shared/auth-context.js';
import { config } from '../src/config/index.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-member-admin.db');

describe('MUS-26: member/role guard rails', () => {
  let db: DatabaseAdapter;
  let roleService: RoleService;
  let userService: UserService;
  let wsId: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    wsId = 'test-ws-member-admin';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [wsId, 'WS', 'ws-admin', now, now]);

    roleService = new RoleService(db);
    userService = new UserService(db);
    await roleService.seedPreset(wsId);
  });

  afterEach(async () => {
    if (db) await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* ok */ }
    }
  });

  async function addMember(id: string, name: string, roleKey: string) {
    const now = new Date().toISOString();
    const role = await roleService.getByKey(wsId, roleKey);
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [id, 'user', now]);
    await db.execute('INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)', [id, name, 'active', now]);
    await userService.addWorkspaceMember(wsId, id, role!.id);
    return role!;
  }

  it('refuses to demote the sole owner', async () => {
    const ownerRole = await addMember('owner-1', 'Owner One', 'owner');
    const observerRole = await roleService.getByKey(wsId, 'observer');

    await expect(userService.changeMemberRole(wsId, 'owner-1', observerRole!.id)).rejects.toThrow('last owner');

    // Role must be unchanged
    const members = await userService.listMembers(wsId);
    expect(members.find(m => m.id === 'owner-1')!.role_id).toBe(ownerRole.id);
  });

  it('allows demoting an owner when a second owner exists', async () => {
    await addMember('owner-1', 'Owner One', 'owner');
    await addMember('owner-2', 'Owner Two', 'owner');
    const observerRole = await roleService.getByKey(wsId, 'observer');

    await expect(userService.changeMemberRole(wsId, 'owner-1', observerRole!.id)).resolves.not.toThrow();
    const members = await userService.listMembers(wsId);
    expect(members.find(m => m.id === 'owner-1')!.role_id).toBe(observerRole!.id);
  });

  it('refuses to remove the sole owner', async () => {
    await addMember('owner-1', 'Owner One', 'owner');
    await expect(userService.removeMember(wsId, 'owner-1')).rejects.toThrow('last owner');
  });

  it('removing a member disables operated agents without deleting attribution rows', async () => {
    await addMember('owner-1', 'Owner One', 'owner');
    const member = await addMember('member-1', 'Member One', 'senior_engineer');

    const now = new Date().toISOString();
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', ['agent-1', 'agent', now]);
    await db.execute(
      'INSERT INTO agent (id, name, status, last_seen_at, role_id, operator_user_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['agent-1', 'Agent One', 'active', now, member.id, 'member-1', wsId, now],
    );

    await userService.removeMember(wsId, 'member-1');

    const agentRows = await db.query<{ operator_user_id: string | null; role_id: string | null; status: string }>(
      'SELECT operator_user_id, role_id, status FROM agent WHERE id = ?',
      ['agent-1'],
    );
    expect(agentRows[0]).toEqual({ operator_user_id: null, role_id: null, status: 'offline' });
    expect(await db.query('SELECT id FROM principal WHERE id = ?', ['member-1'])).toHaveLength(1);
    expect(await db.query('SELECT id FROM app_user WHERE id = ?', ['member-1'])).toHaveLength(1);

    const members = await userService.listMembers(wsId);
    expect(members.find(m => m.id === 'member-1')).toBeUndefined();
  });

  it('assertPermissionsGrantable refuses granting a permission the principal does not hold', async () => {
    const originalMode = config.auth.mode;
    (config.auth as any).mode = 'enforced';
    try {
      const seniorEngineer: AuthContext = {
        principal: { kind: 'user', id: 'u1' },
        workspace_id: wsId,
        permissions: ['card.create', 'card.update'],
        is_operator_override: false,
        role_name: 'senior_engineer',
      };
      expect(() => assertPermissionsGrantable(seniorEngineer, ['doc.approve'])).toThrow(PermissionDeniedError);
      expect(() => assertPermissionsGrantable(seniorEngineer, ['card.create'])).not.toThrow();
    } finally {
      (config.auth as any).mode = originalMode;
    }
  });

  it('assertPermissionsGrantable allows workspace.admin holders to grant anything', async () => {
    const originalMode = config.auth.mode;
    (config.auth as any).mode = 'enforced';
    try {
      const owner: AuthContext = {
        principal: { kind: 'user', id: 'u2' },
        workspace_id: wsId,
        permissions: ['workspace.admin'],
        is_operator_override: true,
        role_name: 'owner',
      };
      expect(() => assertPermissionsGrantable(owner, ['doc.approve', 'role.manage'])).not.toThrow();
    } finally {
      (config.auth as any).mode = originalMode;
    }
  });
});
