// File: src/api/schemas.ts
//
// Strict REST boundary schemas.  MCP keeps its existing public Zod schemas;
// these schemas cover the REST transport and deliberately reject unknown
// properties so request composition cannot become mass assignment.

import { z } from 'zod';
import { sanitizeSameOriginPath } from '../shared/url-security.js';

const MAX_ID = 128;
const MAX_NAME = 200;
const MAX_LABEL = 120;
const MAX_QUERY = 512;
const MAX_URL = 2048;
const MAX_ARRAY_ITEMS = 100;

export const identifierSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_ID)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'must be a valid identifier');

export const textSchema = (max: number, min = 1) => z.string().trim().min(min).max(max);
export const urlSchema = z.string().trim().url().max(MAX_URL);
export const emailSchema = z.string().trim().email().max(320);
const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
export const isoDateSchema = z.string()
  .trim()
  .refine((value) => {
    const match = value.match(isoDatePattern);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return false;
    return !value.includes('T') || !Number.isNaN(Date.parse(value));
  }, 'must be a valid ISO date or datetime');

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const nonEmptyUpdate = <T extends z.AnyZodObject>(schema: T) => schema.refine(value => Object.keys(value).length > 0, {
  message: 'at least one field is required',
});

const queryBoolean = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

const queryInteger = (min: number, max: number) => z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return value;
}, z.number().int().min(min).max(max));

const metadataSchema = z.record(z.unknown()).refine((value) => JSON.stringify(value).length <= 100_000, {
  message: 'metadata is too large',
});

const id = identifierSchema;
const optionalId = id.optional();
const priority = z.enum(['critical', 'high', 'medium', 'low']);
const booleanLike = z.union([z.boolean(), z.number().int().min(0).max(1)]);
const agentStatus = z.enum(['active', 'idle', 'offline']);
const documentStatus = z.enum(['draft', 'in_review', 'approved', 'archived']);
const cardLinkType = z.enum(['blocks', 'blocked_by', 'relates_to', 'duplicates', 'parent_of', 'child_of']);
const workLinkKind = z.enum(['branch', 'pull_request', 'commit', 'pipeline']);
const workLinkProvider = z.enum(['forgejo', 'github', 'gitlab', 'other']);

/** Empty inputs are still validated: `{ unexpected: true }` is rejected. */
export const noBodySchema = z.preprocess((value) => value ?? {}, strictObject({}));
export const noQuerySchema = strictObject({});
export const noParamsSchema = strictObject({});

// Common route parameter shapes.
export const idParamsSchema = strictObject({ id });
export const projectIdParamsSchema = strictObject({ projectId: id });
export const boardIdParamsSchema = strictObject({ boardId: id });
export const columnIdParamsSchema = strictObject({ columnId: id });
export const cardIdParamsSchema = strictObject({ id });
export const commentParamsSchema = strictObject({ id, commentId: id });
export const cardAgentParamsSchema = strictObject({ id, agentId: id });
export const cardLabelParamsSchema = strictObject({ id, labelId: id });
export const cardDocumentParamsSchema = strictObject({ id, documentId: id });
export const cardLinkParamsSchema = strictObject({ id, linkId: id });
export const workspaceIdParamsSchema = strictObject({ workspaceId: id });
export const workspaceMemberParamsSchema = strictObject({ workspaceId: id, userId: id });
export const kbEntityParamsSchema = strictObject({ id });
export const roleIdParamsSchema = strictObject({ id });

// Projects, boards, columns, cards, comments, and card relationships.
export const projectCreateSchema = strictObject({
  name: textSchema(MAX_NAME),
  description: textSchema(200_000, 0).optional(),
});
export const projectUpdateSchema = nonEmptyUpdate(strictObject({
  name: textSchema(MAX_NAME).optional(),
  description: textSchema(200_000, 0).optional(),
}));

export const boardCreateSchema = strictObject({
  name: textSchema(MAX_NAME),
  columns: z.array(textSchema(MAX_LABEL)).max(MAX_ARRAY_ITEMS).optional(),
  template: z.enum(['simple', 'standard']).optional(),
});
export const boardUpdateSchema = nonEmptyUpdate(strictObject({ name: textSchema(MAX_NAME).optional() }));

