// File: src/web/components/KnowledgeBase.tsx
import React, { lazy, useState, useEffect, useMemo, useRef } from 'react';
import {
  KnowledgeBase as KBType,
  KBFact,
  KBFactBrowseSummary,
  KBKnowledgeOverview,
  KBEntity,
  KBEntityContext,
  KBEntitySummary,
  KBRelation,
  EntityKnowledgeResult,
  KBGraphTree,
  KBGraphNode,
  Project
} from '../types.js';
import { api } from '../api.js';
import { AccessibleDialog } from './AccessibleDialog.js';
import { LazyBoundary } from './LazyBoundary.js';
import { parseKnowledgeUrl, updateKnowledgeBrowserLocation, type KnowledgeUrlState } from '../navigation.js';
import { BookOpen, Plus, PlusCircle, Pencil, Trash2, X, Search, Filter, Network, ChevronRight, CircleAlert, SlidersHorizontal, Sparkles, ArrowUpRight, Link2 } from 'lucide-react';

const LazyKnowledgeConnections = lazy(() => import('./KnowledgeConnections.js'));

interface KnowledgeBaseProps {
  currentProject: Project | null;
  initialEntityId?: string | null;
  onSelectEntity?: (entityId: string | null) => void;
}

const EMPTY_GRAPH_TREE: KBGraphTree = {
  nodes: [],
  links: [],
  page: { limit: 100, has_more: false, next_cursor: null },
};

const EMPTY_OVERVIEW: KBKnowledgeOverview = {
  scope: { kind: 'project', id: '', name: '', knowledge_base_count: 0 },
  totals: { facts: 0, attached_facts: 0, unattached_facts: 0, entities: 0, relations: 0 },
  facets: {
    knowledge_bases: { items: [], has_more: false },
    categories: { items: [], has_more: false },
    entity_types: { items: [], has_more: false },
    relation_types: { items: [], has_more: false },
  },
};

const NO_PROJECT_SCOPE = '__no_project__';
const EXPLORE_PAGE_SIZE = 24;
const QUESTION_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'could', 'do', 'does', 'for', 'how', 'in',
  'is', 'it', 'of', 'on', 'please', 'tell', 'that', 'the', 'to', 'what',
  'when', 'where', 'which', 'who', 'why', 'with', 'would',
]);

/** Keep question-shaped searches useful on the current keyword endpoint. */
function normalizeKnowledgeQuery(value: string): string {
  const terms = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((term) => !QUESTION_WORDS.has(term));
  return (terms.length ? terms : value.trim().split(/\s+/).filter(Boolean)).join(' ');
}

