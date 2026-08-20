// File: src/web/components/KnowledgeBase.tsx
import React, { useState, useEffect, useMemo, useRef } from 'react';
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
import { KnowledgeGraphCanvas } from './KnowledgeGraphCanvas.js';
import { KnowledgeEntityRelationList } from './KnowledgeEntityRelationList.js';
import { AccessibleDialog } from './AccessibleDialog.js';
import { parseKnowledgeUrl, updateKnowledgeBrowserLocation, type KnowledgeUrlState } from '../navigation.js';
import { BookOpen, Plus, PlusCircle, Pencil, Trash2, X, Search, Filter, Network, ChevronRight, CircleAlert } from 'lucide-react';

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
    const search = debouncedSearchQuery.trim();
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
    const targetKbId = selectedKbId !== 'all' ? selectedKbId : (selectedEntity?.entity.kb_id || kbs[0]?.id);
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
    setContextDepth(1);
    updateKnowledgeUrl({ view: 'graph', entityId: node.id, factId: null, depth: 1 }, false);
    if (onSelectEntity) onSelectEntity(node.id);
    await loadContextData(node.id, node.kb_id, 1);
  };

  const handleCloseInspector = () => {
    setSelectedEntity(null);
    setContext(null);
    updateKnowledgeUrl({ entityId: null }, true);
    if (onSelectEntity) {
      onSelectEntity(null);
    }
  };


  const handleAddRelation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEntity || !relTargetEntityId) return;

    try {
      await api.addRelation({
        kb_id: selectedEntity.entity.kb_id,
        source_entity_id: selectedEntity.entity.id,
        target_entity_id: relTargetEntityId,
        relation_type: relType,
        description: relDesc || undefined,
      });
      setShowAddRelationModal(false);
      setRelDesc('');
      const updated = await api.getEntityKnowledge(selectedEntity.entity.id, selectedEntity.entity.kb_id);
      setSelectedEntity(updated);
      await refreshData();
    } catch (err) {
      console.error('Failed to add relation:', err);
    }
  };

  const handleSelectEntitySummary = (entity: KBEntitySummary | KBGraphNode) => {
    const kbId = 'kb_id' in entity ? entity.kb_id : entity.knowledge_base.id;
    setViewMode('entities');
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
  const scopeLabel = selectedKbId === 'all' ? 'All Linked & Global' : kbs.find((kb) => kb.id === selectedKbId)?.name || 'Knowledge base';
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
  const contextNodeNames = new Map(displayedGraph.nodes.map((node) => [node.id, node.name]));

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
      <div className="muster-panel flex flex-col gap-3 p-3.5 sm:p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="muster-accent-bg muster-accent shrink-0 rounded-md border p-2 sm:p-2.5">
            <BookOpen className="h-5 w-5 sm:h-6 sm:w-6" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold tracking-tight muster-text-primary sm:text-xl">Knowledge Base Explore</h1>
            <p className="text-[11px] muster-text-muted sm:text-xs">Find the fact, entity, or context that answers the operational question.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="knowledge-scope" className="sr-only">Knowledge scope</label>
          <select id="knowledge-scope" value={selectedKbId} onChange={(event) => handleScopeChange(event.target.value)} className="muster-input w-auto max-w-full cursor-pointer py-1.5 text-xs font-medium sm:text-sm">
            <option value="all">All Linked &amp; Global KBs</option>
            {kbs.map((kb: KBType) => <option key={kb.id} value={kb.id}>{kb.name}{kb.is_global ? ' (Global)' : ''}</option>)}
          </select>
          <button type="button" onClick={() => setShowCreateKbModal(true)} className="muster-btn muster-btn-secondary text-xs"><Plus className="h-3.5 w-3.5" />New KB</button>
          <button type="button" onClick={() => setShowAddFactModal(true)} className="muster-btn muster-btn-primary text-xs"><PlusCircle className="h-3.5 w-3.5" />Add Knowledge</button>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative min-w-0 flex-1 sm:max-w-xl">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 muster-text-muted" aria-hidden="true" />
          <label htmlFor="knowledge-search" className="sr-only">Search knowledge</label>
          <input id="knowledge-search" type="text" placeholder="Search facts, IPs, hosts, emails, or entities…" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); updateKnowledgeUrl({ query: event.target.value }, true); }} className="muster-input w-full py-2 pl-9 text-xs font-medium sm:text-sm" />
        </div>
        <div className="muster-segmented self-start overflow-x-auto sm:self-auto" role="tablist" aria-label="Knowledge view">
          {(['explore', 'facts', 'entities', 'graph'] as const).map((tab) => (
            <button key={tab} type="button" role="tab" aria-selected={viewMode === tab} onClick={() => handleChangeView(tab)} className="muster-segmented-item min-h-[44px] whitespace-nowrap text-xs">
              {tab === 'explore' ? 'Explore' : tab[0].toUpperCase() + tab.slice(1)} {tab === 'facts' ? `(${overview?.totals.facts ?? displayedFactSummaries.length})` : tab === 'entities' ? `(${overview?.totals.entities ?? displayedEntities.length})` : tab === 'graph' ? `(${displayedGraph.nodes.length})` : ''}
            </button>
          ))}
        </div>
      </div>

      {kbsError && <div role="alert" className="muster-badge muster-badge-danger flex w-full items-center justify-between gap-3 p-3 text-xs normal-case tracking-normal"><span>Knowledge bases could not be loaded: {kbsError}</span><button type="button" onClick={() => void loadKBs(false)} className="muster-btn muster-btn-danger-soft text-xs">Retry</button></div>}
      {(kbsLoading || factsLoading || entitiesLoading || contextLoading) && <div role="status" aria-live="polite" className="muster-badge muster-badge-info w-fit text-xs normal-case tracking-normal">Loading {kbsLoading ? 'knowledge bases' : factsLoading ? 'knowledge summaries' : entitiesLoading ? 'entities' : 'entity context'}…</div>}

      {overview && (
        <div className="muster-panel flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 text-xs" aria-label={`${scopeLabel} knowledge overview`}>
          <span className="font-semibold muster-text-primary">{overview.totals.facts} facts</span>
          <span className="muster-text-faint" aria-hidden="true">·</span>
          <span className="muster-text-secondary">{overview.totals.entities} entities</span>
          <span className="muster-text-faint" aria-hidden="true">·</span>
          <span className="muster-text-secondary">{overview.totals.relations} relations</span>
          <span className="muster-text-faint" aria-hidden="true">·</span>
          <button
            type="button"
            className="muster-btn muster-btn-ghost min-h-0 px-1 py-0.5 text-xs"
            onClick={() => {
              setAttachedFilter('unattached');
              setFiltersExpanded(true);
              updateKnowledgeUrl({ attached: 'unattached' }, true);
            }}
          >
            {overview.totals.unattached_facts} need linking
          </button>
        </div>
      )}

      <details
        className="group"
        open={filtersExpanded}
        onToggle={(event) => setFiltersExpanded(event.currentTarget.open)}
      >
        <summary className="flex min-h-[40px] cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1 text-xs font-semibold muster-text-muted outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 [&::-webkit-details-marker]:hidden">
          <Filter className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Refine results</span>
          {([categoryFilter, entityTypeFilter, attachedFilter !== 'all' ? attachedFilter : '', sourceFilter !== 'all' ? sourceFilter : ''].filter(Boolean).length > 0) && <span className="muster-badge muster-badge-accent normal-case tracking-normal">{[categoryFilter, entityTypeFilter, attachedFilter !== 'all' ? attachedFilter : '', sourceFilter !== 'all' ? sourceFilter : ''].filter(Boolean).length} active</span>}
          <ChevronRight className="ml-auto h-4 w-4 transition-transform group-open:rotate-90" aria-hidden="true" />
        </summary>
        <div className="flex flex-wrap items-center gap-2 pb-1 pt-2" aria-label="Knowledge filters">
          <label htmlFor="knowledge-category" className="sr-only">Category</label>
          <select id="knowledge-category" value={categoryFilter} onChange={(event) => { setCategoryFilter(event.target.value); updateKnowledgeUrl({ category: event.target.value }, true); }} className="muster-input min-h-[40px] w-auto max-w-full text-xs"><option value="">All categories</option>{(overview?.facets.categories.items ?? []).map((facet) => <option key={facet.value} value={facet.value}>{facet.label || facet.value} ({facet.count})</option>)}{!overview && categoryOptions}</select>
          <label htmlFor="knowledge-entity-type" className="sr-only">Entity type</label>
          <select id="knowledge-entity-type" value={entityTypeFilter} onChange={(event) => { setEntityTypeFilter(event.target.value); updateKnowledgeUrl({ entityType: event.target.value }, true); }} className="muster-input min-h-[40px] w-auto max-w-full text-xs"><option value="">All entity types</option>{(overview?.facets.entity_types.items ?? []).map((facet) => <option key={facet.value} value={facet.value}>{facet.label || facet.value} ({facet.count})</option>)}</select>
          <label htmlFor="knowledge-attached" className="sr-only">Attachment</label>
          <select id="knowledge-attached" value={attachedFilter} onChange={(event) => { const value = event.target.value as KnowledgeUrlState['attached']; setAttachedFilter(value); updateKnowledgeUrl({ attached: value }, true); }} className="muster-input min-h-[40px] w-auto max-w-full text-xs"><option value="all">Attached: all</option><option value="attached">Attached only</option><option value="unattached">Unattached only</option></select>
          <label htmlFor="knowledge-source" className="sr-only">Source</label>
          <select id="knowledge-source" value={sourceFilter} onChange={(event) => { const value = event.target.value as KnowledgeUrlState['hasSource']; setSourceFilter(value); updateKnowledgeUrl({ hasSource: value }, true); }} className="muster-input min-h-[40px] w-auto max-w-full text-xs"><option value="all">Source: all</option><option value="with-source">With source</option><option value="without-source">Without source</option></select>
        </div>
      </details>

      {browseError && <div role="alert" className="muster-badge muster-badge-danger flex items-center gap-2 p-3 text-xs normal-case tracking-normal"><CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />{browseError}<button type="button" onClick={() => void refreshData()} className="muster-btn muster-btn-secondary ml-auto text-xs">Retry</button></div>}
      {factsError && displayedFactSummaries.length > 0 && <div role="status" className="muster-badge muster-badge-warning p-3 text-xs normal-case tracking-normal">{factsError} Showing the successfully loaded facts.</div>}

      <main className="min-h-0 flex-1 overflow-y-auto">
        {viewMode === 'explore' && (
          <div className={selectedFact ? 'grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]' : ''}>
            <section className="muster-panel min-w-0 p-3 sm:p-4" aria-labelledby="knowledge-explore-title">
              <div className="mb-3 flex items-center justify-between gap-2"><div><h2 id="knowledge-explore-title" className="text-sm font-semibold muster-text-primary">Explore {scopeLabel}</h2><p className="mt-0.5 text-xs muster-text-muted">A quick scan of recent knowledge. Open a row for full detail.</p></div><span className="text-xs muster-text-faint">{exploreFactSummaries.length}{overview && overview.totals.facts > exploreFactSummaries.length ? ` of ${overview.totals.facts}` : ''} shown</span></div>
              {factsLoading ? <div className="py-16 text-center" role="status"><p className="text-sm muster-text-muted">Loading knowledge summaries…</p></div> : factsError && exploreFactSummaries.length === 0 ? <div className="py-10 text-center" role="alert"><p className="text-sm muster-text-danger">{factsError}</p><button type="button" onClick={() => void refreshData()} className="muster-btn muster-btn-secondary mt-3 text-xs">Retry</button></div> : exploreFactSummaries.length === 0 ? <div className="py-16 text-center"><p className="text-sm font-medium muster-text-muted">No facts match this scope and filter set.</p><p className="mt-1 text-xs muster-text-muted">Try clearing a filter or add a new operational learning.</p></div> : <ul className="divide-y divide-muster-border" aria-label="Knowledge stream">{exploreFactSummaries.map((summary) => <li key={summary.id}><button type="button" onClick={() => void handleSelectFact(summary)} className="group flex min-h-[76px] w-full min-w-0 items-start gap-3 px-1 py-3 text-left outline-none transition-colors hover:bg-muster-hover focus-visible:bg-muster-hover"><span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-muster-border text-[10px] font-bold uppercase muster-accent" aria-hidden="true">{summary.category.slice(0, 1)}</span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="truncate text-sm font-semibold muster-text-primary">{summary.title}</span>{summary.entity && <span className="muster-chip max-w-[160px] truncate">{summary.entity.name}</span>}</span><span className="mt-1 block line-clamp-2 text-xs leading-relaxed muster-text-secondary">{summary.excerpt}</span><span className="mt-1.5 block text-[11px] muster-text-muted">{summary.knowledge_base.name} · {Math.round(summary.confidence * 100)}% confidence · {new Date(summary.updated_at || summary.created_at).toLocaleDateString()}</span></span><ChevronRight className="mt-1 h-4 w-4 shrink-0 muster-text-faint transition-transform group-hover:translate-x-0.5" aria-hidden="true" /></button></li>)}</ul>}
            </section>
            {selectedFact && <aside className="muster-panel min-w-0 p-3 sm:p-4" aria-labelledby="knowledge-detail-title">
              <div className="flex items-center justify-between gap-2"><h2 id="knowledge-detail-title" className="text-sm font-semibold muster-text-primary">Fact detail</h2><button type="button" onClick={() => { setSelectedFact(null); updateKnowledgeUrl({ factId: null }, true); }} className="muster-btn muster-btn-icon muster-btn-ghost" aria-label="Close fact detail"><X className="h-4 w-4" /></button></div>
              <div className="mt-3 space-y-3"><div><p className="text-xs font-semibold muster-text-primary">{selectedFact.title}</p><p className="mt-1 text-[11px] muster-text-muted">{selectedFact.knowledge_base.name} · {selectedFact.category}</p></div>{factDetailLoading ? <p role="status" className="text-xs muster-text-muted">Loading full fact…</p> : factDetailError ? <p role="alert" className="text-xs muster-text-danger">{factDetailError}</p> : <p className="whitespace-pre-wrap text-xs leading-relaxed muster-text-secondary">{activeFactDetail?.content || selectedFact.excerpt}</p>}{activeFactDetail && <div className="flex flex-wrap gap-2"><button type="button" onClick={() => handleOpenEditFact(activeFactDetail)} className="muster-btn muster-btn-secondary text-xs"><Pencil className="h-3.5 w-3.5" />Edit fact</button><button type="button" onClick={() => void handleDeleteFact(activeFactDetail.id)} className="muster-btn muster-btn-danger-soft text-xs"><Trash2 className="h-3.5 w-3.5" />Delete</button></div>}</div>
            </aside>}
          </div>
        )}

        {viewMode === 'facts' && <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-labelledby="knowledge-facts-title"><h2 id="knowledge-facts-title" className="sr-only">Knowledge facts</h2>{factsLoading ? <div className="col-span-full muster-panel py-16 text-center" role="status">Loading gained knowledge…</div> : factsError && displayedFactSummaries.length === 0 ? <div className="col-span-full muster-panel px-4 py-10 text-center" role="alert"><p className="text-sm muster-text-danger">{factsError}</p><button type="button" onClick={() => void refreshData()} className="muster-btn muster-btn-secondary mt-3 text-xs">Retry</button></div> : displayedFactSummaries.length === 0 ? <div className="col-span-full muster-panel py-16 text-center"><p className="text-sm font-medium muster-text-muted">No gained knowledge facts matching search.</p><p className="mt-1 text-xs muster-text-muted">Click “Add Knowledge” above to log operational learnings.</p></div> : displayedFactSummaries.map((summary) => { const fullFact = facts.find((fact) => fact.id === summary.id); return <article key={summary.id} className="muster-panel group flex min-w-0 flex-col justify-between p-4"><button type="button" onClick={() => void handleSelectFact(summary)} className="text-left"><div className="mb-2 flex items-center justify-between gap-2"><span className="muster-badge muster-badge-accent">{summary.category}</span>{summary.entity && <span className="muster-chip max-w-[120px] truncate">{summary.entity.name}</span>}</div><h3 className="mb-1.5 text-sm font-semibold muster-text-primary">{summary.title}</h3><p className="line-clamp-5 whitespace-pre-wrap text-xs leading-relaxed muster-text-secondary">{summary.excerpt}</p></button><div className="mt-4 flex items-center justify-between border-t border-muster-border pt-3 text-[11px] muster-text-muted"><span>Confidence: {Math.round(summary.confidence * 100)}%</span><span>{new Date(summary.created_at).toLocaleDateString()}</span></div>{fullFact && <div className="mt-2 flex gap-1"><button type="button" onClick={() => handleOpenEditFact(fullFact)} className="muster-btn muster-btn-icon muster-btn-ghost" title="Edit Fact"><Pencil className="h-3.5 w-3.5" /></button><button type="button" onClick={() => void handleDeleteFact(fullFact.id)} className="muster-btn muster-btn-icon muster-btn-ghost-danger" title="Delete Fact"><Trash2 className="h-3.5 w-3.5" /></button></div>}</article>; })}</section>}

        {viewMode === 'entities' && <div className="grid gap-3 lg:grid-cols-[minmax(240px,360px)_minmax(0,1fr)]"><section className="muster-panel p-3 sm:p-4" aria-labelledby="knowledge-entities-title"><div className="mb-3 flex items-center justify-between gap-2"><h2 id="knowledge-entities-title" className="text-sm font-semibold muster-text-primary">Entities</h2><span className="text-xs muster-text-faint">{displayedEntities.length} shown</span></div>{entitiesError && displayedEntities.length === 0 ? <div role="alert"><p className="text-xs muster-text-danger">{entitiesError}</p><button type="button" onClick={() => { const scope = selectedScope(); if (scope) void loadEntitiesData(scope); }} className="muster-btn muster-btn-secondary mt-3 text-xs">Retry</button></div> : displayedEntities.length === 0 ? <p className="text-xs muster-text-muted">No entities are available in this scope.</p> : <ul className="space-y-1" aria-label="Knowledge entities">{displayedEntities.map((entity) => <li key={entity.id}><button type="button" onClick={() => handleSelectEntitySummary(entity)} className={`muster-card flex min-h-[48px] w-full items-center gap-2 px-3 py-2 text-left ${context?.root.id === entity.id ? 'border-muster-accent' : ''}`} aria-pressed={context?.root.id === entity.id}><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-muster-border-subtle text-xs muster-text-muted" aria-hidden="true">{entity.name.slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold muster-text-primary">{entity.name}</span><span className="block truncate text-[11px] muster-text-faint">{entity.type}{entity.identifier ? ` · ${entity.identifier}` : ''}</span></span><span className="text-[11px] muster-text-muted">{entity.fact_count}</span></button></li>)}</ul>}</section><section className="min-w-0 space-y-3"><div className="muster-panel min-h-[220px] p-3 sm:p-4">{contextLoading ? <div role="status" className="py-16 text-center text-xs muster-text-muted">Loading bounded entity context…</div> : contextError && !context ? <div role="alert" className="py-10 text-center"><p className="text-sm muster-text-danger">{contextError}</p></div> : context ? <KnowledgeEntityRelationList nodes={displayedGraph.nodes} links={displayedGraph.links} selectedEntityId={context.root.id} depth={context.depth} truncation={context.truncation} onSelectNode={handleSelectGraphNode} onRequestDepthTwo={context.depth < 2 ? handleRequestDepthTwo : undefined} /> : <div className="py-16 text-center"><Network className="mx-auto h-7 w-7 muster-text-faint" aria-hidden="true" /><p className="mt-2 text-sm font-medium muster-text-muted">Select an entity to open its context lens.</p></div>}</div></section></div>}

        {viewMode === 'graph' && <div className="grid min-h-[420px] gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(300px,420px)]"><section className="flex min-h-[420px] min-w-0 flex-col gap-2">{graphError && displayedGraph.nodes.length > 0 && <div role="status" className="muster-badge muster-badge-warning flex-none p-3 text-xs normal-case tracking-normal">{graphError} Showing the successfully loaded graph data.</div>}{contextError && displayedGraph.nodes.length > 0 && <div role="status" className="muster-badge muster-badge-warning flex-none p-3 text-xs normal-case tracking-normal">{contextError} Showing the successfully loaded context data.</div>}{graphLoading || contextLoading ? <div className="muster-panel flex min-h-[420px] items-center justify-center" role="status"><p className="text-sm muster-text-muted">Loading focused context…</p></div> : graphError && displayedGraph.nodes.length === 0 ? <div className="muster-panel flex min-h-[420px] flex-col items-center justify-center px-4 text-center" role="alert"><p className="text-sm muster-text-danger">{graphError}</p><button type="button" onClick={() => void refreshData()} className="muster-btn muster-btn-secondary mt-3 text-xs">Retry</button></div> : displayedGraph.nodes.length === 0 ? <div className="muster-panel flex min-h-[420px] flex-col items-center justify-center px-4 text-center"><Network className="h-8 w-8 muster-text-faint" aria-hidden="true" /><p className="mt-2 text-sm font-medium muster-text-muted">Select an entity from Explore or Entities to open a bounded graph context.</p><button type="button" onClick={() => handleChangeView('entities')} className="muster-btn muster-btn-secondary mt-3 text-xs">Browse entities</button></div> : <div className="min-h-[420px] flex-1"><KnowledgeGraphCanvas data={displayedGraph} selectedEntityId={selectedEntity?.entity.id || context?.root.id} searchQuery={searchQuery} onSelectNode={handleSelectGraphNode} /></div>}{displayedGraph.nodes.length > 0 && <KnowledgeEntityRelationList nodes={displayedGraph.nodes} links={displayedGraph.links} selectedEntityId={selectedEntity?.entity.id || context?.root.id} depth={context?.depth || displayedGraph.depth || 0} totalNodes={overview?.totals.entities} totalLinks={overview?.totals.relations} truncation={displayedGraph.truncation} onSelectNode={handleSelectGraphNode} onRequestDepthTwo={context?.depth === 1 ? handleRequestDepthTwo : undefined} />}</section><aside className="muster-panel min-h-[420px] p-4">{selectedEntity ? <><div className="flex items-start justify-between gap-2 border-b border-muster-border pb-3"><div className="min-w-0"><span className="text-[10px] font-bold uppercase tracking-wider muster-accent">{selectedEntity.entity.type}</span><h2 className="flex items-center gap-2 text-base font-bold muster-text-primary">{selectedEntity.entity.name}<button type="button" onClick={() => handleOpenEditEntity(selectedEntity.entity)} className="muster-btn muster-btn-icon muster-btn-ghost" title="Edit Entity Node"><Pencil className="h-3.5 w-3.5" /></button></h2>{selectedEntity.entity.identifier && <p className="mt-0.5 text-xs font-mono muster-text-muted">{selectedEntity.entity.identifier}</p>}</div><button type="button" onClick={handleCloseInspector} className="muster-btn muster-btn-icon muster-btn-ghost" title="Close Panel"><X className="h-4 w-4" /></button></div><div className="mt-3 flex items-center justify-between gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide muster-text-muted">Attached facts ({selectedEntity.facts.length})</h3><button type="button" onClick={() => handleOpenAddFactForEntity(selectedEntity.entity)} className="muster-btn muster-btn-soft text-xs">+ Add Fact</button></div><div className="mt-2 max-h-56 space-y-2 overflow-y-auto">{selectedEntity.facts.map((fact) => <div key={fact.id} className="rounded-md border border-muster-border p-2 text-xs"><p className="font-semibold muster-text-primary">{fact.title}</p><p className="mt-1 whitespace-pre-wrap muster-text-secondary">{fact.content}</p></div>)}{selectedEntity.facts.length === 0 && <p className="text-xs italic muster-text-muted">No facts attached directly.</p>}</div><div className="mt-4 border-t border-muster-border pt-3"><div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide muster-text-muted">Graph links</h3><button type="button" onClick={() => setShowAddRelationModal(true)} className="muster-btn muster-btn-soft text-xs">+ Edge</button></div><div className="mt-2 space-y-1.5">{[...selectedEntity.outgoing_relations, ...selectedEntity.incoming_relations].map((relation) => <div key={relation.id} className="rounded-md border border-muster-border p-2 text-xs muster-text-secondary">{relation.source_entity_name || selectedEntity.entity.name} — {relation.relation_type} — {relation.target_entity_name || selectedEntity.entity.name}</div>)}{selectedEntity.outgoing_relations.length + selectedEntity.incoming_relations.length === 0 && <p className="text-xs italic muster-text-muted">No graph edges linked to this entity.</p>}</div></div></> : contextInspectorEntity ? <><div className="flex items-start justify-between gap-2 border-b border-muster-border pb-3"><div className="min-w-0"><span className="text-[10px] font-bold uppercase tracking-wider muster-accent">{contextInspectorEntity.type}</span><h2 className="flex items-center gap-2 text-base font-bold muster-text-primary">{contextInspectorEntity.name}<button type="button" onClick={() => handleOpenEditEntity(contextInspectorEntity)} className="muster-btn muster-btn-icon muster-btn-ghost" title="Edit Entity Node"><Pencil className="h-3.5 w-3.5" /></button></h2>{contextInspectorEntity.identifier && <p className="mt-0.5 text-xs font-mono muster-text-muted">{contextInspectorEntity.identifier}</p>}</div><button type="button" onClick={handleCloseInspector} className="muster-btn muster-btn-icon muster-btn-ghost" aria-label="Close entity context"><X className="h-4 w-4" /></button></div><div className="mt-3 flex items-center justify-between gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide muster-text-muted">Attached facts ({contextInspectorFacts.length})</h3><button type="button" onClick={() => handleOpenAddFactForEntity(contextInspectorEntity)} className="muster-btn muster-btn-soft text-xs">+ Add Fact</button></div><div className="mt-2 max-h-56 space-y-2 overflow-y-auto">{contextInspectorFacts.map((fact) => <div key={fact.id} className="rounded-md border border-muster-border p-2 text-xs"><p className="font-semibold muster-text-primary">{fact.title}</p><p className="mt-1 whitespace-pre-wrap muster-text-secondary">{fact.content}</p></div>)}{contextInspectorFacts.length === 0 && <p className="text-xs italic muster-text-muted">No facts attached directly.</p>}</div><div className="mt-4 border-t border-muster-border pt-3"><h3 className="text-xs font-semibold uppercase tracking-wide muster-text-muted">Graph links</h3><div className="mt-2 space-y-1.5">{context!.edges.map((relation) => <div key={relation.id} className="rounded-md border border-muster-border p-2 text-xs muster-text-secondary">{contextNodeNames.get(relation.source) || relation.source} — {relation.relation_type} — {contextNodeNames.get(relation.target) || relation.target}</div>)}{context!.edges.length === 0 && <p className="text-xs italic muster-text-muted">No graph edges linked to this entity.</p>}</div></div></> : <div className="flex min-h-[360px] flex-col items-center justify-center text-center"><p className="text-sm font-medium muster-text-primary">No entity selected</p><p className="mt-1 text-xs muster-text-muted">Choose a node from the context list to inspect facts and relations.</p></div>}</aside></div>}
      </main>


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
      {showAddRelationModal && selectedEntity && (
        <AccessibleDialog onClose={() => setShowAddRelationModal(false)} titleId="add-kb-relation-title" descriptionId="add-kb-relation-description" className="w-full max-w-md p-6">
          <form onSubmit={handleAddRelation} className="w-full space-y-4">
            <h2 id="add-kb-relation-title" className="text-lg font-bold muster-text-primary">Link Graph Relation</h2>
            <p id="add-kb-relation-description" className="text-xs muster-text-muted">
              Source: <span className="font-semibold muster-accent">{selectedEntity.entity.name}</span>
            </p>
            <div><label htmlFor="add-kb-relation-type" className="muster-label">Relation Type</label><input id="add-kb-relation-type" data-dialog-initial-focus type="text" placeholder="e.g. runs_on, has_ip, depends_on, owned_by" value={relType} onChange={(e) => setRelType(e.target.value)} required className="muster-input" /></div>
            <div><label htmlFor="add-kb-relation-target" className="muster-label">Target Entity</label><select id="add-kb-relation-target" value={relTargetEntityId} onChange={(e) => setRelTargetEntityId(e.target.value)} required className="muster-input"><option value="">Select target entity...</option>{graphTree.nodes.filter((n: KBGraphNode) => n.id !== selectedEntity.entity.id).map((n: KBGraphNode) => (<option key={n.id} value={n.id}>{n.name} ({n.type})</option>))}</select></div>
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
