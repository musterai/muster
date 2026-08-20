// File: src/shared/types.ts
import type { AuthContext } from './auth-context.js';
import type { ColumnWorkflowRole, WorkflowConfigState } from './workflow-lane.js';

// ============================================================
// Identity & access control
// ============================================================

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
}

export type PrincipalKind = 'user' | 'agent';

export interface Principal {
  id: string;
  kind: PrincipalKind;
  created_at: string;
}

export interface User {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  status: 'active' | 'idle' | 'offline';
  created_at: string;
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
  created_at?: string;
}

export interface CreateRole {
  workspace_id: string;
  key: string;
  name: string;
  description?: string;
  permissions: string[];
  is_system?: boolean;
  rank?: number;
}

export interface UpdateRole {
  name?: string;
  description?: string;
  permissions?: string[];
  rank?: number;
}

export interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  status: 'active' | 'idle' | 'offline';
  last_seen_at: string;
  operator_user_id: string | null;
  role_id: string | null;
  workspace_id: string | null;
  created_at: string;
}

export interface RegisterAgent {
  id?: string;
  agent_id?: string;
  name?: string;
  capabilities?: string | string[];
  status?: 'active' | 'idle' | 'offline';
}

export interface UpdateAgent {
  name?: string;
  capabilities?: string | string[];
  status?: 'active' | 'idle' | 'offline';
  operator_user_id?: string | null;
  role_id?: string | null;
}

// ============================================================
// API Tokens (MUS-24)
// ============================================================

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

export interface CreateApiToken {
  principal_id: string;
  workspace_id: string;
  name: string;
  expires_at?: string | null;
}

/** Returned on token creation — the plaintext secret is shown exactly once. */
export interface CreatedApiToken extends ApiToken {
  token: string;
}

// ============================================================
// Projects & Boards
// ============================================================

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  key_prefix: string;
  card_seq: number;
  created_at: string;
  updated_at: string;
}

export interface CreateProject {
  name: string;
  description?: string;
}

export interface UpdateProject {
  name?: string;
  description?: string;
}

export interface Board {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
  /** Computed from the board's columns; exposed to management/read clients. */
  workflow_config_state?: WorkflowConfigState;
  /** Columns that still need explicit operator classification. */
  unclassified_column_ids?: string[];
}

export interface CreateBoardColumn {
  name: string;
  position?: string;
  wip_limit?: number | null;
  workflow_role?: ColumnWorkflowRole;
  /** Legacy compatibility projection; true maps to terminal. */
  is_terminal?: boolean | number;
}

export interface CreateBoard {
  project_id: string;
  name: string;
  columns?: Array<string | CreateBoardColumn>;
  template?: 'simple' | 'standard';
}

export interface UpdateBoard {
  name?: string;
}

export interface Column {
  id: string;
  board_id: string;
  name: string;
  position: string;
  wip_limit: number | null;
  /** Stable workflow semantics; NULL means the legacy board needs review. */
  workflow_role: ColumnWorkflowRole | null;
  /** Compatibility projection derived from workflow_role === terminal. */
  is_terminal: number;
}

export interface CreateColumn {
  board_id: string;
  name: string;
  position?: string;
  wip_limit?: number;
  workflow_role?: ColumnWorkflowRole;
  is_terminal?: boolean | number;
}

export interface UpdateColumn {
  name?: string;
  wip_limit?: number | null;
  position?: string;
  workflow_role?: ColumnWorkflowRole;
  is_terminal?: boolean | number;
  confirm_impact?: boolean;
}

// ============================================================
// Cards
// ============================================================

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
  claimed_by: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  is_epic: number;
  assignees?: CardAssignee[];
  parent_epic_id?: string | null;
  parent_epic_key?: string | null;
  parent_epic_title?: string | null;
  board_id?: string;
  board_name?: string;
  board_slug?: string;
}

/** Collection representation: large markdown bodies are detail-only. */
export type CardSummary = Omit<Card, 'description'>;

export interface ClaimCard {
  principal_id: string;
  ttl_seconds?: number;
}

export interface ClaimRefusal {
  success: false;
  reason: 'already_claimed';
  card_id: string;
  held_by: { id: string; name: string | null };
  claim_expires_at: string;
}

export interface CardOperationOptions {
  /** Set only when the caller explicitly requests an override and has authority to use it. */
  operatorOverride?: boolean;
  /**
   * Credential-derived request context used for tenant isolation and
   * row-level authorization. Internal/open-mode callers may omit it;
   * enforced transports must pass it.
   */
  auth?: AuthContext;
}

