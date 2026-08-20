export type AppTab = 'board' | 'agents' | 'docs' | 'activity' | 'kb' | 'tokens' | 'admin';

export interface AppLocation {
  projectSlug: string | null;
  tab: AppTab;
  boardSlug: string | null;
  docId: string | null;
  entityId: string | null;
  cardReference: string | null;
}

export type KnowledgeView = 'explore' | 'facts' | 'entities' | 'graph';

export interface KnowledgeUrlState {
  view: KnowledgeView;
  scope: string;
  query: string;
  category: string;
  entityType: string;
  attached: 'all' | 'attached' | 'unattached';
  hasSource: 'all' | 'with-source' | 'without-source';
  entityId: string | null;
  factId: string | null;
  depth: number;
}

const VALID_TABS: readonly AppTab[] = ['board', 'agents', 'docs', 'activity', 'kb', 'tokens', 'admin'];

export function parseAppLocation(pathname: string): AppLocation {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'cards' && parts[1]) {
    let cardReference = parts[1];
    try {
      cardReference = decodeURIComponent(cardReference);
    } catch {
      // Leave malformed encodings untouched; the validated API boundary will
      // reject them without making browser route parsing throw.
    }
    return {
      projectSlug: null,
      tab: 'board',
      boardSlug: null,
      docId: null,
      entityId: null,
      cardReference,
    };
  }
  if (parts[0] === 'projects' && parts[1]) {
    const projectSlug = parts[1];
    const rawTab = parts[2];
    const tab = VALID_TABS.includes(rawTab as AppTab) ? rawTab as AppTab : 'board';
    return {
      projectSlug,
      tab,
      boardSlug: tab === 'board' && parts[3] ? parts[3] : null,
      docId: tab === 'docs' && parts[3] ? parts[3] : null,
      entityId: tab === 'kb' && parts[3] ? parts[3] : null,
      cardReference: null,
    };
  }
  return { projectSlug: null, tab: 'board', boardSlug: null, docId: null, entityId: null, cardReference: null };
}

export function buildAppPath(
  projectSlug: string,
  tab: AppTab,
  options: { docId?: string | null; entityId?: string | null; boardSlug?: string | null } = {},
): string {
  let targetPath = `/projects/${projectSlug}/${tab}`;
  if (tab === 'board' && options.boardSlug) targetPath += `/${options.boardSlug}`;
  else if (tab === 'docs' && options.docId) targetPath += `/${options.docId}`;
  else if (tab === 'kb' && options.entityId) targetPath += `/${options.entityId}`;
  return targetPath;
}

export function readBrowserLocation(): AppLocation {
  return parseAppLocation(window.location.pathname);
}

const KNOWLEDGE_VIEWS: readonly KnowledgeView[] = ['explore', 'facts', 'entities', 'graph'];

function parseKnowledgeBoolean(value: string | null): 'all' | 'attached' | 'unattached' {
  if (value === 'attached' || value === 'unattached') return value;
  return 'all';
}

function parseKnowledgeSource(value: string | null): 'all' | 'with-source' | 'without-source' {
  if (value === 'with-source' || value === 'without-source') return value;
  return 'all';
}

export function parseKnowledgeUrl(search: string): KnowledgeUrlState {
  const params = new URLSearchParams(search);
  const rawView = params.get('kb_view');
  const rawDepth = Number(params.get('kb_depth') || 1);
  return {
    view: KNOWLEDGE_VIEWS.includes(rawView as KnowledgeView) ? rawView as KnowledgeView : 'explore',
    scope: params.get('kb_scope') || 'all',
    query: params.get('kb_q') || '',
    category: params.get('kb_category') || '',
    entityType: params.get('kb_entity_type') || '',
    attached: parseKnowledgeBoolean(params.get('kb_attached')),
    hasSource: parseKnowledgeSource(params.get('kb_source')),
    entityId: params.get('kb_entity') || null,
    factId: params.get('kb_fact') || null,
    depth: Number.isFinite(rawDepth) ? Math.min(2, Math.max(1, Math.trunc(rawDepth))) : 1,
  };
}

export function buildKnowledgeSearch(state: KnowledgeUrlState): string {
  const params = new URLSearchParams();
  if (state.view !== 'explore') params.set('kb_view', state.view);
  if (state.scope !== 'all') params.set('kb_scope', state.scope);
  if (state.query) params.set('kb_q', state.query);
  if (state.category) params.set('kb_category', state.category);
  if (state.entityType) params.set('kb_entity_type', state.entityType);
  if (state.attached !== 'all') params.set('kb_attached', state.attached);
  if (state.hasSource !== 'all') params.set('kb_source', state.hasSource);
  if (state.entityId) params.set('kb_entity', state.entityId);
  if (state.factId) params.set('kb_fact', state.factId);
  if (state.depth > 1) params.set('kb_depth', String(state.depth));
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export function updateKnowledgeBrowserLocation(state: KnowledgeUrlState, replace = true): void {
  const search = buildKnowledgeSearch(state);
  const target = `${window.location.pathname}${search}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current === target) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', target);
}

export function updateBrowserLocation(
  projectSlug: string | null,
  tab: AppTab,
  options: { docId?: string | null; entityId?: string | null; boardSlug?: string | null; replace?: boolean } = {},
): void {
  if (!projectSlug) return;
  const targetPath = buildAppPath(projectSlug, tab, options);
  if (window.location.pathname === targetPath) return;
  const operation = options.replace ? 'replaceState' : 'pushState';
  window.history[operation](null, '', targetPath);
}