export const columnCreateSchema = strictObject({
  name: textSchema(MAX_NAME),
  position: textSchema(MAX_ID).optional(),
  wip_limit: z.number().int().min(0).max(100_000).optional(),
  is_terminal: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
});
export const columnUpdateSchema = nonEmptyUpdate(strictObject({
  name: textSchema(MAX_NAME).optional(),
  position: textSchema(MAX_ID).optional(),
  wip_limit: z.number().int().min(0).max(100_000).nullable().optional(),
  is_terminal: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
}));

export const cardSearchQuerySchema = strictObject({
  q: textSchema(MAX_QUERY),
  exclude_card_id: optionalId,
});
export const cardListQuerySchema = strictObject({
  column_id: optionalId,
  assignee_id: optionalId,
  label: textSchema(MAX_LABEL).optional(),
  archived: queryBoolean.optional(),
});
export const cardCreateSchema = strictObject({
  title: textSchema(MAX_NAME),
  description: textSchema(200_000, 0).optional(),
  priority: priority.optional(),
  position: textSchema(MAX_ID).optional(),
  due_date: isoDateSchema.optional(),
  labels: z.array(id).max(MAX_ARRAY_ITEMS).optional(),
  assignees: z.array(id).max(MAX_ARRAY_ITEMS).optional(),
  is_epic: booleanLike.optional(),
  operator_override: z.boolean().optional(),
});
export const cardUpdateSchema = nonEmptyUpdate(strictObject({
  title: textSchema(MAX_NAME).optional(),
  description: textSchema(200_000, 0).optional(),
  priority: priority.optional(),
  due_date: isoDateSchema.nullable().optional(),
  archived: z.number().int().min(0).max(1).optional(),
  is_epic: booleanLike.optional(),
  // Kept for compatibility with the SPA's legacy edit payload. The service
  // intentionally ignores this field; column changes use the move endpoint.
  column_id: optionalId,
  operator_override: z.boolean().optional(),
}));
export const cardMoveSchema = strictObject({
  target_column_id: optionalId,
  position: textSchema(256).optional(),
  operator_override: z.boolean().optional(),
}).refine(value => value.target_column_id !== undefined || value.position !== undefined, {
  message: 'target_column_id or position is required',
});
export const commentCreateSchema = strictObject({
  content: textSchema(200_000, 0),
  author_id: optionalId,
  agent_id: optionalId,
});
export const commentUpdateSchema = strictObject({ content: textSchema(200_000, 0) });
export const cardClaimSchema = strictObject({
  agent_id: optionalId,
  ttl_seconds: z.number().int().min(1).max(86_400).optional(),
  operator_override: z.boolean().optional(),
});
export const cardAssigneeSchema = strictObject({ agent_id: id });
export const cardLabelSchema = strictObject({ label_id: id });
export const cardDocumentSchema = strictObject({ document_id: id });
export const cardLinkSchema = strictObject({ target_card_id: id, relation_type: cardLinkType });
export const cardWorkLinkSchema = strictObject({
  kind: workLinkKind,
  provider: workLinkProvider,
  url: urlSchema,
  external_ref: textSchema(MAX_QUERY, 0).optional(),
  title: textSchema(MAX_NAME, 0).optional(),
  status: textSchema(MAX_LABEL, 0).optional(),
});

// Documents.
export const documentListQuerySchema = strictObject({
  status: documentStatus.optional(),
  parent_id: z.union([id, z.literal('null')]).optional(),
});
export const documentCreateSchema = strictObject({
  parent_id: optionalId,
  title: textSchema(MAX_NAME),
  content: textSchema(2_000_000, 0),
  author_id: optionalId,
});
export const documentQuerySchema = strictObject({ version: queryInteger(1, 1_000_000).optional() });
export const documentUpdateSchema = nonEmptyUpdate(strictObject({
  title: textSchema(MAX_NAME).optional(),
  content: textSchema(2_000_000, 0).optional(),
  change_summary: textSchema(MAX_QUERY, 0).optional(),
  author_id: optionalId,
}));
export const documentStatusSchema = strictObject({ status: documentStatus });

// Agents, roles, members, tokens, and invitations.
const capabilities = z.union([
  textSchema(MAX_LABEL),
  z.array(textSchema(MAX_LABEL)).max(MAX_ARRAY_ITEMS),
]);
export const agentRegisterSchema = strictObject({
  id: optionalId,
  agent_id: optionalId,
  name: textSchema(MAX_NAME).optional(),
  capabilities: capabilities.optional(),
  status: agentStatus.optional(),
});
export const agentUpdateSchema = nonEmptyUpdate(strictObject({
  name: textSchema(MAX_NAME).optional(),
  capabilities: capabilities.optional(),
  status: agentStatus.optional(),
  operator_user_id: optionalId.nullable().optional(),
  role_id: optionalId.nullable().optional(),
}));