export interface CreateCard {
  column_id: string;
  title: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  position?: string;
  due_date?: string;
  labels?: string[];
  assignees?: string[];
  is_epic?: boolean;
}

export interface UpdateCard {
  title?: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  due_date?: string | null;
  archived?: number;
  is_epic?: boolean;
}

export interface MoveCard {
  target_column_id?: string;
  position?: string;
}

export interface Label {
  id: string;
  board_id: string;
  name: string;
  color: string;
}

export interface CreateLabel {
  board_id: string;
  name: string;
  color: string;
}

export interface Comment {
  id: string;
  card_id: string;
  author_id?: string;
  content: string;
  created_at: string;
  author_name?: string;
  author_kind?: 'user' | 'agent';
}

export interface CreateComment {
  card_id: string;
  author_id?: string;
  content: string;
}

// ============================================================
// Documents
// ============================================================

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

export interface CreateDocument {
  project_id: string;
  parent_id?: string;
  title: string;
  content: string;
  author_id?: string;
}

export interface UpdateDocument {
  title?: string;
  content?: string;
  change_summary?: string;
  author_id?: string;
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  version: number;
  title: string;
  content: string;
  author_id: string | null;
  change_summary: string | null;
  created_at: string;
  author_name?: string | null;
}

export type DocumentVersionSummary = Omit<DocumentVersion, 'content'>;

/** Document without its markdown body — cards embed this, never the full content. */
export type DocumentSummary = Omit<Document, 'content'>;

// ============================================================
// Events
// ============================================================

export interface Event {
  id: string;
  project_id: string;
  entity_type: 'project' | 'board' | 'column' | 'card' | 'document' | 'agent' | 'knowledge_base';
  entity_id: string;
  action: string;
  actor_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  actor_name?: string | null;
  actor_kind?: 'user' | 'agent' | null;
}

export interface CreateEvent {
  project_id: string;
  entity_type: 'project' | 'board' | 'column' | 'card' | 'document' | 'agent' | 'knowledge_base';
  entity_id: string;
  action: string;
  actor_id?: string;
  payload?: Record<string, unknown>;
}

// ============================================================
// Card details (aggregated)
// ============================================================

export interface CardDetails extends Card {
  assignees: CardAssignee[];
  labels: Label[];
  comments: Comment[];
  linked_documents: DocumentSummary[];
  linked_cards: LinkedCardSummary[];
  work_links: CardWorkLink[];
  /** Only computed for Epics with at least one child (null otherwise, including non-Epics — never "0/0"). `done` counts children currently sitting in a terminal column. */
  epic_progress: { total: number; done: number } | null;
  next_active_lane?: {
    id: string;
    board_id: string;
    name: string;
    position: string;
    workflow_role: 'active';
  } | null;
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

// Stored relation types are directional; 'blocked_by' and 'child_of' are the
// inverse views of 'blocks' and 'parent_of' respectively, and are never
// written to the database directly — see CardService.linkCard().
export type StoredCardLinkType = 'blocks' | 'relates_to' | 'duplicates' | 'parent_of';
export type CardLinkRelationType = StoredCardLinkType | 'blocked_by' | 'child_of';

export interface CardLink {
  id: string;
  source_card_id: string;
  target_card_id: string;
  relation_type: StoredCardLinkType;
  created_at: string;
}

export interface CreateCardLink {
  target_card_id: string;
  relation_type: CardLinkRelationType;
}

export interface LinkedCardSummary {
  id: string;
  relation_type: CardLinkRelationType;
  card: {
    id: string;
    key: string;
    title: string;
    column_id: string;
    /** The linked card's current lane name (e.g. "Done", "In Progress") — a quick read on where it stands without opening it. */
    column_name: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
    archived: number;
  };
}

// ============================================================
// Aggregates
// ============================================================

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
  kb_count?: number;
}

// ============================================================
// Knowledge Base
// ============================================================

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  is_global: number;
  created_at: string;
  updated_at: string;
  linked_project_ids?: string[];
}

export interface CreateKnowledgeBase {
  name: string;
  description?: string;
  is_global?: boolean;
  project_ids?: string[];
}

