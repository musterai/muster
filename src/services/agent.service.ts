// File: src/services/agent.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Agent, RegisterAgent, UpdateAgent } from '../shared/types.js';
import { EventService } from './event.service.js';
import { ValidationError } from '../shared/errors.js';

export class AgentService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService
  ) {}

  /**
   * Register a new agent or re-bind an existing session.
   *
   * @param data - Registration payload from the caller.
   * @param operatorUserId - (MUS-23) The authenticated principal operating this
   *   agent. When set, the agent is bound to this operator. In open mode this
   *   is undefined — agents are unbound.
   * @param restrictToRoleId - (MUS-23) A role_id whose permissions are a subset
   *   of the operator's own. When set, the agent is pinned to this role.
   */
  async register(
    data: RegisterAgent,
    operatorUserId?: string,
    restrictToRoleId?: string,
    workspaceId?: string,
  ): Promise<Agent> {
    const id = data.agent_id || data.id || ulid();
    const now = new Date().toISOString();

    // Check if re-binding an existing agent
    const existing = await this.getById(id);
    if (existing) {
      if (operatorUserId) {
        if (!existing.operator_user_id) {
          throw new ValidationError('Unassigned agents require an administrator adoption flow');
        }
        if (existing.operator_user_id !== operatorUserId) {
          throw new ValidationError('Agent belongs to a different operator');
        }
        if (!existing.workspace_id || existing.workspace_id !== workspaceId) {
          throw new ValidationError('Agent belongs to a different workspace');
        }
      }
      const name = data.name || existing.name;
      const status = data.status || 'active';

      let capabilitiesStr: string | null = existing.capabilities ? JSON.stringify(existing.capabilities) : null;
      if (data.capabilities) {
        if (typeof data.capabilities === 'string') {
          capabilitiesStr = JSON.stringify(data.capabilities.split(',').map(s => s.trim()));
        } else if (Array.isArray(data.capabilities)) {
          capabilitiesStr = JSON.stringify(data.capabilities);
        }
      }

      // Re-binding refreshes mutable telemetry only; it never adopts or
      // re-parents an unassigned identity.
      const finalOperatorUserId = existing.operator_user_id || null;
      const finalRoleId = restrictToRoleId || existing.role_id || null;

      await this.db.execute(
        `UPDATE agent SET name = ?, capabilities = ?, status = ?, last_seen_at = ?, operator_user_id = ?, role_id = ? WHERE id = ?`,
        [name, capabilitiesStr, status, now, finalOperatorUserId, finalRoleId, id]
      );

      return (await this.getById(id))!;
    }

    // Create a new agent — requires a principal row first
    const kind = 'agent';
    await this.db.execute(
      `INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)`,
      [id, kind, now]
    );

    const name = data.name || 'AI Agent';
    const status = data.status || 'active';
    const capabilitiesStr = data.capabilities
      ? (typeof data.capabilities === 'string'
        ? JSON.stringify(data.capabilities.split(',').map(s => s.trim()))
        : JSON.stringify(data.capabilities))
      : null;

    await this.db.execute(
      `INSERT INTO agent (id, name, capabilities, status, last_seen_at, operator_user_id, role_id, workspace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, capabilitiesStr, status, now, operatorUserId || null, restrictToRoleId || null, workspaceId || null, now]
    );

    if (this.eventService) {
      // No project context for agent registration — skip event for now.
    }

    return {
      id,
      name,
      capabilities: capabilitiesStr ? JSON.parse(capabilitiesStr) : [],
      status,
      last_seen_at: now,
      operator_user_id: operatorUserId || null,
      role_id: restrictToRoleId || null,
      workspace_id: workspaceId || null,
      created_at: now,
    };
  }

  async unregister(id: string, actorId?: string): Promise<void> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Agent with ID ${id} not found`);
    await this.db.transaction(async tx => {
      const now = new Date().toISOString();
      await tx.execute(
        'UPDATE api_token SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL',
        [now, id],
      );
      await tx.execute('DELETE FROM oauth_authorization_code WHERE agent_principal_id = ?', [id]);
      await tx.execute('UPDATE oauth_refresh_token SET revoked = 1 WHERE agent_principal_id = ?', [id]);
      await tx.execute(
        'UPDATE card SET claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL WHERE claimed_by = ?',
        [id],
      );
      // Keep the principal and agent row so comments, documents and audit
      // records retain attribution. Null role/operator makes the tombstone
      // cryptographically powerless; status keeps it out of active telemetry.
      await tx.execute(
        `UPDATE agent
         SET status = 'offline', operator_user_id = NULL, role_id = NULL, capabilities = NULL
         WHERE id = ?`,
        [id],
      );
    });
  }

  async update(
    id: string,
    data: UpdateAgent,
    options: { workspaceId?: string; allowIdentityChanges?: boolean } = {},
  ): Promise<Agent> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Agent with ID ${id} not found`);

    const changesIdentity = data.operator_user_id !== undefined || data.role_id !== undefined;
    if (changesIdentity && !options.allowIdentityChanges) {
      throw new ValidationError('Changing an agent owner or role requires workspace administrator authority');
    }
    if (options.workspaceId && existing.workspace_id !== options.workspaceId) {
      throw new ValidationError('Agent belongs to a different workspace');
    }

    const name = data.name !== undefined ? data.name : existing.name;
    const status = data.status !== undefined ? data.status : existing.status;
    const operator_user_id = data.operator_user_id !== undefined ? data.operator_user_id : existing.operator_user_id;
    const role_id = data.role_id !== undefined ? data.role_id : existing.role_id;

    let capabilitiesStr: string | null = existing.capabilities ? JSON.stringify(existing.capabilities) : null;
    if (data.capabilities !== undefined) {
      if (typeof data.capabilities === 'string') {
        capabilitiesStr = JSON.stringify(data.capabilities.split(',').map(s => s.trim()).filter(Boolean));
      } else if (Array.isArray(data.capabilities)) {
        capabilitiesStr = JSON.stringify(data.capabilities);
      }
    }

    await this.db.transaction(async tx => {
      if (role_id) {
        const roles = await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM role WHERE id = ?', [role_id]);
        if (roles.length === 0 || roles[0].workspace_id !== existing.workspace_id) {
          throw new ValidationError('Target role does not belong to the agent workspace');
        }
      }
      if (operator_user_id) {
        const members = await tx.query<{ user_id: string }>(
          'SELECT user_id FROM workspace_member WHERE workspace_id = ? AND user_id = ?',
          [existing.workspace_id, operator_user_id],
        );
        if (members.length === 0) {
          throw new ValidationError('Target operator is not a member of the agent workspace');
        }
      }

      await tx.execute(
        `UPDATE agent SET name = ?, capabilities = ?, status = ?, operator_user_id = ?, role_id = ? WHERE id = ?`,
        [name, capabilitiesStr, status, operator_user_id, role_id, id],
      );

      const credentialsMustRotate = changesIdentity || status !== existing.status;
      if (credentialsMustRotate) {
        const now = new Date().toISOString();
        await tx.execute(
          'UPDATE api_token SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL',
          [now, id],
        );
        await tx.execute('DELETE FROM oauth_authorization_code WHERE agent_principal_id = ?', [id]);
        await tx.execute('UPDATE oauth_refresh_token SET revoked = 1 WHERE agent_principal_id = ?', [id]);
      }
    });

    return (await this.getById(id))!;
  }

  async getById(id: string): Promise<Agent | null> {
    const rows = await this.db.query<any>('SELECT * FROM agent WHERE id = ?', [id]);
    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
      status: row.status,
      last_seen_at: row.last_seen_at,
      operator_user_id: row.operator_user_id,
      role_id: row.role_id,
      workspace_id: row.workspace_id,
      created_at: row.created_at,
    };
  }

  async list(): Promise<Agent[]> {
    const rows = await this.db.query<any>('SELECT * FROM agent ORDER BY created_at ASC');
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
      status: row.status,
      last_seen_at: row.last_seen_at,
      operator_user_id: row.operator_user_id,
      role_id: row.role_id,
      workspace_id: row.workspace_id,
      created_at: row.created_at,
    }));
  }

  async heartbeat(id: string): Promise<Agent> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Agent with ID ${id} not found`);

    const last_seen_at = new Date().toISOString();
    await this.db.execute(
      'UPDATE agent SET last_seen_at = ?, status = ? WHERE id = ?',
      [last_seen_at, 'active', id]
    );

    return { ...existing, last_seen_at, status: 'active' };
  }

  async updateStatus(agentId?: string, status?: 'active' | 'idle' | 'offline'): Promise<void> {
    if (agentId && status) {
      await this.db.execute('UPDATE agent SET status = ?, last_seen_at = ? WHERE id = ?', [status, new Date().toISOString(), agentId]);
      return;
    }

    // Passive update: set agents to 'idle' if >5m, 'offline' if >15m
    const now = new Date().getTime();
    const agents = await this.db.query<any>('SELECT id, status, last_seen_at FROM agent');

    for (const agent of agents) {
      const lastSeen = new Date(agent.last_seen_at).getTime();
      const diffMinutes = (now - lastSeen) / (1000 * 60);

      let newStatus = agent.status;
      if (diffMinutes > 15 && agent.status !== 'offline') {
        newStatus = 'offline';
      } else if (diffMinutes > 5 && agent.status === 'active') {
        newStatus = 'idle';
      }

      if (newStatus !== agent.status) {
        await this.db.execute('UPDATE agent SET status = ? WHERE id = ?', [newStatus, agent.id]);
      }
    }
  }

  /**
   * Layer 2 scope check: validate that an agent identified in tool args
   * belongs to (is operated by) the given authenticated principal.
   * Returns the agent's operator_user_id if found, null if agent doesn't exist.
   * Throws if the agent exists but does NOT belong to the principal.
   */
  async validateAgentOwnership(agentId: string, principalId: string): Promise<string | null> {
    const agent = await this.getById(agentId);
    if (!agent) return null;

    if (!agent.operator_user_id || agent.operator_user_id !== principalId) {
      throw new Error(
        `Agent "${agentId}" belongs to a different operator or is unassigned and cannot be used by principal "${principalId}".`,
      );
    }

    return agent.operator_user_id;
  }

  /**
   * Layer 2 scope check: return all agent IDs that a given principal operates.
   * Used to determine whether the principal has scope over a card via assignment.
   */
  async getAgentIdsForPrincipal(principalId: string): Promise<string[]> {
    // Check if the principal IS an agent — include itself
    const principalRows = await this.db.query<{ kind: string }>(
      'SELECT kind FROM principal WHERE id = ?',
      [principalId],
    );
    const rows: string[] = [];
    if (principalRows.length > 0 && principalRows[0].kind === 'agent') {
      rows.push(principalId);
    }

    // Find all agents operated by this principal
    const agentRows = await this.db.query<{ id: string }>(
      'SELECT id FROM agent WHERE operator_user_id = ?',
      [principalId],
    );
    for (const r of agentRows) {
      rows.push(r.id);
    }

    return rows;
  }
}