const permissions = z.array(textSchema(MAX_LABEL)).max(MAX_ARRAY_ITEMS);
export const roleCreateSchema = strictObject({
  key: textSchema(MAX_LABEL),
  name: textSchema(MAX_NAME),
  description: textSchema(200_000, 0).optional(),
  permissions,
  is_system: z.boolean().optional(),
  rank: z.number().int().min(0).max(1_000_000).optional(),
});
export const roleUpdateSchema = nonEmptyUpdate(strictObject({
  name: textSchema(MAX_NAME).optional(),
  description: textSchema(200_000, 0).optional(),
  permissions: permissions.optional(),
  rank: z.number().int().min(0).max(1_000_000).optional(),
}));
export const roleCloneSchema = strictObject({ new_key: textSchema(MAX_LABEL), new_name: textSchema(MAX_NAME).optional() });

export const memberRoleSchema = strictObject({ role_id: id });
export const tokenCreateSchema = strictObject({
  name: textSchema(MAX_NAME),
  expires_at: isoDateSchema.nullable().optional(),
  target_principal_id: optionalId,
});
export const invitationCreateSchema = strictObject({ email: emailSchema, role_id: id });

// Knowledge base.
export const kbListQuerySchema = strictObject({ project_id: optionalId });
export const kbCreateSchema = strictObject({
  name: textSchema(MAX_NAME),
  description: textSchema(200_000, 0).optional(),
  is_global: z.boolean().optional(),
  project_ids: z.array(id).max(MAX_ARRAY_ITEMS).optional(),
  actor_id: optionalId,
});
export const kbSearchQuerySchema = strictObject({
  q: textSchema(MAX_QUERY),
  kb_id: optionalId,
  project_id: optionalId,
});
export const kbGraphQuerySchema = strictObject({ kb_id: optionalId, project_id: optionalId });
export const kbEntityKnowledgeQuerySchema = strictObject({
  q: textSchema(MAX_QUERY).optional(),
  identifier: textSchema(MAX_QUERY).optional(),
  kb_id: optionalId,
}).refine(value => value.q !== undefined || value.identifier !== undefined, {
  message: 'q or identifier is required',
});
export const kbEntityListQuerySchema = strictObject({ type: textSchema(MAX_LABEL).optional() });
export const kbFactsQuerySchema = strictObject({ entity_id: optionalId, category: textSchema(MAX_LABEL).optional() });
export const kbEntityCreateSchema = strictObject({
  kb_id: id,
  name: textSchema(MAX_NAME),
  type: textSchema(MAX_LABEL).optional(),
  identifier: textSchema(MAX_QUERY).optional(),
  metadata: metadataSchema.optional(),
  actor_id: optionalId,
});
export const kbEntityUpdateSchema = nonEmptyUpdate(strictObject({
  name: textSchema(MAX_NAME).optional(),
  type: textSchema(MAX_LABEL).optional(),
  identifier: textSchema(MAX_QUERY).optional(),
  metadata: metadataSchema.optional(),
  actor_id: optionalId,
}));
export const kbFactCreateSchema = strictObject({
  kb_id: id,
  title: textSchema(MAX_NAME),
  content: textSchema(2_000_000, 0),
  category: textSchema(MAX_LABEL).optional(),
  entity_id: optionalId,
  entity_name: textSchema(MAX_NAME).optional(),
  entity_type: textSchema(MAX_LABEL).optional(),
  entity_identifier: textSchema(MAX_QUERY).optional(),
  confidence: z.number().min(0).max(1).optional(),
  source_principal_id: optionalId,
  actor_id: optionalId,
});
export const kbFactUpdateSchema = nonEmptyUpdate(strictObject({
  title: textSchema(MAX_NAME).optional(),
  content: textSchema(2_000_000, 0).optional(),
  category: textSchema(MAX_LABEL).optional(),
  entity_id: optionalId,
  entity_name: textSchema(MAX_NAME).optional(),
  entity_type: textSchema(MAX_LABEL).optional(),
  entity_identifier: textSchema(MAX_QUERY).optional(),
  confidence: z.number().min(0).max(1).optional(),
  actor_id: optionalId,
}));
export const kbProjectLinkSchema = strictObject({ project_id: id, actor_id: optionalId });
export const kbActorSchema = strictObject({ actor_id: optionalId });
export const kbRelationCreateSchema = strictObject({
  kb_id: id,
  source_entity_id: id,
  target_entity_id: id,
  relation_type: textSchema(MAX_LABEL),
  description: textSchema(200_000, 0).optional(),
  actor_id: optionalId,
});