export interface KBEntity {
  id: string;
  kb_id: string;
  name: string;
  type: string;
  identifier: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertKBEntity {
  kb_id: string;
  name: string;
  type?: string;
  identifier?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateKBEntity {
  name?: string;
  type?: string;
  identifier?: string;
  metadata?: Record<string, unknown>;
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

/** Collection/search representation: potentially large fact content is detail-only. */
export type KBFactSummary = Omit<KBFact, 'content'>;

export interface KBReadScopeInput {
  kb_id?: string;
  project_id?: string;
}

export interface KBReadScopeSummary {
  kind: 'knowledge_base' | 'project';
  id: string;
  name: string;
  knowledge_base_count: number;
}

export interface KBIdentitySummary {
  id: string;
  name: string;
}

export interface KBEntityIdentitySummary {
  id: string;
  name: string;
  type: string;
  identifier: string | null;
}

export interface KBSourceSummary {
  principal_id: string;
  kind: string | null;
  display_name: string | null;
}

/** Bounded collection representation used by both REST and MCP reads. */
export interface KBFactBrowseSummary {
  id: string;
  title: string;
  excerpt: string;
  knowledge_base: KBIdentitySummary;
  category: string;
  confidence: number;
  entity: KBEntityIdentitySummary | null;
  source: KBSourceSummary | null;
  created_at: string;
  updated_at: string;
}

export interface KBFacetBucket {
  value: string;
  count: number;
  label?: string;
}

export interface KBBoundedFacet {
  items: KBFacetBucket[];
  has_more: boolean;
}

export interface KBKnowledgeOverview {
  scope: KBReadScopeSummary;
  totals: {
    facts: number;
    attached_facts: number;
    unattached_facts: number;
    entities: number;
    relations: number;
  };
  facets: {
    knowledge_bases: KBBoundedFacet;
    categories: KBBoundedFacet;
    entity_types: KBBoundedFacet;
    relation_types: KBBoundedFacet;
  };
}

export interface KBKnowledgeOverviewOptions {
  facet_limit?: number;
}

export interface KBBrowseFilters {
  q?: string;
  category?: string;
  entity_id?: string;
  entity_type?: string;
  attached?: boolean;
  has_source?: boolean;
}

export interface KBEntityListFilters {
  type?: string;
}

export interface KBEntityReference {
  entity_id?: string;
  query?: string;
}

export interface KBEntityContextOptions {
  depth?: number;
  max_nodes?: number;
  max_edges?: number;
  fact_cursor?: string;
  fact_limit?: number;
  relation_types?: string[];
  entity_types?: string[];
}

export interface KBEntitySummary extends KBEntityIdentitySummary {
  knowledge_base: KBIdentitySummary;
  fact_count: number;
  incoming_relation_count: number;
  outgoing_relation_count: number;
  created_at: string;
  updated_at: string;
}

export interface KBEntityCandidate extends KBEntityIdentitySummary {
  knowledge_base: KBIdentitySummary;
}

export interface KBEntityContextNode extends KBEntitySummary {
  depth: number;
}

export interface KBEntityContextEdge extends KBGraphLink {
  kb_id: string;
  created_at: string;
}

export interface KBEntityContext {
  scope: KBReadScopeSummary;
  root: KBEntityCandidate;
  facts: import('./pagination.js').Page<KBFactBrowseSummary>;
  nodes: KBEntityContextNode[];
  edges: KBEntityContextEdge[];
  depth: number;
  truncation: {
    truncated: boolean;
    node_limit: number;
    edge_limit: number;
    nodes_returned: number;
    edges_returned: number;
    expandable_entity_ids: string[];
  };
}

export interface AddGainedKnowledge {
  kb_id: string;
  title: string;
  content: string;
  category?: string;
  entity_id?: string;
  entity_name?: string;
  entity_type?: string;
  entity_identifier?: string;
  confidence?: number;
  source_principal_id?: string;
}

export interface UpdateKBFact {
  title?: string;
  content?: string;
  category?: string;
  entity_id?: string;
  entity_name?: string;
  entity_type?: string;
  entity_identifier?: string;
  confidence?: number;
}

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

export interface AddKBRelation {
  kb_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  description?: string;
}

// ============================================================
// Knowledge Graph response types
// ============================================================

export interface EntityKnowledgeResult {
  entity: Omit<KBEntity, 'metadata'>;
  facts: KBFactSummary[];
  outgoing_relations: Array<Omit<KBRelation, 'description'>>;
  incoming_relations: Array<Omit<KBRelation, 'description'>>;
  page: import('./pagination.js').PageInfo;
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
}

export interface KBGraphTree {
  nodes: KBGraphNode[];
  links: KBGraphLink[];
  page: import('./pagination.js').PageInfo;
}
