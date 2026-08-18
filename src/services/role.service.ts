// File: src/services/role.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Role, CreateRole, UpdateRole } from '../shared/types.js';
import { PRESET_ROLES, validatePermissions } from '../shared/permissions.js';
import { EventService } from './event.service.js';

export class RoleService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService,
  ) {}

  /** Seed preset roles into a workspace. Idempotent — safe to call on every startup. */
  async seedPreset(workspaceId: string): Promise<Role[]> {
    const seeded: Role[] = [];
    for (const preset of PRESET_ROLES) {
      const existing = await this.db.query<Role>(
        'SELECT * FROM role WHERE workspace_id = ? AND key = ?',
        [workspaceId, preset.key],
      );
      if (existing.length > 0) {
        seeded.push(this.mapRow(existing[0]));
        continue;
      }
      const id = ulid();
      const created_at = new Date().toISOString();
      await this.db.execute(
        `INSERT INTO role (id, workspace_id, key, name, description, permissions_json, is_system, rank)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, workspaceId, preset.key, preset.name, preset.description,
         JSON.stringify(preset.permissions), preset.is_system ? 1 : 0, preset.rank],
      );
      seeded.push({ id, workspace_id: workspaceId, ...preset, permissions: preset.permissions, is_system: preset.is_system ? 1 : 0, created_at });
    }
    return seeded;
  }

  /** Backfill role assignments for existing agents that have none. */
  async backfillAgentRoles(workspaceId: string): Promise<number> {
    // Find the senior_engineer role to assign as default for AI agents
    const seniorRole = await this.db.query<Role>(
      "SELECT * FROM role WHERE workspace_id = ? AND key = 'senior_engineer'",
      [workspaceId],
    );
    if (seniorRole.length === 0) return 0;

    const result = await this.db.execute(
      `UPDATE agent SET role_id = ?, workspace_id = COALESCE(workspace_id, ?) WHERE role_id IS NULL AND id IN (SELECT id FROM principal WHERE kind = 'agent')`,
      [seniorRole[0].id, workspaceId],
    );
    return result.changes;
  }

  async create(data: CreateRole): Promise<Role> {
    validatePermissions(data.permissions);
    const id = ulid();
    const created_at = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO role (id, workspace_id, key, name, description, permissions_json, is_system, rank)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.workspace_id, data.key, data.name, data.description || null,
       JSON.stringify(data.permissions), data.is_system ? 1 : 0, data.rank || 0],
    );

    if (this.eventService) {
      await this.eventService.create({
        project_id: '',
        entity_type: 'board',
        entity_id: id,
        action: 'role_created',
        actor_id: undefined,
        payload: { key: data.key, name: data.name, permissions: data.permissions },
      });
    }

    const role: Role = {
      id,
      workspace_id: data.workspace_id,
      key: data.key,
      name: data.name,
      description: data.description || null,
      permissions: data.permissions,
      is_system: data.is_system ? 1 : 0,
      rank: data.rank || 0,
      created_at,
    };
    return role;
  }

  async list(workspaceId: string): Promise<Role[]> {
    const rows = await this.db.query<any>(
      'SELECT * FROM role WHERE workspace_id = ? ORDER BY rank DESC',
      [workspaceId],
    );
    return rows.map(r => this.mapRow(r));
  }

  async getById(id: string): Promise<Role | null> {
    const rows = await this.db.query<any>('SELECT * FROM role WHERE id = ?', [id]);
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async getByKey(workspaceId: string, key: string): Promise<Role | null> {
    const rows = await this.db.query<any>(
      'SELECT * FROM role WHERE workspace_id = ? AND key = ?',
      [workspaceId, key],
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async update(id: string, data: UpdateRole): Promise<Role> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Role ${id} not found`);

    const name = data.name ?? existing.name;
    const description = data.description !== undefined ? data.description : existing.description;
    const rank = data.rank ?? existing.rank;
    const permissions = data.permissions ?? existing.permissions;

    if (data.permissions) validatePermissions(data.permissions);

    await this.db.execute(
      `UPDATE role SET name = ?, description = ?, permissions_json = ?, rank = ? WHERE id = ?`,
      [name, description, JSON.stringify(permissions), rank, id],
    );
    return { ...existing, name, description, permissions, rank };
  }

  async delete(id: string): Promise<void> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Role ${id} not found`);
    if (existing.is_system) throw new Error(`System role "${existing.key}" cannot be deleted — clone it instead`);

    await this.db.execute('DELETE FROM role WHERE id = ?', [id]);
  }

  /**
   * Clone a role (including system roles) into a new editable role.
   * The clone is never is_system.
   */
  async clone(id: string, newKey: string, newName?: string): Promise<Role> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Role ${id} not found`);

    return this.create({
      workspace_id: existing.workspace_id,
      key: newKey,
      name: newName || `${existing.name} (clone)`,
      description: existing.description || undefined,
      permissions: existing.permissions,
      is_system: false,
      rank: existing.rank - 1,
    });
  }

  /**
   * Get effective permissions for an agent.
   * effective = agent.role.permissions ∩ operator.role.permissions
   */
  async getEffectivePermissions(agentId: string, workspaceId?: string): Promise<string[]> {
    const agentRows = await this.db.query<any>(
      `SELECT a.role_id, a.operator_user_id, a.workspace_id FROM agent a WHERE a.id = ?`,
      [agentId],
    );
    if (agentRows.length === 0) return [];

    const agent = agentRows[0];
    if (!agent.role_id) return [];

    if (!agent.workspace_id || (workspaceId && agent.workspace_id !== workspaceId)) return [];

    const agentRole = await this.getById(agent.role_id);
    if (!agentRole || agentRole.workspace_id !== agent.workspace_id) return [];

    // An unbound agent has no human authority to inherit. Returning the
    // nominal role here would make offboarding a privilege escalation.
    if (!agent.operator_user_id) return [];

    // Look up the operator's role
    const opRows = await this.db.query<any>(
      `SELECT wm.role_id
       FROM workspace_member wm
       WHERE wm.workspace_id = ? AND wm.user_id = ?`,
      [agent.workspace_id, agent.operator_user_id],
    );
    if (opRows.length === 0 || !opRows[0].role_id) return [];

    const opRole = await this.getById(opRows[0].role_id);
    if (!opRole || opRole.workspace_id !== agent.workspace_id) return [];

    // Intersection
    const opSet = new Set(opRole.permissions);
    return agentRole.permissions.filter(p => opSet.has(p));
  }

  private mapRow(row: any): Role {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      key: row.key,
      name: row.name,
      description: row.description || null,
      permissions: typeof row.permissions_json === 'string'
        ? JSON.parse(row.permissions_json)
        : (row.permissions_json || []),
      is_system: row.is_system,
      rank: row.rank,
      created_at: row.created_at,
    };
  }
}