// Audit and event filters.
export const auditQuerySchema = strictObject({
  actor_id: optionalId,
  action: textSchema(MAX_LABEL).optional(),
  limit: queryInteger(1, 1_000).optional(),
});
export const eventQuerySchema = strictObject({
  entity_type: z.enum(['project', 'board', 'column', 'card', 'document', 'agent', 'knowledge_base']).optional(),
  entity_id: optionalId,
  since: isoDateSchema.optional(),
  limit: queryInteger(1, 1_000).optional(),
});

// OIDC, device authorization, and MCP-native OAuth.
export const authLoginQuerySchema = strictObject({
  redirect_to: z.string().trim().max(MAX_URL).refine(value => sanitizeSameOriginPath(value) !== null, {
    message: 'redirect_to must be an absolute same-origin path',
  }).optional(),
});
export const authCallbackQuerySchema = strictObject({
  state: textSchema(MAX_QUERY),
  code: textSchema(MAX_QUERY).optional(),
  error: textSchema(MAX_LABEL).optional(),
  error_description: textSchema(MAX_QUERY).optional(),
  error_uri: urlSchema.optional(),
  iss: urlSchema.optional(),
  scope: textSchema(MAX_QUERY).optional(),
});
export const authLocalSchema = strictObject({
  user_id: optionalId,
  display_name: textSchema(80).optional(),
}).refine(value => value.user_id !== undefined || value.display_name !== undefined, {
  message: 'user_id or display_name is required',
});
export const invitationCreateBodySchema = invitationCreateSchema;

export const deviceLookupQuerySchema = strictObject({ user_code: textSchema(MAX_LABEL) });
export const deviceCodeBodySchema = noBodySchema;
export const deviceApproveSchema = strictObject({ user_code: textSchema(MAX_LABEL) });
export const deviceDenySchema = deviceApproveSchema;

export const oauthTokenSchema = z.union([
  strictObject({ grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'), device_code: textSchema(MAX_QUERY) }),
  strictObject({
    grant_type: z.literal('authorization_code'),
    code: textSchema(MAX_QUERY),
    client_id: textSchema(MAX_QUERY),
    redirect_uri: urlSchema,
    code_verifier: textSchema(MAX_QUERY),
    resource: urlSchema,
  }),
  strictObject({
    grant_type: z.literal('refresh_token'),
    refresh_token: textSchema(MAX_QUERY),
    client_id: textSchema(MAX_QUERY),
    resource: urlSchema,
  }),
]);

export const oauthRegisterSchema = strictObject({
  client_name: textSchema(MAX_NAME).optional(),
  redirect_uris: z.array(urlSchema).min(1).max(20),
  token_endpoint_auth_method: z.enum(['none']).optional(),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).min(1).max(2).optional(),
  response_types: z.array(z.literal('code')).min(1).max(1).optional(),
});
export const oauthAuthorizeQuerySchema = strictObject({
  response_type: z.literal('code'),
  client_id: textSchema(MAX_QUERY),
  redirect_uri: urlSchema,
  code_challenge: textSchema(MAX_QUERY),
  code_challenge_method: z.literal('S256'),
  resource: urlSchema,
  state: textSchema(MAX_QUERY).optional(),
});
export const oauthAuthorizeDetailsQuerySchema = strictObject({ client_id: textSchema(MAX_QUERY) });
export const oauthConsentSchema = strictObject({
  client_id: textSchema(MAX_QUERY),
  redirect_uri: urlSchema,
  code_challenge: textSchema(MAX_QUERY),
  code_challenge_method: z.literal('S256'),
  resource: urlSchema,
  state: textSchema(MAX_QUERY).optional(),
  decision: z.enum(['approve', 'deny']),
  agent_id: optionalId,
  new_agent_name: textSchema(MAX_NAME).optional(),
  role_id: optionalId,
});
