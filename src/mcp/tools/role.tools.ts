import { z } from 'zod';
import type { RoleService } from '../../services/role.service.js';
import { withPermission } from '../../shared/permission-enforcer.js';
import { withMutationAudit, type McpToolContext } from '../tool-context.js';

export function registerRoleTools({ server, services, auth }: McpToolContext): void {
  // --- Role Management Tools ---
  server.tool('list_roles', { workspace_id: z.string() }, withPermission('list_roles', auth, async ({ workspace_id }) => {
    const roles = await services.roleService.list(workspace_id, auth);
    return { content: [{ type: 'text', text: JSON.stringify(roles, null, 2) }] };
  }));

  server.tool('get_role', { role_id: z.string() }, withPermission('get_role', auth, async ({ role_id }) => {
    const role = await services.roleService.getById(role_id, auth);
    if (!role) throw new Error(`Role ${role_id} not found`);
    return { content: [{ type: 'text', text: JSON.stringify(role, null, 2) }] };
  }));

  server.tool('create_role', {
    workspace_id: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string().optional(),
    permissions: z.array(z.string()),
    rank: z.number().optional(),
  }, withPermission('create_role', auth, async (args) => {
    const role = await withMutationAudit(services, auth, (role: Awaited<ReturnType<RoleService['create']>>) => ({
      action: 'role.create',
      target_type: 'role',
      target_id: role.id,
      payload: { workspace_id: args.workspace_id, key: role.key, name: role.name },
    }), tx => services.roleService.create(args, tx, auth));
    return { content: [{ type: 'text', text: JSON.stringify(role, null, 2) }] };
  }));

  server.tool('update_role', {
    role_id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    permissions: z.array(z.string()).optional(),
    rank: z.number().optional(),
  }, withPermission('update_role', auth, async ({ role_id, ...data }) => {
    const role = await withMutationAudit(services, auth, {
      action: 'role.update',
      target_type: 'role',
      target_id: role_id,
      payload: data,
    }, tx => services.roleService.update(role_id, data, tx, auth));
    return { content: [{ type: 'text', text: JSON.stringify(role, null, 2) }] };
  }));

  server.tool('delete_role', { role_id: z.string() }, withPermission('delete_role', auth, async ({ role_id }) => {
    await withMutationAudit(services, auth, {
      action: 'role.delete',
      target_type: 'role',
      target_id: role_id,
    }, tx => services.roleService.delete(role_id, tx, auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Role ${role_id} deleted` }) }] };
  }));

  server.tool('clone_role', {
    role_id: z.string(),
    new_key: z.string(),
    new_name: z.string().optional(),
  }, withPermission('clone_role', auth, async ({ role_id, new_key, new_name }) => {
    const role = await withMutationAudit(services, auth, (role: Awaited<ReturnType<RoleService['clone']>>) => ({
      action: 'role.clone',
      target_type: 'role',
      target_id: role.id,
      payload: { from: role_id, key: role.key, name: role.name },
    }), tx => services.roleService.clone(role_id, new_key, new_name, tx, auth));
    return { content: [{ type: 'text', text: JSON.stringify(role, null, 2) }] };
  }));
}