function displayKnowledgeType(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatKnowledgeDate(value?: string): string {
  if (!value) return 'Date unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unknown' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function isAbortError(error: unknown): boolean {
  return (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isReadModelUnavailable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error && /failed to fetch|network|not found|method not allowed/i.test(error.message)) return true;
  return Boolean(error && typeof error === 'object' && 'status' in error && [404, 405].includes(Number((error as { status?: unknown }).status)));
}

function summaryAsFact(summary: KBFactBrowseSummary): KBFact {
  return {
    id: summary.id,
    kb_id: summary.knowledge_base.id,
    entity_id: summary.entity?.id ?? null,
    title: summary.title,
    content: summary.excerpt,
    category: summary.category,
    confidence: summary.confidence,
    source_principal_id: summary.source?.principal_id ?? null,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
    entity_name: summary.entity?.name,
    entity_identifier: summary.entity?.identifier ?? undefined,
  };
}

function factAsSummary(fact: KBFact, kbs: KBType[]): KBFactBrowseSummary {
  return {
    id: fact.id,
    title: fact.title,
    excerpt: fact.content,
    knowledge_base: { id: fact.kb_id, name: kbs.find((kb) => kb.id === fact.kb_id)?.name || fact.kb_id },
    category: fact.category,
    confidence: fact.confidence,
    entity: fact.entity_id ? {
      id: fact.entity_id,
      name: fact.entity_name || fact.entity_id,
      type: 'entity',
      identifier: fact.entity_identifier || null,
    } : null,
    source: null,
    created_at: fact.created_at,
    updated_at: fact.updated_at,
  };
}

function uniqueFacts(facts: KBFact[]): KBFact[] {
  return Array.from(new Map(facts.map((fact) => [fact.id, fact])).values());
}

function contextAsGraph(context: KBEntityContext): KBGraphTree {
  return {
    nodes: context.nodes.map((node) => ({
      id: node.id,
      kb_id: node.knowledge_base.id,
      name: node.name,
      type: node.type,
      identifier: node.identifier,
      fact_count: node.fact_count,
    })),
    links: context.edges,
    edges: context.edges,
    page: { limit: context.nodes.length, has_more: false, next_cursor: null },
    root_id: context.root.id,
    depth: context.depth,
    truncation: context.truncation,
    total_nodes: context.truncation.nodes_returned,
    total_links: context.truncation.edges_returned,
  };
}

export const KnowledgeBaseView: React.FC<KnowledgeBaseProps> = ({
  currentProject,
  initialEntityId,
  onSelectEntity,
}) => {

  const [kbs, setKbs] = useState<KBType[]>([]);
  const initialKnowledgeUrl = useMemo(
    () => (typeof window === 'undefined' ? parseKnowledgeUrl('') : parseKnowledgeUrl(window.location.search)),
    [],
  );
  const [selectedKbId, setSelectedKbId] = useState<string>(initialKnowledgeUrl.scope);
  const [viewMode, setViewMode] = useState<KnowledgeUrlState['view']>(initialKnowledgeUrl.view);
  const [browseOpen, setBrowseOpen] = useState<boolean>(initialKnowledgeUrl.view !== 'explore');
  const [showConnections, setShowConnections] = useState<boolean>(initialKnowledgeUrl.view === 'graph');

  const [searchQuery, setSearchQuery] = useState<string>(initialKnowledgeUrl.query);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');
  const [facts, setFacts] = useState<KBFact[]>([]);
  const [factSummaries, setFactSummaries] = useState<KBFactBrowseSummary[]>([]);
  const [overview, setOverview] = useState<KBKnowledgeOverview | null>(null);
  const [entities, setEntities] = useState<KBEntitySummary[]>([]);
  const [context, setContext] = useState<KBEntityContext | null>(null);
  const [selectedFact, setSelectedFact] = useState<KBFactBrowseSummary | null>(null);
  const [factDetailLoading, setFactDetailLoading] = useState(false);
  const [factDetailError, setFactDetailError] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [entitiesError, setEntitiesError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState(initialKnowledgeUrl.category);
  const [entityTypeFilter, setEntityTypeFilter] = useState(initialKnowledgeUrl.entityType);
  const [attachedFilter, setAttachedFilter] = useState<KnowledgeUrlState['attached']>(initialKnowledgeUrl.attached);
  const [sourceFilter, setSourceFilter] = useState<KnowledgeUrlState['hasSource']>(initialKnowledgeUrl.hasSource);
  const [contextDepth, setContextDepth] = useState(initialKnowledgeUrl.depth);
  const [graphTree, setGraphTree] = useState<KBGraphTree>(EMPTY_GRAPH_TREE);
  const [selectedEntity, setSelectedEntity] = useState<EntityKnowledgeResult | null>(null);
  const [kbsLoading, setKbsLoading] = useState<boolean>(true);
  const [kbsError, setKbsError] = useState<string | null>(null);
  const [factsLoading, setFactsLoading] = useState<boolean>(false);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [graphLoading, setGraphLoading] = useState<boolean>(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [loadedKbsForProject, setLoadedKbsForProject] = useState<string | null>(null);
  const [filtersExpanded, setFiltersExpanded] = useState<boolean>(Boolean(
    initialKnowledgeUrl.category
      || initialKnowledgeUrl.entityType
      || initialKnowledgeUrl.attached !== 'all'
      || initialKnowledgeUrl.hasSource !== 'all',
  ));

  const kbRequestRef = useRef(0);
  const kbAbortRef = useRef<AbortController | null>(null);
  const dataRequestRef = useRef(0);
  const dataAbortRef = useRef<AbortController | null>(null);
  const entitiesAbortRef = useRef<AbortController | null>(null);
  const contextAbortRef = useRef<AbortController | null>(null);
  const readModelAvailableRef = useRef<boolean | null>(null);
  const selectedFactRequestRef = useRef(0);
  const contextRequestRef = useRef(0);
  const overviewCacheRef = useRef<Map<string, KBKnowledgeOverview>>(new Map());

  // Modals
  const [showCreateKbModal, setShowCreateKbModal] = useState<boolean>(false);
  const [showAddFactModal, setShowAddFactModal] = useState<boolean>(false);
  const [showAddRelationModal, setShowAddRelationModal] = useState<boolean>(false);

  const [editingFact, setEditingFact] = useState<KBFact | null>(null);
  const [showEditFactModal, setShowEditFactModal] = useState<boolean>(false);

  const [editingEntity, setEditingEntity] = useState<KBEntity | null>(null);
  const [showEditEntityModal, setShowEditEntityModal] = useState<boolean>(false);

  // Form States
  const [newKbName, setNewKbName] = useState('');
  const [newKbDesc, setNewKbDesc] = useState('');
  const [newKbIsGlobal, setNewKbIsGlobal] = useState(false);

  const [newFactTitle, setNewFactTitle] = useState('');
  const [newFactContent, setNewFactContent] = useState('');
  const [newFactCategory, setNewFactCategory] = useState('constraint');
  const [newFactEntityName, setNewFactEntityName] = useState('');
  const [newFactEntityIdent, setNewFactEntityIdent] = useState('');

  // Edit Fact Form State
  const [editFactTitle, setEditFactTitle] = useState('');
  const [editFactContent, setEditFactContent] = useState('');
  const [editFactCategory, setEditFactCategory] = useState('constraint');
  const [editFactEntityName, setEditFactEntityName] = useState('');
  const [editFactEntityIdent, setEditFactEntityIdent] = useState('');

  // Edit Entity Form State
  const [editEntityName, setEditEntityName] = useState('');
  const [editEntityType, setEditEntityType] = useState('server');
  const [editEntityIdent, setEditEntityIdent] = useState('');

  const [relTargetEntityId, setRelTargetEntityId] = useState('');
  const [relType, setRelType] = useState('runs_on');
  const [relDesc, setRelDesc] = useState('');

  // Load KBs
  const loadKBs = async (resetData = false) => {
    const requestId = ++kbRequestRef.current;
    kbAbortRef.current?.abort();
    const controller = new AbortController();
    kbAbortRef.current = controller;
    const projectId = currentProject?.id;
    const projectScope = projectId || NO_PROJECT_SCOPE;

    if (resetData) {
      dataAbortRef.current?.abort();
      setSelectedKbId('all');
      setFacts([]);
      setFactSummaries([]);
      setOverview(null);
      setEntities([]);
      setContext(null);
      setSelectedFact(null);
      setBrowseError(null);
      setEntitiesError(null);
      setContextError(null);
      setGraphTree(EMPTY_GRAPH_TREE);
      setSelectedEntity(null);
      setLoadedKbsForProject(null);
      readModelAvailableRef.current = null;
      overviewCacheRef.current.clear();
    }

    try {
      setKbsLoading(true);
      setKbsError(null);
      const list = await api.getKBs(projectId, controller.signal);
      if (requestId !== kbRequestRef.current || controller.signal.aborted) return;
      setKbs(list);
      setLoadedKbsForProject(projectScope);
    } catch (err) {
      if (isAbortError(err) || requestId !== kbRequestRef.current) return;
      setKbsError(getErrorMessage(err, 'Knowledge bases could not be loaded.'));
      setKbs([]);
      setLoadedKbsForProject(projectScope);
    } finally {
      if (requestId === kbRequestRef.current && !controller.signal.aborted) {
        setKbsLoading(false);
      }
    }
  };

  const selectedScope = (): { kb_id?: string; project_id?: string } | null => {
    if (selectedKbId !== 'all') return { kb_id: selectedKbId };
    if (currentProject?.id) return { project_id: currentProject.id };
    return null;
  };

  const loadEntitiesData = async (scope: { kb_id?: string; project_id?: string }, signal?: AbortSignal) => {
    const requestId = ++contextRequestRef.current;
    entitiesAbortRef.current?.abort();
    const controller = signal ? null : new AbortController();
    const activeSignal = signal || controller!.signal;
    if (!signal) entitiesAbortRef.current = controller;
    setEntitiesLoading(true);
    setEntitiesError(null);
    try {
      if (readModelAvailableRef.current !== false) {
        const response = await api.listKnowledgeEntities(scope, {}, { limit: 100 }, activeSignal);
        if (requestId !== contextRequestRef.current || activeSignal.aborted) return;
        readModelAvailableRef.current = true;
        setEntities(response.items);
        return;
      }
      const tree = graphTree;
      const fallback = tree.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        identifier: node.identifier,
        knowledge_base: { id: node.kb_id, name: kbs.find((kb) => kb.id === node.kb_id)?.name || node.kb_id },
        fact_count: node.fact_count,
        incoming_relation_count: 0,
        outgoing_relation_count: 0,
        created_at: '',
        updated_at: '',
      }));
      if (requestId === contextRequestRef.current) setEntities(fallback);
    } catch (error) {
      if (isAbortError(error) || requestId !== contextRequestRef.current) return;
      if (isReadModelUnavailable(error)) {
        readModelAvailableRef.current = false;
        setEntities(graphTree.nodes.map((node) => ({
          id: node.id,
          name: node.name,
          type: node.type,
          identifier: node.identifier,
          knowledge_base: { id: node.kb_id, name: kbs.find((kb) => kb.id === node.kb_id)?.name || node.kb_id },
          fact_count: node.fact_count,
          incoming_relation_count: 0,
          outgoing_relation_count: 0,
          created_at: '',
          updated_at: '',
        })));
        return;
      }
      setEntitiesError(getErrorMessage(error, 'Knowledge entities could not be loaded.'));
    } finally {
      if (requestId === contextRequestRef.current && !activeSignal.aborted) setEntitiesLoading(false);
    }
  };

  const loadContextData = async (entityId: string, kbId?: string, depth = contextDepth) => {
    const requestId = ++contextRequestRef.current;
    contextAbortRef.current?.abort();
    const controller = new AbortController();
    contextAbortRef.current = controller;
    const scope = kbId ? { kb_id: kbId } : selectedScope();
    if (!scope) return;
    setContextLoading(true);
    setContextError(null);
    try {
      if (readModelAvailableRef.current !== false) {
        const nextContext = await api.getEntityContext(scope, { entity_id: entityId }, { depth, max_nodes: 50, max_edges: 200, fact_limit: 50 }, controller.signal);
        if (requestId !== contextRequestRef.current || controller.signal.aborted) return;
        readModelAvailableRef.current = true;
        setContext(nextContext);
        setGraphTree(contextAsGraph(nextContext));
        return;
      }
      const legacy = await api.getEntityKnowledge(entityId, kbId, controller.signal);
      if (requestId !== contextRequestRef.current || controller.signal.aborted) return;
      setSelectedEntity(legacy);
    } catch (error) {
      if (isAbortError(error) || requestId !== contextRequestRef.current) return;
      if (isReadModelUnavailable(error)) {
        readModelAvailableRef.current = false;
        try {
          const legacy = await api.getEntityKnowledge(entityId, kbId, controller.signal);
          if (requestId === contextRequestRef.current && !controller.signal.aborted) setSelectedEntity(legacy);
        } catch (legacyError) {
          if (!isAbortError(legacyError) && requestId === contextRequestRef.current) setContextError(getErrorMessage(legacyError, 'Entity context could not be loaded.'));
        }
      } else {
        setContextError(getErrorMessage(error, 'Entity context could not be loaded.'));
      }
    } finally {
      if (requestId === contextRequestRef.current && !controller.signal.aborted) setContextLoading(false);
    }
  };

  // Load the overview and first bounded fact page together. They are a single
  // Explore snapshot, while entities/context/graph remain independent resources.
  const refreshData = async () => {
    const projectId = currentProject?.id;
    const projectScope = projectId || NO_PROJECT_SCOPE;
    if (selectedKbId === 'all' && loadedKbsForProject !== projectScope) return;

    const requestId = ++dataRequestRef.current;
    dataAbortRef.current?.abort();
    const controller = new AbortController();
    dataAbortRef.current = controller;
    const scope = selectedScope();
    const search = normalizeKnowledgeQuery(debouncedSearchQuery);
    const kbIdFilter = selectedKbId === 'all' ? undefined : selectedKbId;
    const scopedKbs = kbIdFilter ? kbs.filter(kb => kb.id === kbIdFilter) : kbs;
    const scopeCacheKey = scope
      ? scope.kb_id ? `kb:${scope.kb_id}` : `project:${scope.project_id}`
      : null;
    const cachedOverview = scopeCacheKey ? overviewCacheRef.current.get(scopeCacheKey) : undefined;
    const isCurrent = () => requestId === dataRequestRef.current && !controller.signal.aborted;

    setFactsLoading(true);
    setFactsError(null);
    setBrowseError(null);
    setFactSummaries([]);
    setFacts([]);
    if (!cachedOverview) setOverview(null);
    else setOverview(cachedOverview);
    setGraphError(null);
    setGraphTree(EMPTY_GRAPH_TREE);
    setGraphLoading(false);

    if (scope && readModelAvailableRef.current !== false) {
      try {
        const browseFilters = {
          // REST calls this parameter q; keep the controller aligned with the
          // bounded browse/search contract instead of the legacy search route.
          q: search || undefined,
          category: categoryFilter || undefined,
          entity_type: entityTypeFilter || undefined,
          attached: attachedFilter === 'all' ? undefined : attachedFilter === 'attached',
          has_source: sourceFilter === 'all' ? undefined : sourceFilter === 'with-source',
        };
        const [readOverview, browsePage] = await Promise.all([
          cachedOverview || api.getKnowledgeOverview(scope, { facet_limit: 20 }, controller.signal),
          api.listKnowledge(scope, browseFilters, { limit: EXPLORE_PAGE_SIZE }, controller.signal),
        ]);
        if (!isCurrent()) return;
        readModelAvailableRef.current = true;
        if (!cachedOverview && scopeCacheKey) overviewCacheRef.current.set(scopeCacheKey, readOverview);
        setOverview(readOverview);
        setFactSummaries(browsePage.items);
        setFacts(browsePage.items.map(summaryAsFact));
        setFactsLoading(false);
        return;
      } catch (error) {
        if (isAbortError(error) || !isCurrent()) return;
        if (!isReadModelUnavailable(error)) {
          setBrowseError(getErrorMessage(error, 'Knowledge browse could not be loaded.'));
          setFactsError(getErrorMessage(error, 'Knowledge facts could not be loaded.'));
          setFactsLoading(false);
          return;
        }
        readModelAvailableRef.current = false;
      }
    }

    // Compatibility path for older servers and focused tests. It deliberately
    // never turns an empty query into a search request.
    const loadLegacyFacts = async () => {
      try {
        if (search) {
          if (kbIdFilter || scopedKbs.length === 0) {
            const result = await api.searchKnowledge(search, kbIdFilter, kbIdFilter ? undefined : projectId, controller.signal);
            if (isCurrent()) {
              setFacts(result.facts);
              setFactSummaries(result.facts.map((fact) => ({
                ...fact,
                excerpt: fact.content,
                knowledge_base: { id: fact.kb_id, name: kbs.find((kb) => kb.id === fact.kb_id)?.name || fact.kb_id },
                entity: fact.entity_id ? { id: fact.entity_id, name: fact.entity_name || fact.entity_id, type: 'entity', identifier: fact.entity_identifier || null } : null,
                source: null,
              })));
            }
            return;
          }
          const results = await Promise.allSettled(scopedKbs.map((kb) => api.searchKnowledge(search, kb.id, undefined, controller.signal)));
          if (!isCurrent()) return;
          const successfulFacts = uniqueFacts(results.flatMap((result) => result.status === 'fulfilled' ? result.value.facts : []));
          const failures = results.filter((result) => result.status === 'rejected' && !isAbortError(result.reason));
          setFacts(successfulFacts);
          setFactSummaries(successfulFacts.map((fact) => ({
            ...fact,
            excerpt: fact.content,
            knowledge_base: { id: fact.kb_id, name: kbs.find((kb) => kb.id === fact.kb_id)?.name || fact.kb_id },
            entity: fact.entity_id ? { id: fact.entity_id, name: fact.entity_name || fact.entity_id, type: 'entity', identifier: fact.entity_identifier || null } : null,
            source: null,
          })));
          if (failures.length) setFactsError(`${failures.length} knowledge base${failures.length === 1 ? '' : 's'} could not be searched.`);
          return;
        }
        if (kbIdFilter) {
          const list = await api.getKBFacts(kbIdFilter, controller.signal);
          if (isCurrent()) {
            setFacts(list);
            setFactSummaries(list.map((fact) => ({
              ...fact,
              excerpt: fact.content,
              knowledge_base: { id: fact.kb_id, name: kbs.find((kb) => kb.id === fact.kb_id)?.name || fact.kb_id },
              entity: fact.entity_id ? { id: fact.entity_id, name: fact.entity_name || fact.entity_id, type: 'entity', identifier: fact.entity_identifier || null } : null,
              source: null,
              })));
          }
          return;
        }
        const results = await Promise.allSettled(scopedKbs.map((kb) => api.getKBFacts(kb.id, controller.signal)));
        if (!isCurrent()) return;
        const successfulFacts = uniqueFacts(results.flatMap((result) => result.status === 'fulfilled' ? result.value : []));
        const failures = results.filter((result) => result.status === 'rejected' && !isAbortError(result.reason));
        setFacts(successfulFacts);
        setFactSummaries(successfulFacts.map((fact) => ({
          ...fact,
          excerpt: fact.content,
          knowledge_base: { id: fact.kb_id, name: kbs.find((kb) => kb.id === fact.kb_id)?.name || fact.kb_id },
          entity: fact.entity_id ? { id: fact.entity_id, name: fact.entity_name || fact.entity_id, type: 'entity', identifier: fact.entity_identifier || null } : null,
          source: null,
        })));
        if (failures.length) setFactsError(`${failures.length} knowledge base${failures.length === 1 ? '' : 's'} could not be loaded.`);
      } catch (error) {
        if (!isAbortError(error) && isCurrent()) setFactsError(getErrorMessage(error, 'Knowledge facts could not be loaded.'));
      } finally {
        if (isCurrent()) setFactsLoading(false);
      }
    };

    const loadLegacyGraph = async () => {
      if (viewMode !== 'graph') return;
      try {
        let trees: KBGraphTree[] = [];
        if (kbIdFilter) trees = [await api.getGraphTree(kbIdFilter, undefined, controller.signal)];
        else if (scopedKbs.length) {
          const results = await Promise.allSettled(scopedKbs.map((kb) => api.getGraphTree(kb.id, undefined, controller.signal)));
          if (!isCurrent()) return;
          trees = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
          const failures = results.filter((result) => result.status === 'rejected' && !isAbortError(result.reason));
          if (failures.length) setGraphError(`${failures.length} knowledge base${failures.length === 1 ? '' : 's'} graph${failures.length === 1 ? '' : 's'} could not be loaded.`);
        } else if (projectId) trees = [await api.getGraphTree(undefined, projectId, controller.signal)];
        if (!isCurrent()) return;
        const first = trees[0];
        setGraphTree(first ? { nodes: trees.flatMap((tree) => tree.nodes), links: trees.flatMap((tree) => tree.links), page: first.page } : EMPTY_GRAPH_TREE);
      } catch (error) {
        if (!isAbortError(error) && isCurrent()) setGraphError(getErrorMessage(error, 'Knowledge graph could not be loaded.'));
      } finally {
        if (isCurrent()) setGraphLoading(false);
      }
    };

    void loadLegacyFacts();
    if (viewMode === 'graph') void loadLegacyGraph();
  };

  useEffect(() => {
    void loadKBs(true);
    return () => {
      kbAbortRef.current?.abort();
      dataAbortRef.current?.abort();
      entitiesAbortRef.current?.abort();
      contextAbortRef.current?.abort();
    };
  }, [currentProject?.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery), 250);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    void refreshData();
    return () => dataAbortRef.current?.abort();
  }, [selectedKbId, debouncedSearchQuery, categoryFilter, entityTypeFilter, attachedFilter, sourceFilter, currentProject?.id, loadedKbsForProject, kbs]);

  // Legacy servers do not expose a bounded overview/context read model. Keep
  // their graph request on-demand so opening Explore never pays for the
  // secondary canvas resource.
  useEffect(() => {
    if (viewMode === 'graph' && readModelAvailableRef.current === false) void refreshData();
  }, [viewMode]);

  useEffect(() => {
    const syncUrl = () => {
      const next = parseKnowledgeUrl(window.location.search);
      setSelectedKbId(next.scope);
      setViewMode(next.view);
      setBrowseOpen(next.view === 'facts' || next.view === 'entities');
      setShowConnections(next.view === 'graph');
      setSearchQuery(next.query);
      setCategoryFilter(next.category);
      setEntityTypeFilter(next.entityType);
      setAttachedFilter(next.attached);
      setSourceFilter(next.hasSource);
      setContextDepth(next.depth);
      if (next.entityId && next.entityId !== selectedEntity?.entity.id) void loadContextData(next.entityId);
    };
    window.addEventListener('popstate', syncUrl);
    return () => window.removeEventListener('popstate', syncUrl);
  }, [selectedEntity?.entity.id]);

  useEffect(() => {
    const scope = selectedScope();
    if (scope && viewMode === 'entities' && readModelAvailableRef.current !== false) void loadEntitiesData(scope);
  }, [selectedKbId, currentProject?.id, viewMode, loadedKbsForProject]);

  useEffect(() => {
    const urlState = typeof window === 'undefined' ? parseKnowledgeUrl('') : parseKnowledgeUrl(window.location.search);
    const entityId = initialEntityId || urlState.entityId;
    if (entityId) {
      setViewMode(urlState.view === 'explore' ? 'graph' : urlState.view);
      setShowConnections(true);
      void loadContextData(entityId);
    }
  }, [initialEntityId]);


  const handleCreateKB = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKbName.trim()) return;
    try {
      const created = await api.createKB({
        name: newKbName,
        description: newKbDesc,
        is_global: newKbIsGlobal,
        project_ids: currentProject ? [currentProject.id] : [],
      });
      setShowCreateKbModal(false);
      setNewKbName('');
      setNewKbDesc('');
      await loadKBs();
      setSelectedKbId(created.id);
    } catch (err) {
      console.error('Failed to create KB:', err);
    }
  };

  const handleAddFact = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetKbId = selectedKbId !== 'all' ? selectedKbId : (selectedEntity?.entity.kb_id || context?.root.knowledge_base.id || kbs[0]?.id);
    if (!targetKbId || !newFactTitle.trim() || !newFactContent.trim()) return;

    try {
      await api.addFact({
        kb_id: targetKbId,
        title: newFactTitle,
        content: newFactContent,
        category: newFactCategory,
        entity_name: newFactEntityName || undefined,
        entity_identifier: newFactEntityIdent || undefined,
      });
      setShowAddFactModal(false);
      setNewFactTitle('');
      setNewFactContent('');
      setNewFactEntityName('');
      setNewFactEntityIdent('');
      await refreshData();
      if (selectedEntity) {
        const updated = await api.getEntityKnowledge(selectedEntity.entity.id, selectedEntity.entity.kb_id);
        setSelectedEntity(updated);
      }
    } catch (err) {
      console.error('Failed to add fact:', err);
    }
  };

  const handleOpenAddFactForEntity = (entity: KBEntity) => {
    setNewFactEntityName(entity.name);
    setNewFactEntityIdent(entity.identifier || '');
    setNewFactTitle('');
    setNewFactContent('');
    setShowAddFactModal(true);
  };


  const handleOpenEditFact = (fact: KBFact) => {
    setEditingFact(fact);
    setEditFactTitle(fact.title);
    setEditFactContent(fact.content);
    setEditFactCategory(fact.category);
    setEditFactEntityName(fact.entity_name || '');
    setEditFactEntityIdent(fact.entity_identifier || '');
    setShowEditFactModal(true);
  };

  const handleUpdateFact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingFact) return;

    try {
      await api.updateFact(editingFact.id, {
        title: editFactTitle,
        content: editFactContent,
        category: editFactCategory,
        entity_name: editFactEntityName || undefined,
        entity_identifier: editFactEntityIdent || undefined,
      });
      setShowEditFactModal(false);
      setEditingFact(null);
      await refreshData();
    } catch (err) {
      console.error('Failed to update fact:', err);
    }
  };

  const handleDeleteFact = async (factId: string) => {
    if (!confirm('Are you sure you want to delete this gained knowledge fact?')) return;
    try {
      await api.deleteFact(factId);
      await refreshData();
    } catch (err) {
      console.error('Failed to delete fact:', err);
    }
  };

  const handleOpenEditEntity = (entity: KBEntity) => {
    setEditingEntity(entity);
    setEditEntityName(entity.name);
    setEditEntityType(entity.type);
    setEditEntityIdent(entity.identifier || '');
    setShowEditEntityModal(true);
  };

  const handleUpdateEntity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingEntity) return;

    try {
      await api.updateEntity(editingEntity.id, {
        name: editEntityName,
        type: editEntityType,
        identifier: editEntityIdent || undefined,
      });
      setShowEditEntityModal(false);
      setEditingEntity(null);
      await refreshData();
    } catch (err) {
      console.error('Failed to update entity:', err);
    }
  };

  const updateKnowledgeUrl = (changes: Partial<KnowledgeUrlState>, replace = true) => {
    const current = typeof window === 'undefined' ? parseKnowledgeUrl('') : parseKnowledgeUrl(window.location.search);
    updateKnowledgeBrowserLocation({
      ...current,
      view: changes.view ?? viewMode,
      scope: changes.scope ?? selectedKbId,
      query: changes.query ?? searchQuery,
      category: changes.category ?? categoryFilter,
      entityType: changes.entityType ?? entityTypeFilter,
      attached: changes.attached ?? attachedFilter,
      hasSource: changes.hasSource ?? sourceFilter,
      entityId: changes.entityId === undefined ? (selectedEntity?.entity.id ?? current.entityId) : changes.entityId,
      factId: changes.factId === undefined ? (selectedFact?.id ?? current.factId) : changes.factId,
      depth: changes.depth ?? contextDepth,
    }, replace);
  };

  const handleSelectFact = async (summary: KBFactBrowseSummary) => {
    setSelectedFact(summary);
    setFactDetailError(null);
    setFactDetailLoading(true);
    const requestId = ++selectedFactRequestRef.current;
    updateKnowledgeUrl({ factId: summary.id }, false);
    try {
      const detail = await api.getKBFact(summary.id);
      if (requestId !== selectedFactRequestRef.current) return;
      setFacts((current) => {
        const rest = current.filter((fact) => fact.id !== detail.id);
        return [detail, ...rest];
      });
      setSelectedFact({ ...summary, excerpt: detail.content });
    } catch (error) {
      if (requestId === selectedFactRequestRef.current) setFactDetailError(getErrorMessage(error, 'Fact detail could not be loaded.'));
    } finally {
      if (requestId === selectedFactRequestRef.current) setFactDetailLoading(false);
    }
  };

  const handleSelectGraphNode = async (node: KBGraphNode) => {
    setViewMode('graph');
    setShowConnections(true);
    setBrowseOpen(false);
    setContextDepth(1);
    updateKnowledgeUrl({ view: 'graph', entityId: node.id, factId: null, depth: 1 }, false);
    if (onSelectEntity) onSelectEntity(node.id);
    await loadContextData(node.id, node.kb_id, 1);
  };

  const handleCloseInspector = () => {
    setSelectedEntity(null);
    setContext(null);
    setGraphTree(EMPTY_GRAPH_TREE);
    updateKnowledgeUrl({ entityId: null }, true);
    if (onSelectEntity) {
      onSelectEntity(null);
    }
  };


  const handleAddRelation = async (e: React.FormEvent) => {
    e.preventDefault();
    const sourceEntity = selectedEntity?.entity || (context ? {
      id: context.root.id,
      kb_id: context.root.knowledge_base.id,
      name: context.root.name,
      type: context.root.type,
      identifier: context.root.identifier,
      metadata: {},
      created_at: '',
      updated_at: '',
    } : null);
    if (!sourceEntity || !relTargetEntityId) return;

    try {
      await api.addRelation({
        kb_id: sourceEntity.kb_id,
        source_entity_id: sourceEntity.id,
        target_entity_id: relTargetEntityId,
        relation_type: relType,
        description: relDesc || undefined,
      });
      setShowAddRelationModal(false);
      setRelDesc('');
      if (selectedEntity) {
        const updated = await api.getEntityKnowledge(sourceEntity.id, sourceEntity.kb_id);
        setSelectedEntity(updated);
      } else {
        await loadContextData(sourceEntity.id, sourceEntity.kb_id, context?.depth || 1);
      }
      await refreshData();
    } catch (err) {
      console.error('Failed to add relation:', err);
    }
  };

  const handleSelectEntitySummary = (entity: KBEntitySummary | KBGraphNode) => {
    const kbId = 'kb_id' in entity ? entity.kb_id : entity.knowledge_base.id;
    setViewMode('entities');
    // Browsing is the discovery surface; once a subject is chosen, collapse it
    // so its evidence drawer is immediately useful without another click.
    setBrowseOpen(false);
    setShowConnections(false);
    setContextDepth(1);
    updateKnowledgeUrl({ view: 'entities', entityId: entity.id, factId: null, depth: 1 }, false);
    if (onSelectEntity) onSelectEntity(entity.id);
    void loadContextData(entity.id, kbId, 1);
  };

  const handleRequestDepthTwo = () => {
    const entityId = context?.root.id || selectedEntity?.entity.id;
    if (!entityId) return;
    setContextDepth(2);
    updateKnowledgeUrl({ depth: 2, entityId }, false);
    void loadContextData(entityId, context?.root.knowledge_base.id || selectedEntity?.entity.kb_id, 2);
  };

  const handleChangeView = (nextView: KnowledgeUrlState['view']) => {
    setViewMode(nextView);
    setBrowseOpen(nextView === 'facts' || nextView === 'entities');
    setShowConnections(nextView === 'graph');
    updateKnowledgeUrl({ view: nextView }, false);
    if (nextView === 'entities') {
      const scope = selectedScope();
      if (scope) void loadEntitiesData(scope);
    }
  };

  const handleScopeChange = (scope: string) => {
    setSelectedKbId(scope);
    setSelectedEntity(null);
    setContext(null);
    setSelectedFact(null);
    setShowConnections(false);
    setBrowseOpen(false);
    updateKnowledgeUrl({ scope, entityId: null, factId: null }, false);
    if (onSelectEntity) onSelectEntity(null);
  };

  const displayedFactSummaries = factSummaries.length > 0
    ? factSummaries
    : facts.map((fact) => ({
      ...fact,
      excerpt: fact.content,
      knowledge_base: { id: fact.kb_id, name: kbs.find((kb) => kb.id === fact.kb_id)?.name || fact.kb_id },
      entity: fact.entity_id ? { id: fact.entity_id, name: fact.entity_name || fact.entity_id, type: 'entity', identifier: fact.entity_identifier || null } : null,
      source: null,
    }));
  const displayedGraph = context ? contextAsGraph(context) : graphTree;
  const exploreFactSummaries = displayedFactSummaries.slice(0, EXPLORE_PAGE_SIZE);
  const displayedEntities = entities.length > 0 ? entities : displayedGraph.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    identifier: node.identifier,
    knowledge_base: { id: node.kb_id, name: kbs.find((kb) => kb.id === node.kb_id)?.name || node.kb_id },
    fact_count: node.fact_count,
    incoming_relation_count: 0,
    outgoing_relation_count: 0,
    created_at: '',
    updated_at: '',
  }));

  const activeFactDetail = selectedFact ? facts.find((fact) => fact.id === selectedFact.id) : null;
  const contextInspectorEntity: KBEntity | null = context ? {
    id: context.root.id,
    kb_id: context.root.knowledge_base.id,
    name: context.root.name,
    type: context.root.type,
    identifier: context.root.identifier,
    metadata: {},
    created_at: '',
    updated_at: '',
  } : null;
  const contextInspectorFacts = context?.facts.items.map(summaryAsFact) ?? [];
  const projectSummaries = exploreFactSummaries.filter((summary) => !kbs.find((kb) => kb.id === summary.knowledge_base.id)?.is_global);
  const sharedSummaries = exploreFactSummaries.filter((summary) => Boolean(kbs.find((kb) => kb.id === summary.knowledge_base.id)?.is_global));
  const detailEntity = contextInspectorEntity || selectedEntity?.entity || null;
  const detailFacts = selectedEntity?.facts || contextInspectorFacts;
  const hasContext = Boolean(context || selectedEntity || displayedGraph.nodes.length > 0);

  const handleShowConnections = () => {
    const entityId = context?.root.id || selectedEntity?.entity.id;
    if (!entityId) return;
    setShowConnections(true);
    setBrowseOpen(false);
    setViewMode('graph');
    updateKnowledgeUrl({ view: 'graph', entityId, depth: context?.depth || contextDepth }, false);
  };

  const handleCloseConnections = () => {
    setShowConnections(false);
    setViewMode('explore');
    updateKnowledgeUrl({ view: 'explore' }, true);
  };

  const handleOpenSummaryEntity = (summary: KBFactBrowseSummary) => {
    if (!summary.entity) return;
    const matchingEntity = displayedEntities.find((entity) => entity.id === summary.entity?.id);
    handleSelectEntitySummary(matchingEntity || {
      id: summary.entity.id,
      name: summary.entity.name,
      type: summary.entity.type,
      identifier: summary.entity.identifier,
      knowledge_base: summary.knowledge_base,
      fact_count: 0,
      incoming_relation_count: 0,
      outgoing_relation_count: 0,
      created_at: summary.created_at,
      updated_at: summary.updated_at,
    });
  };

  const renderAnswerList = (summaries: KBFactBrowseSummary[], label: string) => (
    summaries.length === 0 ? null : (
      <ul className="divide-y divide-muster-border" aria-label={label}>
        {summaries.map((summary) => (
          <li key={summary.id} className="group flex min-w-0 items-stretch gap-2 py-1">
            <button
              type="button"
              onClick={() => void handleSelectFact(summary)}
              className="flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-3 text-left outline-none transition-colors hover:bg-muster-surface-hover focus-visible:bg-muster-surface-hover"
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-muster-border text-[10px] font-bold uppercase muster-accent" aria-hidden="true">
                {summary.category.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-sm font-semibold muster-text-primary">{summary.title}</span>
                  {summary.source && <span className="muster-badge muster-badge-success normal-case tracking-normal">Sourced</span>}
                </span>
                <span className="mt-1 block line-clamp-2 text-xs leading-relaxed muster-text-secondary">{summary.excerpt}</span>
                <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] muster-text-muted">
                  <span>{summary.knowledge_base.name}</span>
                  <span aria-hidden="true">·</span>
                  <span>{displayKnowledgeType(summary.category)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{Math.round(summary.confidence * 100)}% confidence</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatKnowledgeDate(summary.updated_at || summary.created_at)}</span>
                </span>
              </span>
              <ArrowUpRight className="mt-1 h-4 w-4 shrink-0 muster-text-faint" aria-hidden="true" />
            </button>
            {summary.entity && (
              <button
                type="button"
                className="muster-btn muster-btn-ghost my-2 mr-1 max-w-[9rem] shrink-0 self-start px-2 text-left text-[11px]"
                onClick={() => handleOpenSummaryEntity(summary)}
                title={`Open subject ${summary.entity.name}`}
              >
                <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{summary.entity.name}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    )
  );

  const categoryOptions = (
    <>
      <option value="constraint">Constraint</option>
      <option value="hardware">Hardware</option>
      <option value="network">Network / IP</option>
      <option value="config">Configuration</option>
      <option value="gotcha">Gotcha / Warning</option>
      <option value="general">General</option>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-2 sm:gap-4 sm:p-6">
      <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto" aria-labelledby="knowledge-home-title">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="muster-accent-bg muster-accent shrink-0 rounded-md border p-2.5" aria-hidden="true">
              <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] muster-accent">Knowledge</p>
              <h1 id="knowledge-home-title" className="mt-1 text-xl font-bold tracking-tight muster-text-primary sm:text-2xl">What do you need to know?</h1>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed muster-text-secondary sm:text-sm">Ask a question, scan the project ledger, or open evidence and connections when you need more context.</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <label htmlFor="knowledge-home-scope" className="sr-only">Knowledge scope</label>
            <select id="knowledge-home-scope" value={selectedKbId} onChange={(event) => handleScopeChange(event.target.value)} className="muster-input min-h-[44px] w-auto max-w-full cursor-pointer text-xs font-medium sm:text-sm">
              <option value="all">This project + shared knowledge</option>
              {kbs.map((kb: KBType) => <option key={kb.id} value={kb.id}>{kb.name}{kb.is_global ? ' · Shared' : ''}</option>)}
            </select>
            <button type="button" onClick={() => setShowCreateKbModal(true)} className="muster-btn muster-btn-secondary min-h-[44px] text-xs"><Plus className="h-3.5 w-3.5" />Manage</button>
            <button type="button" onClick={() => setShowAddFactModal(true)} className="muster-btn muster-btn-primary min-h-[44px] text-xs"><PlusCircle className="h-3.5 w-3.5" />Add knowledge</button>
          </div>
        </header>

        <section className="muster-panel muster-accent-border p-3 sm:p-4" aria-labelledby="knowledge-question-title">
          <div className="flex items-center gap-2 text-xs font-semibold muster-text-primary">
            <Sparkles className="h-4 w-4 muster-accent" aria-hidden="true" />
            <h2 id="knowledge-question-title">Ask the knowledge base</h2>
          </div>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 muster-text-muted" aria-hidden="true" />
            <label htmlFor="knowledge-home-search" className="sr-only">Ask what the team knows</label>
            <input
              id="knowledge-home-search"
              type="text"
              placeholder="Ask what the team knows…"
              value={searchQuery}
              onChange={(event) => { setSearchQuery(event.target.value); updateKnowledgeUrl({ query: event.target.value }, true); }}
              onKeyDown={(event) => { if (event.key === 'Escape' && searchQuery) { setSearchQuery(''); updateKnowledgeUrl({ query: '' }, true); } }}
              className="muster-input muster-input-lg w-full pl-10 pr-10 text-sm"
            />
            {searchQuery && (
              <button type="button" className="muster-btn muster-btn-icon muster-btn-ghost absolute right-1 top-1/2 -translate-y-1/2" aria-label="Clear knowledge question" onClick={() => { setSearchQuery(''); updateKnowledgeUrl({ query: '' }, true); }}>
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] muster-text-muted">
            <span>{overview?.totals.facts ?? '—'} answers in scope</span>
            <span aria-hidden="true">·</span>
            <span>{overview?.totals.entities ?? '—'} subjects</span>
            <span aria-hidden="true">·</span>
            <span>{overview?.totals.relations ?? '—'} connections</span>
            {factsLoading && <span role="status" aria-live="polite" className="muster-accent">Updating answers…</span>}
          </div>
        </section>

        {kbsError && <div role="alert" className="muster-badge muster-badge-danger flex w-full items-center justify-between gap-3 p-3 text-xs normal-case tracking-normal"><span>Knowledge bases could not be loaded: {kbsError}</span><button type="button" onClick={() => void loadKBs(false)} className="muster-btn muster-btn-danger-soft text-xs">Retry</button></div>}
        {browseError && <div role="alert" className="muster-badge muster-badge-danger flex items-center gap-2 p-3 text-xs normal-case tracking-normal"><CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />{browseError}<button type="button" onClick={() => void refreshData()} className="muster-btn muster-btn-secondary ml-auto text-xs">Retry</button></div>}
        {factsError && displayedFactSummaries.length > 0 && <div role="status" className="muster-badge muster-badge-warning p-3 text-xs normal-case tracking-normal">{factsError} Showing the answers that loaded successfully.</div>}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold muster-text-primary">{searchQuery.trim() ? `Answers for “${searchQuery.trim()}”` : 'Project knowledge'}</h2>
            <p className="mt-1 text-xs muster-text-muted">{searchQuery.trim() ? 'Concise answers first. Open one for evidence.' : 'Relevant knowledge first, with shared material clearly marked.'}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={`muster-btn min-h-[40px] text-xs ${browseOpen ? 'muster-btn-soft' : 'muster-btn-secondary'}`} aria-expanded={browseOpen} onClick={() => { setBrowseOpen((open) => !open); if (!browseOpen) setViewMode('facts'); }}>
              <SlidersHorizontal className="h-3.5 w-3.5" />Browse &amp; filters
            </button>
            {hasContext && <button type="button" className="muster-btn muster-btn-secondary min-h-[40px] text-xs" onClick={handleShowConnections}><Network className="h-3.5 w-3.5" />Show connections</button>}
          </div>
        </div>

        {!browseOpen && !showConnections && (
          <div className={selectedFact || detailEntity ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]' : ''}>
            <section className="muster-panel min-w-0 p-3 sm:p-4" aria-labelledby="knowledge-answers-title">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 id="knowledge-answers-title" className="text-xs font-semibold uppercase tracking-[0.14em] muster-text-muted">Answer ledger</h3>
                <span className="text-xs muster-text-faint">{exploreFactSummaries.length}{overview && overview.totals.facts > exploreFactSummaries.length ? ` of ${overview.totals.facts}` : ''} shown</span>
              </div>
              {factsLoading && exploreFactSummaries.length === 0 ? <div className="space-y-3 py-3" role="status" aria-live="polite">{[1, 2, 3].map((item) => <div key={item} className="animate-pulse border-b border-muster-border py-4"><div className="h-3 w-2/3 rounded bg-muster-surface-hover" /><div className="mt-2 h-2 w-full rounded bg-muster-surface-hover" /><div className="mt-2 h-2 w-1/2 rounded bg-muster-surface-hover" /></div>)}</div> : factsError && exploreFactSummaries.length === 0 ? <div className="py-10 text-center" role="alert"><p className="text-sm muster-text-danger">{factsError}</p><button type="button" onClick={() => void refreshData()} className="muster-btn muster-btn-secondary mt-3 text-xs">Retry</button></div> : exploreFactSummaries.length === 0 ? <div className="py-12 text-center"><BookOpen className="mx-auto h-7 w-7 muster-text-faint" aria-hidden="true" /><p className="mt-2 text-sm font-medium muster-text-primary">{searchQuery.trim() ? 'No answers match this question' : 'No knowledge has been added yet'}</p><p className="mt-1 text-xs muster-text-muted">{searchQuery.trim() ? 'Try a few meaningful terms, or clear the question to browse.' : 'Add the first operational learning for this project.'}</p>{searchQuery.trim() ? <button type="button" className="muster-btn muster-btn-secondary mt-3 text-xs" onClick={() => { setSearchQuery(''); updateKnowledgeUrl({ query: '' }, true); }}>Clear question</button> : <button type="button" className="muster-btn muster-btn-primary mt-3 text-xs" onClick={() => setShowAddFactModal(true)}>Add knowledge</button>}</div> : (
                <>
                  {projectSummaries.length > 0 && <div className="mb-1"><p className="px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] muster-accent">Project knowledge</p>{renderAnswerList(projectSummaries, 'Project knowledge answers')}</div>}
                  {sharedSummaries.length > 0 && <div className="mt-3"><p className="border-t border-muster-border px-2 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] muster-text-muted">Shared knowledge</p>{renderAnswerList(sharedSummaries, 'Shared knowledge answers')}</div>}
                </>
              )}
            </section>

            {selectedFact && (
              <aside className="muster-panel muster-accent-border min-w-0 self-start p-4 lg:sticky lg:top-0" aria-labelledby="knowledge-answer-detail-title">
                <div className="flex items-start justify-between gap-3"><div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] muster-accent">Evidence</p><h3 id="knowledge-answer-detail-title" className="mt-1 text-base font-bold muster-text-primary">{selectedFact.title}</h3></div><button type="button" onClick={() => { setSelectedFact(null); updateKnowledgeUrl({ factId: null }, true); }} className="muster-btn muster-btn-icon muster-btn-ghost" aria-label="Close evidence"><X className="h-4 w-4" /></button></div>
                <div className="mt-3 space-y-3"><div className="flex flex-wrap gap-2 text-[11px] muster-text-muted"><span className="muster-chip">{selectedFact.knowledge_base.name}</span><span>{displayKnowledgeType(selectedFact.category)}</span><span>{Math.round(selectedFact.confidence * 100)}% confidence</span></div>{factDetailLoading ? <div role="status" className="space-y-2"><div className="h-3 animate-pulse rounded bg-muster-surface-hover" /><div className="h-3 animate-pulse rounded bg-muster-surface-hover" /><div className="h-3 w-2/3 animate-pulse rounded bg-muster-surface-hover" /></div> : factDetailError ? <div role="alert" className="text-xs muster-text-danger"><p>{factDetailError}</p><button type="button" onClick={() => void handleSelectFact(selectedFact)} className="muster-btn muster-btn-secondary mt-3 text-xs">Retry</button></div> : <p className="whitespace-pre-wrap text-sm leading-relaxed muster-text-secondary">{activeFactDetail?.content || selectedFact.excerpt}</p>}<p className="text-[11px] muster-text-muted">Updated {formatKnowledgeDate(selectedFact.updated_at || selectedFact.created_at)}</p>{activeFactDetail && <div className="flex flex-wrap gap-2"><button type="button" onClick={() => handleOpenEditFact(activeFactDetail)} className="muster-btn muster-btn-secondary text-xs"><Pencil className="h-3.5 w-3.5" />Edit</button><button type="button" onClick={() => void handleDeleteFact(activeFactDetail.id)} className="muster-btn muster-btn-danger-soft text-xs"><Trash2 className="h-3.5 w-3.5" />Delete</button></div>}</div>
              </aside>
            )}

            {!selectedFact && detailEntity && (
              <aside className="muster-panel muster-accent-border min-w-0 self-start p-4 lg:sticky lg:top-0" aria-labelledby="knowledge-subject-detail-title">
                <div className="flex items-start justify-between gap-3"><div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] muster-accent">Subject</p><h3 id="knowledge-subject-detail-title" className="mt-1 text-base font-bold muster-text-primary">{detailEntity.name}</h3>{detailEntity.identifier && <p className="mt-1 font-mono text-xs muster-text-muted">{detailEntity.identifier}</p>}</div><button type="button" onClick={handleCloseInspector} className="muster-btn muster-btn-icon muster-btn-ghost" aria-label="Close subject detail"><X className="h-4 w-4" /></button></div>
                <div className="mt-3 flex flex-wrap items-center gap-2"><span className="muster-badge muster-badge-neutral normal-case tracking-normal">{displayKnowledgeType(detailEntity.type)}</span><span className="muster-chip">{context?.root.knowledge_base.name || detailEntity.kb_id}</span></div>
                <div className="mt-4 border-t border-muster-border pt-3"><h4 className="text-xs font-semibold muster-text-primary">Evidence about this subject</h4><div className="mt-2 space-y-2">{detailFacts.slice(0, 4).map((fact) => <button key={fact.id} type="button" className="block w-full rounded-md border border-muster-border p-2 text-left hover:bg-muster-surface-hover" onClick={() => void handleSelectFact(factAsSummary(fact, kbs))}><span className="block text-xs font-semibold muster-text-primary">{fact.title}</span><span className="mt-1 block line-clamp-2 text-[11px] muster-text-secondary">{fact.content}</span></button>)}{detailFacts.length === 0 && <p className="text-xs muster-text-muted">No facts are attached to this subject yet.</p>}</div></div>
                <div className="mt-4 flex flex-wrap gap-2"><button type="button" className="muster-btn muster-btn-soft text-xs" onClick={handleShowConnections} disabled={!context}><Network className="h-3.5 w-3.5" />Show connections</button><button type="button" className="muster-btn muster-btn-secondary text-xs" onClick={() => handleOpenAddFactForEntity(detailEntity)}><PlusCircle className="h-3.5 w-3.5" />Add evidence</button><button type="button" className="muster-btn muster-btn-secondary text-xs" onClick={() => handleOpenEditEntity(detailEntity)}><Pencil className="h-3.5 w-3.5" />Edit subject</button><button type="button" className="muster-btn muster-btn-secondary text-xs" onClick={() => setShowAddRelationModal(true)} disabled={displayedEntities.filter((entity) => entity.id !== detailEntity.id).length === 0}><Link2 className="h-3.5 w-3.5" />Add connection</button></div>
                {context && <p className="mt-2 text-[11px] muster-text-muted">{context.edges.length} visible connections · bounded to {context.depth}-hop context</p>}
              </aside>
            )}
          </div>
        )}

        {browseOpen && !showConnections && (
          <section className="min-w-0" aria-labelledby="knowledge-browse-title">
            <div className="muster-panel mb-3 flex flex-wrap items-center justify-between gap-3 p-3"><div><h3 id="knowledge-browse-title" className="text-sm font-semibold muster-text-primary">Browse knowledge</h3><p className="mt-1 text-xs muster-text-muted">Use deterministic lists and filters when you already know what to look for.</p></div><div className="muster-segmented" role="group" aria-label="Browse mode"><button type="button" aria-pressed={viewMode === 'facts'} onClick={() => handleChangeView('facts')} className="muster-segmented-item min-h-[40px] text-xs">Answers {overview ? `(${overview.totals.facts})` : ''}</button><button type="button" aria-pressed={viewMode === 'entities'} onClick={() => handleChangeView('entities')} className="muster-segmented-item min-h-[40px] text-xs">Subjects {overview ? `(${overview.totals.entities})` : ''}</button></div></div>
            <details className="group mb-3" open={filtersExpanded} onToggle={(event) => setFiltersExpanded(event.currentTarget.open)}><summary className="flex min-h-[40px] cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1 text-xs font-semibold muster-text-muted outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 [&::-webkit-details-marker]:hidden"><Filter className="h-3.5 w-3.5" aria-hidden="true" /><span>Refine results</span><ChevronRight className="ml-auto h-4 w-4 transition-transform group-open:rotate-90" aria-hidden="true" /></summary><div className="flex flex-wrap items-center gap-2 pb-1 pt-2" aria-label="Knowledge filters"><label htmlFor="knowledge-category" className="sr-only">Category</label><select id="knowledge-category" value={categoryFilter} onChange={(event) => { setCategoryFilter(event.target.value); updateKnowledgeUrl({ category: event.target.value }, true); }} className="muster-input min-h-[40px] w-auto max-w-full text-xs"><option value="">All categories</option>{(overview?.facets.categories.items ?? []).map((facet) => <option key={facet.value} value={facet.value}>{facet.label || facet.value} ({facet.count})</option>)}</select><label htmlFor="knowledge-entity-type" className="sr-only">Subject type</label><select id="knowledge-entity-type" value={entityTypeFilter} onChange={(event) => { setEntityTypeFilter(event.target.value); updateKnowledgeUrl({ entityType: event.target.value }, true); }} className="muster-input min-h-[40px] w-auto max-w-full text-xs"><option value="">All subject types</option>{(overview?.facets.entity_types.items ?? []).map((facet) => <option key={facet.value} value={facet.value}>{facet.label || facet.value} ({facet.count})</option>)}</select><label htmlFor="knowledge-attached" className="sr-only">Attachment</label><select id="knowledge-attached" value={attachedFilter} onChange={(event) => { const value = event.target.value as KnowledgeUrlState['attached']; setAttachedFilter(value); updateKnowledgeUrl({ attached: value }, true); }} className="muster-input min-h-[40px] w-auto max-w-full text-xs"><option value="all">Attached: all</option><option value="attached">Attached only</option><option value="unattached">Unattached only</option></select><label htmlFor="knowledge-source" className="sr-only">Source</label><select id="knowledge-source" value={sourceFilter} onChange={(event) => { const value = event.target.value as KnowledgeUrlState['hasSource']; setSourceFilter(value); updateKnowledgeUrl({ hasSource: value }, true); }} className="muster-input min-h-[40px] w-auto max-w-full text-xs"><option value="all">Source: all</option><option value="with-source">With source</option><option value="without-source">Without source</option></select></div></details>
            {viewMode === 'facts' && <section className="muster-panel p-3 sm:p-4">{factsLoading && displayedFactSummaries.length === 0 ? <div className="py-12 text-center text-sm muster-text-muted" role="status">Loading answers…</div> : displayedFactSummaries.length === 0 ? <div className="py-12 text-center text-sm muster-text-muted">No answers match these filters.</div> : renderAnswerList(displayedFactSummaries, 'Browse answers')}</section>}
            {viewMode === 'entities' && <section className="muster-panel p-3 sm:p-4"><div className="mb-2 flex items-center justify-between"><h4 className="text-xs font-semibold uppercase tracking-[0.14em] muster-text-muted">Subjects</h4><span className="text-xs muster-text-faint">{displayedEntities.length} shown</span></div>{entitiesLoading ? <div className="py-12 text-center text-sm muster-text-muted" role="status">Loading subjects…</div> : entitiesError && displayedEntities.length === 0 ? <div role="alert" className="py-10 text-center text-sm muster-text-danger">{entitiesError}<button type="button" onClick={() => { const scope = selectedScope(); if (scope) void loadEntitiesData(scope); }} className="muster-btn muster-btn-secondary mt-3 text-xs">Retry</button></div> : displayedEntities.length === 0 ? <div className="py-12 text-center text-sm muster-text-muted">No subjects are attached to this scope.</div> : <ul className="divide-y divide-muster-border" aria-label="Knowledge subjects">{displayedEntities.map((entity) => <li key={entity.id}><button type="button" onClick={() => handleSelectEntitySummary(entity)} className="flex min-h-[64px] w-full items-center gap-3 px-2 py-3 text-left hover:bg-muster-surface-hover" aria-pressed={context?.root.id === entity.id}><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-muster-border text-xs font-semibold muster-accent" aria-hidden="true">{entity.name.slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold muster-text-primary">{entity.name}</span><span className="block truncate text-xs muster-text-muted">{displayKnowledgeType(entity.type)}{entity.identifier ? ` · ${entity.identifier}` : ''}</span></span><span className="shrink-0 text-xs muster-text-muted">{entity.fact_count} facts · {entity.incoming_relation_count + entity.outgoing_relation_count} links</span><ChevronRight className="h-4 w-4 shrink-0 muster-text-faint" aria-hidden="true" /></button></li>)}</ul>}</section>}
          </section>
        )}

        {showConnections && (
          <section className="min-w-0" aria-labelledby="knowledge-connections-surface-title">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h2 id="knowledge-connections-surface-title" className="text-sm font-semibold muster-text-primary">Connections for {context?.root.name || selectedEntity?.entity.name || 'this subject'}</h2><p className="mt-1 text-xs muster-text-muted">The visual is optional; the entity and relation list remains the complete accessible path.</p></div><button type="button" className="muster-btn muster-btn-secondary min-h-[40px] text-xs" onClick={handleCloseConnections}><X className="h-3.5 w-3.5" />Back to answers</button></div>
            {contextLoading && !hasContext ? <div className="muster-panel flex min-h-[360px] items-center justify-center text-sm muster-text-muted" role="status">Loading bounded connections…</div> : contextError && !hasContext ? <div className="muster-panel flex min-h-[240px] flex-col items-center justify-center text-center" role="alert"><p className="text-sm muster-text-danger">{contextError}</p><button type="button" className="muster-btn muster-btn-secondary mt-3 text-xs" onClick={() => { const entityId = context?.root.id || selectedEntity?.entity.id; if (entityId) void loadContextData(entityId, context?.root.knowledge_base.id || selectedEntity?.entity.kb_id); }}>Retry</button></div> : hasContext && displayedGraph.nodes.length > 0 ? <LazyBoundary label="Knowledge connections" resetKey={`${selectedKbId}:${context?.root.id || selectedEntity?.entity.id || 'scope'}`}><LazyKnowledgeConnections data={displayedGraph} selectedEntityId={context?.root.id || selectedEntity?.entity.id} searchQuery={searchQuery} onSelectNode={handleSelectGraphNode} onRequestDepthTwo={context?.depth === 1 ? handleRequestDepthTwo : undefined} /></LazyBoundary> : <div className="muster-panel flex min-h-[240px] flex-col items-center justify-center text-center"><Network className="h-8 w-8 muster-text-faint" aria-hidden="true" /><p className="mt-2 text-sm font-medium muster-text-primary">Choose a subject before opening connections.</p><button type="button" className="muster-btn muster-btn-secondary mt-3 text-xs" onClick={() => { setShowConnections(false); setBrowseOpen(true); setViewMode('entities'); }}>Browse subjects</button></div>}
          </section>
        )}
      </section>


      {/* Modal: Create Knowledge Base */}
      {showCreateKbModal && (
        <AccessibleDialog onClose={() => setShowCreateKbModal(false)} titleId="create-kb-title" className="w-full max-w-md p-6">
          <form onSubmit={handleCreateKB} className="w-full space-y-4">
            <h2 id="create-kb-title" className="text-lg font-bold muster-text-primary">Create New Knowledge Base</h2>
            <div>
              <label htmlFor="create-kb-name" className="muster-label">KB Name</label>
              <input id="create-kb-name" data-dialog-initial-focus type="text" placeholder="e.g. Home KB, Work KB, Infra KB" value={newKbName} onChange={(e) => setNewKbName(e.target.value)} required className="muster-input muster-input-lg" />
            </div>
            <div>
              <label htmlFor="create-kb-description" className="muster-label">Description</label>
              <textarea id="create-kb-description" placeholder="Scope and purpose of this knowledge base..." value={newKbDesc} onChange={(e) => setNewKbDesc(e.target.value)} rows={3} className="muster-input muster-input-lg resize-none" />
            </div>
            <div className="flex items-center space-x-2 pt-1">
              <input type="checkbox" id="is_global" checked={newKbIsGlobal} onChange={(e) => setNewKbIsGlobal(e.target.checked)} className="rounded-sm accent-muster-accent-solid" />
              <label htmlFor="is_global" className="text-xs muster-text-secondary">Make Global (accessible by all projects)</label>
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button type="button" onClick={() => setShowCreateKbModal(false)} className="muster-btn muster-btn-lg muster-btn-secondary">Cancel</button>
              <button type="submit" className="muster-btn muster-btn-lg muster-btn-primary">Create KB</button>
            </div>
          </form>
        </AccessibleDialog>
      )}

      {/* Modal: Add Gained Knowledge */}
      {showAddFactModal && (
        <AccessibleDialog onClose={() => setShowAddFactModal(false)} titleId="add-knowledge-title" className="w-full max-w-lg p-6">
          <form onSubmit={handleAddFact} className="w-full space-y-4">
            <h2 id="add-knowledge-title" className="text-lg font-bold muster-text-primary">Add Gained Knowledge</h2>
            <div><label htmlFor="add-knowledge-name" className="muster-label">Title</label><input id="add-knowledge-name" data-dialog-initial-focus type="text" placeholder="e.g. Single CPU Constraint, Mail Server IP" value={newFactTitle} onChange={(e) => setNewFactTitle(e.target.value)} required className="muster-input muster-input-lg" /></div>
            <div><label htmlFor="add-knowledge-content" className="muster-label">Content / Learning</label><textarea id="add-knowledge-content" placeholder="Detail what was learned..." value={newFactContent} onChange={(e) => setNewFactContent(e.target.value)} rows={4} required className="muster-input muster-input-lg resize-none" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label htmlFor="add-knowledge-category" className="muster-label">Category</label><select id="add-knowledge-category" value={newFactCategory} onChange={(e) => setNewFactCategory(e.target.value)} className="muster-input">{categoryOptions}</select></div>
              <div><label htmlFor="add-knowledge-entity" className="muster-label">Entity Name (Optional)</label><input id="add-knowledge-entity" type="text" placeholder="e.g. server-01" value={newFactEntityName} onChange={(e) => setNewFactEntityName(e.target.value)} className="muster-input" /></div>
            </div>
            <div><label htmlFor="add-knowledge-identifier" className="muster-label">Entity Identifier / IP / Email (Optional)</label><input id="add-knowledge-identifier" type="text" placeholder="e.g. 192.168.1.50 or admin@work.com" value={newFactEntityIdent} onChange={(e) => setNewFactEntityIdent(e.target.value)} className="muster-input" /></div>
            <div className="flex justify-end space-x-2 pt-2">
              <button type="button" onClick={() => setShowAddFactModal(false)} className="muster-btn muster-btn-lg muster-btn-secondary">Cancel</button>
              <button type="submit" className="muster-btn muster-btn-lg muster-btn-primary">Save Knowledge</button>
            </div>
          </form>
        </AccessibleDialog>
      )}

      {/* Modal: Edit Fact */}
      {showEditFactModal && editingFact && (
        <AccessibleDialog onClose={() => { setShowEditFactModal(false); setEditingFact(null); }} titleId="edit-knowledge-title" className="w-full max-w-lg p-6">
          <form onSubmit={handleUpdateFact} className="w-full space-y-4">
            <h2 id="edit-knowledge-title" className="text-lg font-bold muster-text-primary">Edit Gained Knowledge Fact</h2>
            <div><label htmlFor="edit-knowledge-name" className="muster-label">Title</label><input id="edit-knowledge-name" data-dialog-initial-focus type="text" value={editFactTitle} onChange={(e) => setEditFactTitle(e.target.value)} required className="muster-input muster-input-lg" /></div>
            <div><label htmlFor="edit-knowledge-content" className="muster-label">Content / Learning</label><textarea id="edit-knowledge-content" value={editFactContent} onChange={(e) => setEditFactContent(e.target.value)} rows={4} required className="muster-input muster-input-lg resize-none" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label htmlFor="edit-knowledge-category" className="muster-label">Category</label><select id="edit-knowledge-category" value={editFactCategory} onChange={(e) => setEditFactCategory(e.target.value)} className="muster-input">{categoryOptions}</select></div>
              <div><label htmlFor="edit-knowledge-entity" className="muster-label">Entity Name</label><input id="edit-knowledge-entity" type="text" value={editFactEntityName} onChange={(e) => setEditFactEntityName(e.target.value)} className="muster-input" /></div>
            </div>
            <div><label htmlFor="edit-knowledge-identifier" className="muster-label">Entity Identifier / IP / Email</label><input id="edit-knowledge-identifier" type="text" value={editFactEntityIdent} onChange={(e) => setEditFactEntityIdent(e.target.value)} className="muster-input" /></div>
            <div className="flex justify-end space-x-2 pt-2">
              <button type="button" onClick={() => { setShowEditFactModal(false); setEditingFact(null); }} className="muster-btn muster-btn-lg muster-btn-secondary">Cancel</button>
              <button type="submit" className="muster-btn muster-btn-lg muster-btn-primary">Update Fact</button>
            </div>
          </form>
        </AccessibleDialog>
      )}

      {/* Modal: Edit Entity */}
      {showEditEntityModal && editingEntity && (
        <AccessibleDialog onClose={() => { setShowEditEntityModal(false); setEditingEntity(null); }} titleId="edit-kb-entity-title" className="w-full max-w-md p-6">
          <form onSubmit={handleUpdateEntity} className="w-full space-y-4">
            <h2 id="edit-kb-entity-title" className="text-lg font-bold muster-text-primary">Edit Knowledge Graph Entity Node</h2>
            <div><label htmlFor="edit-kb-entity-name" className="muster-label">Entity Name</label><input id="edit-kb-entity-name" data-dialog-initial-focus type="text" value={editEntityName} onChange={(e) => setEditEntityName(e.target.value)} required className="muster-input muster-input-lg" /></div>
            <div><label htmlFor="edit-kb-entity-type" className="muster-label">Entity Type</label><input id="edit-kb-entity-type" type="text" placeholder="e.g. server, ip_address, email, service, database" value={editEntityType} onChange={(e) => setEditEntityType(e.target.value)} required className="muster-input" /></div>
            <div><label htmlFor="edit-kb-entity-identifier" className="muster-label">Canonical Identifier (IP, Hostname, Email)</label><input id="edit-kb-entity-identifier" type="text" value={editEntityIdent} onChange={(e) => setEditEntityIdent(e.target.value)} className="muster-input" /></div>
            <div className="flex justify-end space-x-2 pt-2">
              <button type="button" onClick={() => { setShowEditEntityModal(false); setEditingEntity(null); }} className="muster-btn muster-btn-lg muster-btn-secondary">Cancel</button>
              <button type="submit" className="muster-btn muster-btn-lg muster-btn-primary">Update Entity Node</button>
            </div>
          </form>
        </AccessibleDialog>
      )}

      {/* Modal: Add Relation */}
      {showAddRelationModal && detailEntity && (
        <AccessibleDialog onClose={() => setShowAddRelationModal(false)} titleId="add-kb-relation-title" descriptionId="add-kb-relation-description" className="w-full max-w-md p-6">
          <form onSubmit={handleAddRelation} className="w-full space-y-4">
            <h2 id="add-kb-relation-title" className="text-lg font-bold muster-text-primary">Link Graph Relation</h2>
            <p id="add-kb-relation-description" className="text-xs muster-text-muted">
              Source: <span className="font-semibold muster-accent">{detailEntity.name}</span>
            </p>
            <div><label htmlFor="add-kb-relation-type" className="muster-label">Relation Type</label><input id="add-kb-relation-type" data-dialog-initial-focus type="text" placeholder="e.g. runs_on, has_ip, depends_on, owned_by" value={relType} onChange={(e) => setRelType(e.target.value)} required className="muster-input" /></div>
            <div><label htmlFor="add-kb-relation-target" className="muster-label">Target Entity</label><select id="add-kb-relation-target" value={relTargetEntityId} onChange={(e) => setRelTargetEntityId(e.target.value)} required className="muster-input"><option value="">Select target entity...</option>{displayedEntities.filter((entity) => entity.id !== detailEntity.id).map((entity) => (<option key={entity.id} value={entity.id}>{entity.name} ({entity.type})</option>))}</select></div>
            <div><label htmlFor="add-kb-relation-notes" className="muster-label">Description (Optional)</label><input id="add-kb-relation-notes" type="text" placeholder="Additional notes about relation..." value={relDesc} onChange={(e) => setRelDesc(e.target.value)} className="muster-input" /></div>
            <div className="flex justify-end space-x-2 pt-2">
              <button type="button" onClick={() => setShowAddRelationModal(false)} className="muster-btn muster-btn-lg muster-btn-secondary">Cancel</button>
              <button type="submit" className="muster-btn muster-btn-lg muster-btn-primary">Save Relation</button>
            </div>
          </form>
        </AccessibleDialog>
      )}
    </div>
  );
};
