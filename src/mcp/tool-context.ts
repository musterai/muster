import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DatabaseAdapter } from '../db/adapter.js';
import type { CommentService } from '../services/comment.service.js';
import type { AuthContext } from '../shared/auth-context.js';
import type { Services } from '../shared/services.js';
import { config } from '../config/index.js';

export interface McpToolContext {
  server: McpServer;
  services: Services;
  auth: AuthContext;
}

export const cardReferenceSchema = z.string().describe(
  'The card ULID or its human-readable key (e.g. "MUS-49"); writes resolve it to the immutable card ID.',
);

export const moveCardInputSchema = z.object({
  card_id: cardReferenceSchema,
  target_column_id: z.string().min(1).optional(),
  position: z.string().max(256).regex(/^(?:[a-z]+|0[a-z]+)$/).optional(),
  operator_override: z.boolean().optional().describe('Explicitly bypass card WIP and blocker rules when the authenticated caller has operator override authority'),
}).strict().refine((value) => value.target_column_id !== undefined || value.position !== undefined, {
  message: 'target_column_id or position is required',
});

export function attributedAgentIdSchema() {
  return config.auth.mode === 'open'
    ? z.string().min(1).describe(
      'REQUIRED in open mode. Use the exact id returned by register_agent; registration does not bind later MCP requests to that identity. Never invent an ID.',
    )
    : z.string().optional().describe(
      'Optional in authenticated mode. The bearer/session principal is authoritative; any supplied value is ignored for attribution.',
    );
}

export async function withMutationAudit<T>(
  services: Services,
  auth: AuthContext,
  entry: { action: string; target_type: string; target_id?: string; payload?: Record<string, unknown> }
    | ((result: T) => { action: string; target_type: string; target_id?: string; payload?: Record<string, unknown> }),
  mutate: (adapter?: DatabaseAdapter) => Promise<T>,
): Promise<T> {
  if (!services.db) throw new Error('Atomic MCP mutation requires services.db');
  return services.db.transaction(async (tx) => {
    const result = await mutate(tx);
    const resolvedEntry = typeof entry === 'function' ? entry(result) : entry;
    await services.auditService.logAs(auth, resolvedEntry, tx);
    return result;
  });
}

/** Credential-derived identities always win; open mode accepts a label only. */
export function resolveActor(auth: AuthContext, raw?: Record<string, unknown>): string | undefined {
  if (auth.principal) return auth.principal.id;
  if (config.auth.mode === 'open' && raw) {
    const candidate = raw.agent_id ?? raw.author_id;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

export function mayUseOperatorOverride(auth: AuthContext, requested: boolean | undefined): boolean {
  return requested === true && (config.auth.mode === 'open' || auth.is_operator_override);
}

export function requireActor(auth: AuthContext, context: string): string | undefined {
  const actorId = resolveActor(auth);
  if (!actorId && config.auth.mode === 'enforced') {
    throw new Error(`Forbidden: tool "${context}" requires an authenticated actor, but no principal was resolved.`);
  }
  return actorId;
}

export async function requireCommentOwnershipOrAdmin(
  commentService: CommentService,
  auth: AuthContext,
  commentId: string,
  action: 'edit' | 'delete',
): Promise<void> {
  if (auth.permissions.includes('workspace.admin') || !auth.principal) return;
  const owns = await commentService.validateCommentOwnership(commentId, auth.principal.id);
  if (!owns) {
    throw new Error(`Forbidden: you may only ${action} your own comments (principal: ${auth.principal.id})`);
  }
}
