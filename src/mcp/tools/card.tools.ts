import { z } from 'zod';
import { withPermission } from '../../shared/permission-enforcer.js';
import { mcpCardCreateInputSchema } from '../../shared/card-input-schema.js';
import {
  attributedAgentIdSchema,
  cardReferenceSchema,
  mayUseOperatorOverride,
  moveCardInputSchema,
  requireCommentOwnershipOrAdmin,
  resolveActor,
  type McpToolContext,
} from '../tool-context.js';

export function registerCardTools({ server, services, auth }: McpToolContext): void {
  server.tool('list_cards', {
    board_id: z.string().optional(),
    project_id: z.string().optional(),
    column_id: z.string().optional(),
    assignee_id: z.string().optional(),
    label: z.string().optional(),
    archived: z.boolean().optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional().describe('Opaque continuation cursor returned by the previous page'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size; defaults to 50 and cannot exceed 100'),
  }, withPermission('list_cards', auth, async ({ cursor, limit, ...filters }) => {
    const cards = await services.cardService.listPage(filters, { cursor, limit }, auth);
    return { content: [{ type: 'text', text: JSON.stringify(cards, null, 2) }] };
  }));

  server.tool('search_cards', {
    project_id: z.string().min(1).describe('Project whose active cards should be searched'),
    query: z.string().trim().min(1).describe('Literal, case-insensitive substring to match against card titles'),
    exclude_card_id: cardReferenceSchema.optional().describe('Optional card ULID or human-readable key to omit from results'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum results to return; defaults to 20 and cannot exceed 100'),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional().describe('Opaque continuation cursor returned by the previous page'),
  }, withPermission('search_cards', auth, async ({ project_id, query, exclude_card_id, limit, cursor }) => {
    const cards = await services.cardService.searchByTitlePage(project_id, query, {
      excludeCardId: exclude_card_id,
      limit,
      cursor,
    }, auth);
    return { content: [{ type: 'text', text: JSON.stringify(cards, null, 2) }] };
  }));

  server.tool('create_card', mcpCardCreateInputSchema.shape, withPermission('create_card', auth, async ({ operator_override, ...args }) => {
    const card = await services.cardService.create(args, resolveActor(auth), {
      operatorOverride: mayUseOperatorOverride(auth, operator_override), auth,
    });
    return { content: [{ type: 'text', text: JSON.stringify(card, null, 2) }] };
  }));

  server.tool('get_card', { card_id: cardReferenceSchema }, withPermission('get_card', auth, async ({ card_id }) => {
    const details = await services.cardService.getById(card_id, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('update_card', {
    card_id: cardReferenceSchema,
    title: z.string().optional(),
    description: z.string().optional(),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    due_date: z.string().nullable().optional(),
    is_epic: z.boolean().optional().describe('Marks this card as a container for related work'),
    operator_override: z.boolean().optional().describe('Explicitly bypass card WIP rules when the authenticated caller has operator override authority'),
  }, withPermission('update_card', auth, async ({ card_id, operator_override, ...data }) => {
    const details = await services.cardService.update(card_id, data, resolveActor(auth), {
      operatorOverride: mayUseOperatorOverride(auth, operator_override), auth,
    });
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.registerTool('move_card', { inputSchema: moveCardInputSchema }, withPermission('move_card', auth, async ({ card_id, target_column_id, position, operator_override }) => {
    const details = await services.cardService.move(card_id, { target_column_id, position }, resolveActor(auth), {
      operatorOverride: mayUseOperatorOverride(auth, operator_override), auth,
    });
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  }));

  server.tool('claim_card', {
    card_id: cardReferenceSchema,
    agent_id: z.string().describe('Required — the principal/agent ID claiming the card. This also records the assignee and work lease. After a successful claim, call move_card to advance it to the next active-work lane selected by board role and position.'),
    ttl_seconds: z.number().optional().describe('Lease duration in seconds; defaults to 600 (10 minutes)'),
    operator_override: z.boolean().optional().describe('Explicitly bypass blocker rules when the authenticated caller has operator override authority'),
  }, withPermission('claim_card', auth, async ({ card_id, agent_id, ttl_seconds, operator_override }) => {
    const result = await services.cardService.claim(card_id, agent_id, ttl_seconds, resolveActor(auth) || agent_id, {
      operatorOverride: mayUseOperatorOverride(auth, operator_override), auth,
    });
    const response = 'success' in result && result.success === false
      ? result
      : {
          ...result,
          next_action: "Claim complete: assignment and work lease recorded. Immediately call move_card to advance this card to the returned next active-work lane (next_active_lane; the board's active workflow role).",
        };
    return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
  }));

  server.tool('assign_card', { card_id: cardReferenceSchema, agent_id: z.string() }, withPermission('assign_card', auth, async ({ card_id, agent_id }) => {
    await services.cardService.assign(card_id, agent_id, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify(await services.cardService.getById(card_id, undefined, auth), null, 2) }] };
  }));

  server.tool('unassign_card', { card_id: cardReferenceSchema, agent_id: z.string() }, withPermission('unassign_card', auth, async ({ card_id, agent_id }) => {
    await services.cardService.unassign(card_id, agent_id, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify(await services.cardService.getById(card_id, undefined, auth), null, 2) }] };
  }));

  server.tool('add_comment', {
    card_id: cardReferenceSchema,
    content: z.string(),
    author_id: z.string().optional().describe('Deprecated alias retained for compatibility. Open-mode MCP clients must pass agent_id; authenticated-mode attribution comes from the bearer/session principal.'),
    agent_id: attributedAgentIdSchema(),
  }, withPermission('add_comment', auth, async (args) => {
    const comment = await services.commentService.create({ ...args, author_id: resolveActor(auth, args) }, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(comment, null, 2) }] };
  }));

  server.tool('update_comment', { comment_id: z.string(), content: z.string() }, withPermission('update_comment', auth, async ({ comment_id, content }) => {
    await requireCommentOwnershipOrAdmin(services.commentService, auth, comment_id, 'edit');
    const comment = await services.commentService.update(comment_id, content, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(comment, null, 2) }] };
  }));

  server.tool('delete_comment', { comment_id: z.string() }, withPermission('delete_comment', auth, async ({ comment_id }) => {
    await requireCommentOwnershipOrAdmin(services.commentService, auth, comment_id, 'delete');
    await services.commentService.delete(comment_id, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Comment ${comment_id} deleted` }) }] };
  }));

  server.tool('add_label', { card_id: cardReferenceSchema, label_id: z.string() }, withPermission('add_label', auth, async ({ card_id, label_id }) => {
    await services.cardService.addLabel(card_id, label_id, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
  }));
  server.tool('remove_label', { card_id: cardReferenceSchema, label_id: z.string() }, withPermission('remove_label', auth, async ({ card_id, label_id }) => {
    await services.cardService.removeLabel(card_id, label_id, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
  }));
  server.tool('archive_card', { card_id: cardReferenceSchema }, withPermission('archive_card', auth, async ({ card_id }) => {
    await services.cardService.archive(card_id, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
  }));
  server.tool('delete_card', { card_id: cardReferenceSchema }, withPermission('delete_card', auth, async ({ card_id }) => {
    await services.cardService.delete(card_id, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Card ${card_id} deleted` }) }] };
  }));

  server.tool('link_document_to_card', { card_id: cardReferenceSchema, document_id: z.string() }, withPermission('link_document_to_card', auth, async ({ card_id, document_id }) => {
    await services.cardService.linkDocument(card_id, document_id, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify(await services.cardService.getById(card_id, undefined, auth), null, 2) }] };
  }));
  server.tool('unlink_document_from_card', { card_id: cardReferenceSchema, document_id: z.string() }, withPermission('unlink_document_from_card', auth, async ({ card_id, document_id }) => {
    await services.cardService.unlinkDocument(card_id, document_id, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify(await services.cardService.getById(card_id, undefined, auth), null, 2) }] };
  }));
  server.tool('link_card', {
    card_id: cardReferenceSchema,
    target_card_id: cardReferenceSchema,
    relation_type: z.enum(['blocks', 'blocked_by', 'relates_to', 'duplicates', 'parent_of', 'child_of']),
  }, withPermission('link_card', auth, async ({ card_id, target_card_id, relation_type }) => {
    await services.cardService.linkCard(card_id, target_card_id, relation_type, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify(await services.cardService.getById(card_id, undefined, auth), null, 2) }] };
  }));
  server.tool('unlink_card', { card_id: cardReferenceSchema, link_id: z.string() }, withPermission('unlink_card', auth, async ({ card_id, link_id }) => {
    await services.cardService.unlinkCard(card_id, link_id, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify(await services.cardService.getById(card_id, undefined, auth), null, 2) }] };
  }));

  server.tool('add_work_link', {
    card_id: cardReferenceSchema,
    kind: z.enum(['branch', 'pull_request', 'commit', 'pipeline']),
    provider: z.enum(['forgejo', 'github', 'gitlab', 'other']),
    url: z.string(),
    external_ref: z.string().optional(),
    title: z.string().optional(),
    status: z.string().optional(),
  }, withPermission('add_work_link', auth, async ({ card_id, ...data }) => {
    await services.cardService.addWorkLink(card_id, data, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify(await services.cardService.getById(card_id, undefined, auth), null, 2) }] };
  }));
  server.tool('remove_work_link', { card_id: cardReferenceSchema, link_id: z.string() }, withPermission('remove_work_link', auth, async ({ card_id, link_id }) => {
    await services.cardService.removeWorkLink(card_id, link_id, resolveActor(auth), auth);
    return { content: [{ type: 'text', text: JSON.stringify(await services.cardService.getById(card_id, undefined, auth), null, 2) }] };
  }));
  server.tool('list_work_links', { card_id: cardReferenceSchema, cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(), limit: z.number().int().min(1).max(100).optional() }, withPermission('list_work_links', auth, async ({ card_id, cursor, limit }) => {
    return { content: [{ type: 'text', text: JSON.stringify(await services.cardService.listWorkLinksPage(card_id, { cursor, limit }, undefined, auth), null, 2) }] };
  }));

  server.tool('create_label', { board_id: z.string(), name: z.string(), color: z.string() }, withPermission('create_label', auth, async (args) => {
    return { content: [{ type: 'text', text: JSON.stringify(await services.boardService.createLabel(args, auth), null, 2) }] };
  }));
  server.tool('list_labels', { board_id: z.string(), cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(), limit: z.number().int().min(1).max(100).optional() }, withPermission('list_labels', auth, async ({ board_id, cursor, limit }) => {
    return { content: [{ type: 'text', text: JSON.stringify(await services.boardService.listLabelsPage(board_id, { cursor, limit }, auth), null, 2) }] };
  }));
}
