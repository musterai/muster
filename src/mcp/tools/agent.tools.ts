import { z } from 'zod';
import { config } from '../../config/index.js';
import { withPermission } from '../../shared/permission-enforcer.js';
import { resolveActor, withMutationAudit, type McpToolContext } from '../tool-context.js';

export function registerAgentTools({ server, services, auth }: McpToolContext): void {
  // --- Agent Management Tools ---
  server.tool('register_agent', {
    agent_id: z.string().optional().describe('Existing Agent ID to re-bind session across runs'),
    name: z.string().optional().describe('Agent name'),
    capabilities: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.enum(['active', 'idle', 'offline']).optional(),
    type: z.enum(['ai_agent', 'human']).optional().describe(
      'Deprecated compatibility field. This endpoint only creates AI agents; human identities are established through OIDC admission.'
    ),
    role: z.string().trim().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/).optional().describe(
      'Deprecated compatibility field. In authenticated mode the server derives an agent role from the authenticated operator and never trusts this value.'
    ),
    secret_token: z.string().min(1).max(2048).optional().describe(
      'Deprecated compatibility field retained for legacy clients. It is ignored and never persisted or used for authentication.'
    ),
  }, withPermission('register_agent', auth, async (args) => {
    const {
      type: legacyType,
      role: legacyRole,
      secret_token: legacySecretToken,
      ...registration
    } = args;
    if (legacyType === 'human') {
      throw new Error('register_agent only creates AI agent identities; human identities must authenticate through OIDC admission.');
    }
    // Explicitly discard historical caller-controlled authority fields before
    // reaching the domain service. They remain accepted so the documented
    // AOP registration example works, but neither can select an identity,
    // authenticated role, or credential.
    void legacyRole;
    void legacySecretToken;
    // MUS-23: bind agent to the authenticated operator
    const operatorUserId = auth.principal?.kind === 'user' ? auth.principal.id : undefined;
    const result = await services.agentService.register(
      registration,
      operatorUserId,
      undefined,
      auth.workspace_id || undefined,
      config.auth.mode === 'enforced' ? auth : null,
    );
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('update_agent', {
    agent_id: z.string(),
    name: z.string().optional(),
    capabilities: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.enum(['active', 'idle', 'offline']).optional(),
  }, withPermission('update_agent', auth, async ({ agent_id, ...data }) => {
    const agent = await services.agentService.update(agent_id, data, {
      workspaceId: auth.workspace_id || undefined,
      auth,
    });
    return { content: [{ type: 'text', text: JSON.stringify(agent, null, 2) }] };
  }));

  server.tool('unregister_agent', { agent_id: z.string() }, withPermission('unregister_agent', auth, async ({ agent_id }) => {
    await services.agentService.assertAgentScope(agent_id, auth, 'agent.manage_others');
    await withMutationAudit(services, auth, {
      action: 'agent.unregister',
      target_type: 'agent',
      target_id: agent_id,
    }, tx => services.agentService.unregister(agent_id, resolveActor(auth), tx, auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Agent ${agent_id} unregistered.` }) }] };
  }));

  server.tool('heartbeat', {
    agent_id: z.string().min(1).describe(
      'REQUIRED. Use the exact id returned by register_agent. In open mode, registration does not bind later MCP requests, so this ID must be sent with every heartbeat.'
    ),
  }, withPermission('heartbeat', auth, async ({ agent_id }) => {
    const result = await services.agentService.heartbeat(agent_id, auth);
    await services.cardService.renewClaims(agent_id);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('list_agents', {
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('list_agents', auth, async ({ cursor, limit }) => {
    const result = await services.agentService.listPage(config.auth.mode === 'enforced' ? auth.workspace_id : undefined, { cursor, limit });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

}
