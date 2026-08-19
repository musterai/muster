// File: src/web/api.ts
import { Project, Board, Column, Card, CardSummary, CardDetails, Document, DocumentSummary, DocumentVersion, DocumentVersionSummary, Agent, User, AuthMe, Role, Invitation, CreatedInvitation, DeviceGrantInfo, McpAuthorizeDetails, AuditRecord, Event, ProjectSummary, Label, KnowledgeBase, KBEntity, KBFact, KBFactSummary, KBRelation, EntityKnowledgeResult, KBGraphTree, CardLinkRelationType, CreateCardWorkLink, ApiToken, CreatedApiToken, Page } from './types.js';

const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Present only when this SPA is being served by `muster connect` (MUS-27) —
 * the local proxy injects it into index.html. `muster serve` never sets it,
 * so this is a no-op there. See src/connect/proxy.ts.
 */
export function getLocalProxyToken(): string | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector('meta[name="muster-local-token"]')?.getAttribute('content') || null;
}

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const localToken = getLocalProxyToken();
  if (localToken) {
    headers['Authorization'] = `Bearer ${localToken}`;
  }

  const res = await fetch(`${API_BASE}${url}`, {
    headers: {
      ...headers,
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const errText = await res.text();
    let body: { error?: string; message?: string; code?: string; details?: Record<string, unknown> } | null = null;
    try {
      body = JSON.parse(errText);
    } catch {
      // Keep the raw response text when the server did not return JSON.
    }
    const message = body?.message || body?.error || errText || `Request failed with status ${res.status}`;
    throw new ApiError(res.status, message, body?.code, body?.details);
  }

  if (res.status === 204) {
    return {} as T;
  }

  return res.json();
}

/** Follow only server-issued opaque cursors; every individual response stays bounded. */
async function fetchAllPages<T>(url: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const separator = url.includes('?') ? '&' : '?';
    const response: Page<T> = await fetchJSON<Page<T>>(`${url}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    items.push(...response.items);
    cursor = response.page.has_more ? response.page.next_cursor : null;
    if (response.page.has_more && !cursor) throw new Error('Paginated response omitted its continuation cursor');
  } while (cursor);
  return items;
}

type AllBoardsPage = Board & {
  boards: Board[];
  columns: Column[];
  cards: CardSummary[];
  board_page: Page<Board>['page'];
};

async function fetchAllBoardPages(projectId: string): Promise<AllBoardsPage> {
  let cursor: string | null = null;
  let first: AllBoardsPage | null = null;
  const boards: Board[] = [];
  const columns: Column[] = [];
  do {
    const response: AllBoardsPage = await fetchJSON(`/projects/${projectId}/all-boards?limit=100&include_cards=false${cursor ? `&board_cursor=${encodeURIComponent(cursor)}` : ''}`);
    first ||= response;
    boards.push(...response.boards);
    columns.push(...response.columns);
    cursor = response.board_page.has_more ? response.board_page.next_cursor : null;
    if (response.board_page.has_more && !cursor) throw new Error('All Boards response omitted its board continuation cursor');
  } while (cursor);
  if (!first) throw new Error('All Boards response was empty');
  return { ...first, boards, columns, cards: [], board_page: { ...first.board_page, has_more: false, next_cursor: null } };
}

export const api = {
  // Projects
  getProjects: () => fetchAllPages<Project>('/projects'),
  createProject: (data: { name: string; description?: string }) => fetchJSON<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  getProjectSummary: (id: string) => fetchJSON<ProjectSummary>(`/projects/${id}/summary`),
  updateProject: (id: string, data: { name?: string; description?: string }) =>
    fetchJSON<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProject: (id: string) => fetchJSON<void>(`/projects/${id}`, { method: 'DELETE' }),

  // Boards
  getBoards: (projectId: string) => fetchAllPages<Board>(`/projects/${projectId}/boards`),
  createBoard: (projectId: string, name: string, template?: 'simple' | 'standard', columns?: string[]) =>
    fetchJSON<Board>(`/projects/${projectId}/boards`, { method: 'POST', body: JSON.stringify({ name, template, columns }) }),
  getBoardDetails: async (id: string, projectId?: string) => {
    if (id === 'all' && projectId) {
      const details = await fetchAllBoardPages(projectId);
      const cards = await fetchAllPages<CardSummary>(`/projects/${projectId}/cards`);
      return { ...details, cards: cards as Card[] };
    }
    const details = await fetchJSON<Board & { columns: Column[]; cards: CardSummary[] }>(`/boards/${id}?limit=100`);
    const cards = await fetchAllPages<CardSummary>(`/boards/${id}/cards`);
    return { ...details, cards: cards as Card[] };
  },
  getAllBoardsDetails: async (projectId: string) => {
    const details = await fetchAllBoardPages(projectId);
    const cards = await fetchAllPages<CardSummary>(`/projects/${projectId}/cards`);
    return { ...details, cards: cards as Card[] };
  },
  updateBoard: (id: string, name: string) => fetchJSON<Board>(`/boards/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteBoard: (id: string) => fetchJSON<void>(`/boards/${id}`, { method: 'DELETE' }),

  // Columns
  createColumn: (boardId: string, name: string, wipLimit?: number, isTerminal?: boolean) => fetchJSON<Column>(`/boards/${boardId}/columns`, { method: 'POST', body: JSON.stringify({ name, wip_limit: wipLimit, is_terminal: isTerminal }) }),
  updateColumn: (id: string, data: Partial<Column>) => fetchJSON<Column>(`/columns/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  moveColumn: (id: string, position: string) => fetchJSON<Column>(`/columns/${id}`, { method: 'PUT', body: JSON.stringify({ position }) }),
  deleteColumn: (id: string) => fetchJSON<void>(`/columns/${id}`, { method: 'DELETE' }),

  // Cards
  getCards: (boardId: string) => fetchAllPages<CardSummary>(`/boards/${boardId}/cards`) as Promise<Card[]>,
  createCard: (columnId: string, data: { title: string; description?: string; priority?: string; labels?: string[]; assignees?: string[]; is_epic?: boolean; operator_override?: boolean }) =>
    fetchJSON<Card>(`/columns/${columnId}/cards`, { method: 'POST', body: JSON.stringify(data) }),
  getCardDetails: (id: string) => fetchJSON<CardDetails>(`/cards/${id}`),
  updateCard: (id: string, data: Partial<Card> & { operator_override?: boolean }) => fetchJSON<CardDetails>(`/cards/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  moveCard: (id: string, targetColumnId: string, position?: string, operatorOverride?: boolean) =>
    fetchJSON<CardDetails>(`/cards/${id}/move`, { method: 'PATCH', body: JSON.stringify({ target_column_id: targetColumnId, position, operator_override: operatorOverride }) }),
  assignCard: (cardId: string, agentId: string) => fetchJSON<CardDetails>(`/cards/${cardId}/assignees`, { method: 'POST', body: JSON.stringify({ agent_id: agentId }) }),
  unassignCard: (cardId: string, agentId: string) => fetchJSON<CardDetails>(`/cards/${cardId}/assignees/${agentId}`, { method: 'DELETE' }),
  addComment: (cardId: string, authorId: string, content: string) => fetchJSON<any>(`/cards/${cardId}/comments`, { method: 'POST', body: JSON.stringify({ author_id: authorId, content }) }),
  updateComment: (cardId: string, commentId: string, content: string) =>
    fetchJSON<CardDetails['comments'][number]>(`/cards/${cardId}/comments/${commentId}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  deleteComment: (cardId: string, commentId: string) =>
    fetchJSON<void>(`/cards/${cardId}/comments/${commentId}`, { method: 'DELETE' }),
  linkDocument: (cardId: string, documentId: string) => fetchJSON<CardDetails>(`/cards/${cardId}/documents`, { method: 'POST', body: JSON.stringify({ document_id: documentId }) }),
  unlinkDocument: (cardId: string, documentId: string) => fetchJSON<CardDetails>(`/cards/${cardId}/documents/${documentId}`, { method: 'DELETE' }),
  searchCards: (projectId: string, query: string, excludeCardId?: string) => {
    let url = `/projects/${projectId}/cards/search?q=${encodeURIComponent(query)}`;
    if (excludeCardId) url += `&exclude_card_id=${excludeCardId}`;
    return fetchAllPages<CardSummary>(url) as Promise<Card[]>;
  },
  linkCard: (cardId: string, targetCardId: string, relationType: CardLinkRelationType) =>
    fetchJSON<CardDetails>(`/cards/${cardId}/links`, { method: 'POST', body: JSON.stringify({ target_card_id: targetCardId, relation_type: relationType }) }),
  unlinkCard: (cardId: string, linkId: string) => fetchJSON<CardDetails>(`/cards/${cardId}/links/${linkId}`, { method: 'DELETE' }),
  addWorkLink: (cardId: string, data: CreateCardWorkLink) =>
    fetchJSON<CardDetails>(`/cards/${cardId}/work-links`, { method: 'POST', body: JSON.stringify(data) }),
  removeWorkLink: (cardId: string, linkId: string) => fetchJSON<CardDetails>(`/cards/${cardId}/work-links/${linkId}`, { method: 'DELETE' }),
  deleteCard: (id: string) => fetchJSON<void>(`/cards/${id}`, { method: 'DELETE' }),


  // Documents
  getDocuments: async (projectId: string) => {
    const summaries = await fetchAllPages<DocumentSummary>(`/projects/${projectId}/documents`);
    return Promise.all(summaries.map(summary => api.getDocumentDetails(summary.id)));
  },
  createDocument: (projectId: string, data: { title: string; content: string; parent_id?: string; author_id?: string }) =>
    fetchJSON<Document>(`/projects/${projectId}/documents`, { method: 'POST', body: JSON.stringify(data) }),
  getDocumentDetails: (id: string) => fetchJSON<Document>(`/documents/${id}`),
  updateDocument: (id: string, data: { title?: string; content?: string; change_summary?: string; author_id?: string }) =>
    fetchJSON<Document>(`/documents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDocument: (id: string) => fetchJSON<{ success: boolean }>(`/documents/${id}`, { method: 'DELETE' }),
  setDocumentStatus: (id: string, status: 'in_review' | 'approved', expectedVersion: number) => fetchJSON<Document>(`/documents/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, expected_version: expectedVersion }) }),
  getDocumentHistory: async (id: string) => {
    const summaries = await fetchAllPages<DocumentVersionSummary>(`/documents/${id}/versions`);
    return Promise.all(summaries.map(async summary => {
      const document = await fetchJSON<Document>(`/documents/${id}?version=${summary.version}`);
      return { ...summary, content: document.content };
    }));
  },

  // Auth
  getMe: () => fetchJSON<AuthMe>('/auth/me'),
  setLocalIdentity: (identity: string | { displayName?: string; userId?: string }) => {
    const body: Record<string, string> = {};
    if (typeof identity === 'string') {
      body.display_name = identity;
    } else {
      if (identity.displayName) body.display_name = identity.displayName;
      if (identity.userId) body.user_id = identity.userId;
    }
    return fetchJSON<{ user: AuthMe['user'] }>('/auth/local', { method: 'POST', body: JSON.stringify(body) });
  },

  // Users (workspace members — humans only)
  getUsers: () => fetchAllPages<User>(`/users`),
  changeMemberRole: (workspaceId: string, userId: string, roleId: string) =>
    fetchJSON<User>(`/workspaces/${workspaceId}/members/${userId}`, { method: 'PUT', body: JSON.stringify({ role_id: roleId }) }),
  removeMember: (workspaceId: string, userId: string) =>
    fetchJSON<void>(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' }),

  // Roles
  getRoles: (workspaceId: string) => fetchAllPages<Role>(`/workspaces/${workspaceId}/roles`),
  createRole: (workspaceId: string, data: { key: string; name: string; description?: string; permissions: string[]; rank?: number }) =>
    fetchJSON<Role>(`/workspaces/${workspaceId}/roles`, { method: 'POST', body: JSON.stringify(data) }),
  updateRole: (id: string, data: { name?: string; description?: string; permissions?: string[]; rank?: number }) =>
    fetchJSON<Role>(`/roles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteRole: (id: string) => fetchJSON<void>(`/roles/${id}`, { method: 'DELETE' }),
  cloneRole: (id: string, newKey: string, newName?: string) =>
    fetchJSON<Role>(`/roles/${id}/clone`, { method: 'POST', body: JSON.stringify({ new_key: newKey, new_name: newName }) }),

  // Invitations
  getInvitations: (workspaceId: string) => fetchAllPages<Invitation>(`/workspaces/${workspaceId}/invitations`),
  createInvitation: (workspaceId: string, email: string, roleId: string) =>
    fetchJSON<CreatedInvitation>(`/workspaces/${workspaceId}/invitations`, { method: 'POST', body: JSON.stringify({ email, role_id: roleId }) }),
  revokeInvitation: (id: string) => fetchJSON<void>(`/invitations/${id}`, { method: 'DELETE' }),

  // Device Authorization Grant (MUS-28) — the `muster login` approval screen
  deviceLookup: (userCode: string) => fetchJSON<DeviceGrantInfo>(`/oauth/device/lookup?user_code=${encodeURIComponent(userCode)}`),
  deviceApprove: (userCode: string) => fetchJSON<{ message: string }>(`/oauth/device/approve`, { method: 'POST', body: JSON.stringify({ user_code: userCode }) }),
  deviceDeny: (userCode: string) => fetchJSON<{ message: string }>(`/oauth/device/deny`, { method: 'POST', body: JSON.stringify({ user_code: userCode }) }),

  // MCP-native OAuth (MUS-29) — the `claude mcp add` consent screen
  mcpAuthorizeDetails: async (queryString: string) => {
    const agents: McpAuthorizeDetails['agents'] = [];
    const roles: McpAuthorizeDetails['roles'] = [];
    let cursor: string | null = null;
    let first: McpAuthorizeDetails | null = null;
    do {
      const page: McpAuthorizeDetails = await fetchJSON(`/oauth/authorize/details?${queryString}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      first ||= page; agents.push(...page.agents); roles.push(...page.roles);
      cursor = page.page.has_more ? page.page.next_cursor : null;
      if (page.page.has_more && !cursor) throw new Error('OAuth details response omitted its continuation cursor');
    } while (cursor);
    if (!first) throw new Error('OAuth details response was empty');
    return { ...first, agents, roles, page: { ...first.page, has_more: false, next_cursor: null } };
  },
  mcpAuthorizeConsent: (payload: Record<string, string>) =>
    fetchJSON<{ redirect_uri: string }>(`/oauth/authorize/consent`, { method: 'POST', body: JSON.stringify(payload) }),

  // Audit log (MUS-30)
  getAuditLog: (workspaceId: string, filters: { actor_id?: string; action?: string } = {}) => {
    const qs = new URLSearchParams();
    if (filters.actor_id) qs.set('actor_id', filters.actor_id);
    if (filters.action) qs.set('action', filters.action);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return fetchAllPages<AuditRecord>(`/workspaces/${workspaceId}/audit-log${suffix}`);
  },

  // Agents & Settings
  getAgents: () => fetchAllPages<Agent>(`/agents`),
  registerAgent: (data: { name: string; capabilities?: string }) =>
    fetchJSON<Agent>(`/agents`, { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: { name?: string; capabilities?: string; status?: string; operator_user_id?: string | null; role_id?: string | null }) =>
    fetchJSON<Agent>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  unregisterAgent: (id: string) => fetchJSON<void>(`/agents/${id}`, { method: 'DELETE' }),
  agentHeartbeat: (id: string) => fetchJSON<Agent>(`/agents/${id}/heartbeat`, { method: 'POST' }),



  // Events
  getEvents: async (projectId: string, limit: number = 30) => {
    const page = await fetchJSON<Page<Event>>(`/projects/${projectId}/events?limit=${Math.min(Math.max(limit, 1), 100)}`);
    return page.items;
  },

  // Knowledge Base
  getKBs: (projectId?: string) => fetchAllPages<KnowledgeBase>(projectId ? `/kbs?project_id=${projectId}` : '/kbs'),
  createKB: (data: { name: string; description?: string; is_global?: boolean; project_ids?: string[] }) =>
    fetchJSON<KnowledgeBase>('/kbs', { method: 'POST', body: JSON.stringify(data) }),
  linkKB: (kbId: string, projectId: string) => fetchJSON<void>(`/kbs/${kbId}/link`, { method: 'POST', body: JSON.stringify({ project_id: projectId }) }),
  unlinkKB: (kbId: string, projectId: string) => fetchJSON<void>(`/kbs/${kbId}/unlink`, { method: 'POST', body: JSON.stringify({ project_id: projectId }) }),
  deleteKB: (id: string) => fetchJSON<void>(`/kbs/${id}`, { method: 'DELETE' }),
  searchKnowledge: (query: string, kbId?: string, projectId?: string) => {
    let url = `/kbs/search?q=${encodeURIComponent(query)}`;
    if (kbId) url += `&kb_id=${kbId}`;
    if (projectId) url += `&project_id=${projectId}`;
    return (async () => {
      const summaries: KBFactSummary[] = [];
      const entities: KBEntity[] = [];
      let cursor: string | null = null;
      do {
        const response: { facts: KBFactSummary[]; entities: KBEntity[]; page: Page<never>['page'] } = await fetchJSON(`${url}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        summaries.push(...response.facts);
        entities.push(...response.entities);
        cursor = response.page.has_more ? response.page.next_cursor : null;
      } while (cursor);
      const facts = await Promise.all(summaries.map(summary => api.getKBFact(summary.id)));
      return { facts, entities };
    })();
  },
  getGraphTree: async (kbId?: string, projectId?: string) => {
    let url = '/kbs/graph';
    if (kbId) url += `?kb_id=${kbId}`;
    else if (projectId) url += `?project_id=${projectId}`;
    const nodes: KBGraphTree['nodes'] = []; const links: KBGraphTree['links'] = [];
    let cursor: string | null = null; let first: KBGraphTree | null = null;
    do {
      const page: KBGraphTree = await fetchJSON(`${url}${url.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      first ||= page; nodes.push(...page.nodes); links.push(...page.links);
      cursor = page.page.has_more ? page.page.next_cursor : null;
    } while (cursor);
    return { ...(first as KBGraphTree), nodes, links, page: { ...(first as KBGraphTree).page, has_more: false, next_cursor: null } };
  },
  getEntityKnowledge: async (queryStr: string, kbId?: string) => {
    let url = `/kbs/entity-knowledge?q=${encodeURIComponent(queryStr)}`;
    if (kbId) url += `&kb_id=${kbId}`;
    const factSummaries: KBFactSummary[] = []; const outgoing: EntityKnowledgeResult['outgoing_relations'] = []; const incoming: EntityKnowledgeResult['incoming_relations'] = [];
    let cursor: string | null = null; let first: EntityKnowledgeResult | null = null;
    do {
      const page: EntityKnowledgeResult = await fetchJSON(`${url}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      first ||= page; factSummaries.push(...page.facts); outgoing.push(...page.outgoing_relations); incoming.push(...page.incoming_relations);
      cursor = page.page.has_more ? page.page.next_cursor : null;
    } while (cursor);
    if (!first) throw new Error('Entity knowledge response was empty');
    const facts = await Promise.all(factSummaries.map(f => api.getKBFact(f.id)));
    return { ...first, facts, outgoing_relations: outgoing, incoming_relations: incoming, page: { ...first.page, has_more: false, next_cursor: null } };
  },
  getKBFacts: async (kbId: string) => {
    const summaries = await fetchAllPages<KBFactSummary>(`/kbs/${kbId}/facts`);
    return Promise.all(summaries.map(summary => api.getKBFact(summary.id)));
  },
  getKBFact: (id: string) => fetchJSON<KBFact>(`/kbs/facts/${id}`),
  addFact: (data: { kb_id: string; title: string; content: string; category?: string; entity_name?: string; entity_identifier?: string; entity_type?: string }) =>
    fetchJSON<KBFact>('/kbs/facts', { method: 'POST', body: JSON.stringify(data) }),
  updateFact: (id: string, data: Partial<{ title: string; content: string; category: string; entity_name: string; entity_identifier: string; entity_type: string }>) =>
    fetchJSON<KBFact>(`/kbs/facts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteFact: (id: string) => fetchJSON<void>(`/kbs/facts/${id}`, { method: 'DELETE' }),
  upsertEntity: (data: { kb_id: string; name: string; type?: string; identifier?: string }) =>
    fetchJSON<KBEntity>('/kbs/entities', { method: 'POST', body: JSON.stringify(data) }),
  updateEntity: (id: string, data: Partial<{ name: string; type: string; identifier: string }>) =>
    fetchJSON<KBEntity>(`/kbs/entities/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  addRelation: (data: { kb_id: string; source_entity_id: string; target_entity_id: string; relation_type: string; description?: string }) =>
    fetchJSON<KBRelation>('/kbs/relations', { method: 'POST', body: JSON.stringify(data) }),

  // Personal Access Tokens
  getTokens: () => fetchAllPages<ApiToken>('/tokens'),
  createToken: (data: { name: string; expires_at?: string | null }) =>
    fetchJSON<CreatedApiToken>('/tokens', { method: 'POST', body: JSON.stringify(data) }),
  revokeToken: (id: string) => fetchJSON<{ message: string; id: string }>(`/tokens/${id}`, { method: 'DELETE' }),
};
