// File: src/services/agent.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Agent, RegisterAgent, UpdateAgent } from '../shared/types.js';
import { EventService } from './event.service.js';

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
    workspaceId?: string | null,
  ): Promise<Agent> {
    const id = data.agent_id || data.id || ulid();
    const now = new Date().toISOString();
    const membershipRows = operatorUserId && !workspaceId
      ? await this.db.query<{ workspace_id: string }>(
          'SELECT workspace_id FROM workspace_member WHERE user_id = ? ORDER BY joined_at ASC LIMIT 1',
          [operatorUserId],
        )
      : [];
    const resolvedWorkspaceId = workspaceId || membershipRows[0]?.workspace_id || null;

    // Check if re-binding an existing agent
    const existing = await this.getById(id);
    if (existing) {
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

      // MUS-23: On re-bind, set operator_user_id if not already set
      const finalOperatorUserId = existing.operator_user_id || operatorUserId || null;
      const finalRoleId = restrictToRoleId || existing.role_id || null;
      const finalWorkspaceId = resolvedWorkspaceId || existing.workspace_id || null;

      await this.db.execute(
        `UPDATE agent SET name = ?, capabilities = ?, status = ?, last_seen_at = ?, operator_user_id = ?, role_id = ?, workspace_id = ? WHERE id = ?`,
        [name, capabilitiesStr, status, now, finalOperatorUserId, finalRoleId, finalWorkspaceId, id]
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
      [id, name, capabilitiesStr, status, now, operatorUserId || null, restrictToRoleId || null, resolvedWorkspaceId, now]
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
      workspace_id: resolvedWorkspaceId,
      created_at: now,
    };
  }

  async unregister(id: string, actorId?: string): Promise<void> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Agent with ID ${id} not found`);
    await this.db.execute('DELETE FROM agent WHERE id = ?', [id]);
    await this.db.execute('DELETE FROM principal WHERE id = ?', [id]);
  }

  async update(id: string, data: UpdateAgent): Promise<Agent> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Agent with ID ${id} not found`);

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

    await this.db.execute(
      `UPDATE agent SET name = ?, capabilities = ?, status = ?, operator_user_id = ?, role_id = ? WHERE id = ?`,
      [name, capabilitiesStr, status, operator_user_id, role_id, id]
    );

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

    if (agent.operator_user_id && agent.operator_user_id !== principalId) {
      throw new Error(
        `Agent "${agentId}" belongs to a different operator and cannot be used by principal "${principalId}".`
      );
    }

    return agent.operator_user_id || principalId;
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
