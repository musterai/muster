// File: src/web/types.ts

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  key_prefix: string;
  card_seq: number;
  created_at: string;
  updated_at: string;
}

export interface Board {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
}

export interface Column {
  id: string;
  board_id: string;
  name: string;
  position: string;
  wip_limit: number | null;
  is_terminal: number;
}

export interface CardAssignee {
  id: string;
  name: string;
  kind: 'user' | 'agent';
  /** Liveness is agent-only telemetry — always null for a human assignee. */
  status: 'active' | 'idle' | 'offline' | null;
}

export interface Card {
  id: string;
  key: string;
  column_id: string;
  title: string;
  description: string | null;
  position: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  due_date: string | null;
  created_at: string;
  updated_at: string;
  archived: number;
  /** Marks this card as a container for related work — see 'parent_of' link type. */
  is_epic: number;
  assignees?: CardAssignee[];
  parent_epic_id?: string | null;
  parent_epic_key?: string | null;
  parent_epic_title?: string | null;
  board_id?: string;
  board_name?: string;
  board_slug?: string;
}

export type CardSummary = Omit<Card, 'description'>;

export interface Label {
  id: string;
  board_id: string;
  name: string;
  color: string;
}

export interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  status: 'active' | 'idle' | 'offline';
  last_seen_at: string;
  created_at: string;
  operator_user_id?: string | null;
  role_id?: string | null;
  workspace_id?: string | null;
}

/** A human workspace member — see the Agent/User split in DESIGN_LANGUAGE.md and design doc §4.1. */
export interface User {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  role_id: string;
  role_name: string;
  joined_at: string;
}

/** Places that genuinely accept either kind — assignees, comment authors, event actors. */
export type Principal = (User & { kind: 'user' }) | (Agent & { kind: 'agent' });


/** Document without its markdown body — cards embed this, never the full content. */
export type DocumentSummary = Omit<Document, 'content'>;

export interface PageInfo {
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface Page<T> {
  items: T[];
  page: PageInfo;
}

export interface CardDetails extends Card {
  assignees: CardAssignee[];
  labels: Label[];
  linked_documents: DocumentSummary[];
  linked_cards: LinkedCardSummary[];
  work_links: CardWorkLink[];
  epic_progress: { total: number; done: number } | null;
  comments: {
    id: string;
    card_id: string;
    author_id: string;
    author_name?: string;
    author_kind?: 'user' | 'agent';
    content: string;
    created_at: string;
  }[];
}

export type CardWorkLinkKind = 'branch' | 'pull_request' | 'commit' | 'pipeline';
export type CardWorkLinkProvider = 'forgejo' | 'github' | 'gitlab' | 'other';

export interface CardWorkLink {
  id: string;
  card_id: string;
  kind: CardWorkLinkKind;
  provider: CardWorkLinkProvider;
  url: string;
  external_ref: string | null;
  title: string | null;
  status: string | null;
  created_at: string;
}

export interface CreateCardWorkLink {
  kind: CardWorkLinkKind;
  provider: CardWorkLinkProvider;
  url: string;
  external_ref?: string;
  title?: string;
  status?: string;
}

// Stored relation types are directional; 'blocked_by' is the inverse view of
// a 'blocks' row and is never sent to the API directly.
// 'blocked_by' and 'child_of' are inverse views computed by the server —
// never written directly. See shared/types.ts for the canonical comment.
export type StoredCardLinkType = 'blocks' | 'relates_to' | 'duplicates' | 'parent_of';
export type CardLinkRelationType = StoredCardLinkType | 'blocked_by' | 'child_of';

export interface LinkedCardSummary {
  id: string;
  relation_type: CardLinkRelationType;
  card: {
    id: string;
    key: string;
    title: string;
    column_id: string;
    column_name: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
    archived: number;
  };
}

export interface Document {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  content: string;
  status: 'draft' | 'in_review' | 'approved' | 'archived';
  author_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  version: number;
  title: string;
  content: string;
  author_id: string | null;
  author_name?: string | null;
  change_summary: string | null;
  created_at: string;
}

export type DocumentVersionSummary = Omit<DocumentVersion, 'content'>;

export interface Event {
  id: string;
  project_id: string;
  entity_type: 'card' | 'column' | 'board' | 'document' | 'agent' | 'project' | 'knowledge_base';
  entity_id: string;

  action: string;
  actor_id: string | null;
  actor_name?: string | null;
  actor_kind?: 'user' | 'agent' | null;
  payload: any;
  created_at: string;
}

export interface ProjectSummary {
  project_id: string;
  name: string;
  description: string | null;
  board_count: number;
  card_count: number;
  not_done_card_count?: number;
  agent_count: number;
  active_agent_count: number;
  document_count: number;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  is_global: number;
  created_at: string;
  updated_at: string;
  linked_project_ids?: string[];
}

export interface KBEntity {
  id: string;
  kb_id: string;
  name: string;
  type: string;
  identifier: string | null;
  metadata: any;
  created_at: string;
  updated_at: string;
}

export interface KBFact {
  id: string;
  kb_id: string;
  entity_id: string | null;
  title: string;
  content: string;
  category: string;
  confidence: number;
  source_principal_id: string | null;
  created_at: string;
  updated_at: string;
  entity_name?: string;
  entity_identifier?: string;
}

export type KBFactSummary = Omit<KBFact, 'content'>;

export interface KBRelation {
  id: string;
  kb_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  description: string | null;
  created_at: string;
  source_entity_name?: string;
  target_entity_name?: string;
}

export interface EntityKnowledgeResult {
  entity: KBEntity;
  facts: KBFact[];
  outgoing_relations: KBRelation[];
  incoming_relations: KBRelation[];
}

export interface KBGraphNode {
  id: string;
  name: string;
  type: string;
  identifier: string | null;
  kb_id: string;
  fact_count: number;
}

export interface KBGraphLink {
  id: string;
  source: string;
  target: string;
  relation_type: string;
  description: string | null;
}

export interface KBGraphTree {
  nodes: KBGraphNode[];
  links: KBGraphLink[];
}

/** Response shape of GET /auth/me — the signed-in state of the current browser session. */
export interface AuthMe {
  authenticated: boolean;
  admitted: boolean;
  user: { id: string; email: string | null; display_name: string; avatar_url: string | null; status: string } | null;
  role: string | null;
  workspace: { id: string; name: string } | null;
  auth_mode: 'open' | 'enforced';
}

export interface Role {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  is_system: number;
  rank: number;
}

export interface Invitation {
  id: string;
  workspace_id: string;
  email: string;
  role_id: string;
  expires_at: string;
  accepted_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface CreatedInvitation extends Invitation {
  token: string;
}

/** What the `muster login` device-approval screen shows before the user approves. */
export interface DeviceGrantInfo {
  user_code: string;
  workspace_name: string | null;
  principal_display_name: string | null;
  role_name: string | null;
}

/** What the MCP-native OAuth consent screen shows before the user picks an agent identity + role. */
export interface McpAuthorizeDetails {
  client_name: string;
  resource: string;
  agents: { id: string; name: string; role_id: string | null }[];
  roles: { id: string; name: string }[];
}

/** A privileged-action audit record (MUS-30) — security trail, never client-writable. */
export interface AuditRecord {
  id: string;
  workspace_id: string | null;
  actor_id: string | null;
  actor_kind: 'user' | 'agent' | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}

export interface ApiToken {
  id: string;
  principal_id: string;
  workspace_id: string;
  name: string;
  prefix: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/** Returned only once, on creation — the plaintext secret is never retrievable again. */
export interface CreatedApiToken extends ApiToken {
  token: string;
}
