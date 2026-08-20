// File: src/web/components/KnowledgeBase.tsx
import React, { useState, useEffect, useRef } from 'react';
import {
  KnowledgeBase as KBType,
  KBFact,
  KBEntity,
  KBRelation,
  EntityKnowledgeResult,
  KBGraphTree,
  KBGraphNode,
  Project
} from '../types.js';
import { api } from '../api.js';
import { KnowledgeGraphCanvas } from './KnowledgeGraphCanvas.js';
import { AccessibleDialog } from './AccessibleDialog.js';
import { BookOpen, Plus, PlusCircle, Pencil, Trash2, X, Search } from 'lucide-react';

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

const NO_PROJECT_SCOPE = '__no_project__';

function isAbortError(error: unknown): boolean {
  return (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export const KnowledgeBaseView: React.FC<KnowledgeBaseProps> = ({
  currentProject,
  initialEntityId,
  onSelectEntity,
}) => {

  const [kbs, setKbs] = useState<KBType[]>([]);
  const [selectedKbId, setSelectedKbId] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'facts' | 'graph'>('graph');

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');
  const [facts, setFacts] = useState<KBFact[]>([]);
  const [graphTree, setGraphTree] = useState<KBGraphTree>(EMPTY_GRAPH_TREE);
  const [selectedEntity, setSelectedEntity] = useState<EntityKnowledgeResult | null>(null);
  const [kbsLoading, setKbsLoading] = useState<boolean>(true);
  const [kbsError, setKbsError] = useState<string | null>(null);
  const [factsLoading, setFactsLoading] = useState<boolean>(false);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [graphLoading, setGraphLoading] = useState<boolean>(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [loadedKbsForProject, setLoadedKbsForProject] = useState<string | null>(null);

  const kbRequestRef = useRef(0);
  const kbAbortRef = useRef<AbortController | null>(null);
  const dataRequestRef = useRef(0);
  const dataAbortRef = useRef<AbortController | null>(null);

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
      setGraphTree(EMPTY_GRAPH_TREE);
      setSelectedEntity(null);
      setLoadedKbsForProject(null);
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

  // Load facts and graph independently so a failure in one surface cannot hide valid data in the other.
  const refreshData = async () => {
    const projectId = currentProject?.id;
    const projectScope = projectId || NO_PROJECT_SCOPE;
    if (selectedKbId === 'all' && loadedKbsForProject !== projectScope) return;

    const requestId = ++dataRequestRef.current;
    dataAbortRef.current?.abort();
    const controller = new AbortController();
    dataAbortRef.current = controller;
    const kbIdFilter = selectedKbId === 'all' ? undefined : selectedKbId;
    const search = debouncedSearchQuery.trim();
    const scopedKbs = kbIdFilter ? kbs.filter(kb => kb.id === kbIdFilter) : kbs;
    const isCurrent = () => requestId === dataRequestRef.current && !controller.signal.aborted;

    setFactsLoading(true);
    setFactsError(null);
    setFacts([]);
    setGraphLoading(true);
    setGraphError(null);
    setGraphTree(EMPTY_GRAPH_TREE);

    const loadFacts = async () => {
      try {
        if (search) {
          if (kbIdFilter || scopedKbs.length === 0) {
            const result = await api.searchKnowledge(search, kbIdFilter, kbIdFilter ? undefined : projectId, controller.signal);
            if (isCurrent()) setFacts(result.facts);
            return;
          }

          // Search the same per-KB set used for aggregate browse. This keeps
          // global and explicitly linked KBs consistent even when a server
          // scope implementation is stricter than the selector contract.
          const results = await Promise.allSettled(
            scopedKbs.map(kb => api.searchKnowledge(search, kb.id, undefined, controller.signal)),
          );
          if (!isCurrent()) return;
          const successfulFacts = results.flatMap(result => result.status === 'fulfilled' ? result.value.facts : []);
          const failures = results.filter(result => result.status === 'rejected' && !isAbortError(result.reason));
          setFacts(successfulFacts);
          if (failures.length > 0) {
            setFactsError(`${failures.length} knowledge base${failures.length === 1 ? '' : 's'} could not be searched.`);
          }
          return;
        }

        if (kbIdFilter) {
          const list = await api.getKBFacts(kbIdFilter, controller.signal);
          if (isCurrent()) setFacts(list);
          return;
        }

        // Aggregate browsing must not call search with an empty query. Fetch each
        // selected KB directly so global and linked KBs share the same scope as
        // the selector and remain compatible with strict REST search validation.
        const results = await Promise.allSettled(
          scopedKbs.map(kb => api.getKBFacts(kb.id, controller.signal)),
        );
        if (!isCurrent()) return;
        const successfulFacts = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
        const failures = results.filter(result => result.status === 'rejected' && !isAbortError(result.reason));
        setFacts(successfulFacts);
        if (failures.length > 0) {
          setFactsError(`${failures.length} knowledge base${failures.length === 1 ? '' : 's'} could not be loaded.`);
        }
      } catch (err) {
        if (isAbortError(err) || !isCurrent()) return;
        setFactsError(getErrorMessage(err, 'Knowledge facts could not be loaded.'));
      } finally {
        if (isCurrent()) setFactsLoading(false);
      }
    };

    const loadGraph = async () => {
      try {
        let trees: KBGraphTree[] = [];
        if (kbIdFilter) {
          trees = [await api.getGraphTree(kbIdFilter, undefined, controller.signal)];
        } else if (scopedKbs.length > 0) {
          const results = await Promise.allSettled(
            scopedKbs.map(kb => api.getGraphTree(kb.id, undefined, controller.signal)),
          );
          if (!isCurrent()) return;
          trees = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
          const failures = results.filter(result => result.status === 'rejected' && !isAbortError(result.reason));
          if (failures.length > 0) {
            setGraphError(`${failures.length} knowledge base${failures.length === 1 ? '' : 's'} graph${failures.length === 1 ? '' : 's'} could not be loaded.`);
          }
        } else if (projectId) {
          // Preserve a useful graph if the KB list is genuinely empty; normal
          // aggregate loading uses the per-KB path above.
          trees = [await api.getGraphTree(undefined, projectId, controller.signal)];
        }

        if (!isCurrent()) return;
        const first = trees[0];
        setGraphTree(first ? {
          nodes: trees.flatMap(tree => tree.nodes),
          links: trees.flatMap(tree => tree.links),
          page: first.page,
        } : EMPTY_GRAPH_TREE);
      } catch (err) {
        if (isAbortError(err) || !isCurrent()) return;
        setGraphError(getErrorMessage(err, 'Knowledge graph could not be loaded.'));
      } finally {
        if (isCurrent()) setGraphLoading(false);
      }
    };

    const refreshSelectedEntity = async () => {
      if (!selectedEntity) return;
      try {
        const updated = await api.getEntityKnowledge(selectedEntity.entity.id, selectedEntity.entity.kb_id, controller.signal);
        if (isCurrent()) setSelectedEntity(updated);
      } catch (err) {
        if (!isAbortError(err) && isCurrent()) console.error('Failed to refresh selected entity:', err);
      }
    };

    void loadFacts();
    void loadGraph();
    void refreshSelectedEntity();
  };

  useEffect(() => {
    void loadKBs(true);
    return () => {
      kbAbortRef.current?.abort();
      dataAbortRef.current?.abort();
    };
  }, [currentProject?.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery), 250);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    void refreshData();
    return () => dataAbortRef.current?.abort();
  }, [selectedKbId, debouncedSearchQuery, currentProject?.id, loadedKbsForProject, kbs]);

  useEffect(() => {
    if (initialEntityId) {
      api.getEntityKnowledge(initialEntityId)
        .then(res => {
          setSelectedEntity(res);
          setViewMode('graph');
        })
        .catch(err => console.error('Failed to load initial entity from URL:', err));
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

  const handleSelectGraphNode = async (node: KBGraphNode) => {
    try {
      const res = await api.getEntityKnowledge(node.id, node.kb_id);
      setSelectedEntity(res);
      if (onSelectEntity) {
        onSelectEntity(node.id);
      }
    } catch (err) {
      console.error('Failed to fetch entity details:', err);
    }
  };

  const handleCloseInspector = () => {
    setSelectedEntity(null);
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
    <div className={`flex flex-col h-full p-2 sm:p-6 space-y-3 sm:space-y-4 ${viewMode === 'facts' ? 'overflow-y-auto' : 'overflow-hidden'}`}>

      {/* Header Bar */}
      <div className="muster-panel flex flex-col md:flex-row md:items-center justify-between gap-3 p-3.5 sm:p-4">
        <div className="flex items-center space-x-3">
          <div className="p-2 sm:p-2.5 rounded-md border muster-accent-bg muster-accent shrink-0">
            <BookOpen className="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <div>
            <h1 className="text-base sm:text-xl font-bold tracking-tight muster-text-primary">
              Knowledge Base &amp; Knowledge Graph
            </h1>
            <p className="text-[11px] sm:text-xs muster-text-muted">
              Operational learnings, hardware specs, network IPs, and agent-gained facts.
            </p>
          </div>
        </div>

        {/* KB Selector & Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedKbId}
            onChange={(e) => setSelectedKbId(e.target.value)}
            className="muster-input w-auto text-xs sm:text-sm font-medium cursor-pointer py-1.5"
          >
            <option value="all">⚡ All Linked &amp; Global KBs</option>
            {kbs.map((kb: KBType) => (
              <option key={kb.id} value={kb.id}>
                {kb.name} {kb.is_global ? '(Global)' : ''}
              </option>
            ))}
          </select>

          <button onClick={() => setShowCreateKbModal(true)} className="muster-btn muster-btn-secondary text-xs py-1.5">
            <Plus className="w-3.5 h-3.5" />
            New KB
          </button>

          <button onClick={() => setShowAddFactModal(true)} className="muster-btn muster-btn-primary text-xs py-1.5">
            <PlusCircle className="w-3.5 h-3.5" />
            Add Knowledge
          </button>
        </div>
      </div>

      {/* Search & View Mode Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 sm:gap-4">
        <div className="relative w-full sm:w-80 md:w-96">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 muster-text-muted" aria-hidden="true" />
          <input
            type="text"
            placeholder="Search IPs, hostnames, emails, or gained facts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="muster-input pl-9 text-xs sm:text-sm font-medium py-1.5"
          />
        </div>

        <div className="muster-segmented self-start sm:self-auto" role="tablist" aria-label="Knowledge view">
          <button
            role="tab"
            aria-selected={viewMode === 'facts'}
            onClick={() => setViewMode('facts')}
            className="muster-segmented-item text-xs"
          >
            Facts ({facts.length})
          </button>
          <button
            role="tab"
            aria-selected={viewMode === 'graph'}
            onClick={() => setViewMode('graph')}
            className="muster-segmented-item text-xs"
          >
            Graph ({graphTree.nodes.length})
          </button>
        </div>
      </div>

      {kbsError && (
        <div role="alert" className="muster-badge muster-badge-danger normal-case tracking-normal text-xs p-3 w-full flex items-center justify-between gap-3">
          <span>Knowledge bases could not be loaded: {kbsError}</span>
          <button onClick={() => void loadKBs(false)} className="muster-btn muster-btn-danger-soft text-xs py-1.5">Retry</button>
        </div>
      )}

      {(kbsLoading || factsLoading || graphLoading) && (
        <div role="status" aria-live="polite" className="muster-badge muster-badge-info normal-case tracking-normal text-xs w-fit">
          Loading knowledge{factsLoading && graphLoading ? ' facts and graph' : factsLoading ? ' facts' : graphLoading ? ' graph' : ' bases'}…
        </div>
      )}

      {/* Main Content Area */}
      {viewMode === 'facts' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {factsLoading ? (
            <div className="col-span-full py-16 text-center muster-panel" role="status">
              <p className="text-sm font-medium muster-text-muted">Loading gained knowledge…</p>
            </div>
          ) : factsError && facts.length === 0 ? (
            <div className="col-span-full py-10 px-4 text-center muster-panel" role="alert">
              <p className="text-sm font-medium muster-text-danger">{factsError}</p>
              <button onClick={() => void refreshData()} className="muster-btn muster-btn-secondary text-xs mt-3">Retry</button>
            </div>
          ) : (
            <>
              {factsError && (
                <div role="status" className="col-span-full muster-badge muster-badge-warning normal-case tracking-normal text-xs p-3">
                  {factsError} Showing the successfully loaded facts.
                </div>
              )}
              {facts.length === 0 ? (
                <div className="col-span-full py-16 text-center muster-panel">
                  <p className="text-sm font-medium muster-text-muted">No gained knowledge facts matching search.</p>
                  <p className="text-xs mt-1 muster-text-muted">Click "Add Knowledge" above to log operational learnings.</p>
                </div>
              ) : facts.map((fact: KBFact) => (
                <div key={fact.id} className="muster-panel p-4 flex flex-col justify-between group">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="muster-badge muster-badge-accent">{fact.category}</span>
                      <div className="flex items-center gap-1">
                        {fact.entity_name && (
                          <span className="muster-chip max-w-[120px] truncate">{fact.entity_name}</span>
                        )}
                        <button
                          onClick={() => handleOpenEditFact(fact)}
                          className="muster-btn muster-btn-icon muster-btn-ghost opacity-60 group-hover:opacity-100"
                          title="Edit Fact"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteFact(fact.id)}
                          className="muster-btn muster-btn-icon muster-btn-ghost-danger opacity-60 group-hover:opacity-100"
                          title="Delete Fact"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <h3 className="text-sm font-semibold mb-1.5 muster-text-primary">{fact.title}</h3>
                    <p className="text-xs whitespace-pre-wrap leading-relaxed muster-text-secondary">{fact.content}</p>
                  </div>

                  <div className="mt-4 pt-3 border-t border-muster-border flex items-center justify-between text-[11px] muster-text-muted">
                    <span>Confidence: {Math.round(fact.confidence * 100)}%</span>
                    <span>{new Date(fact.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      ) : (
        <div className="flex-1 flex gap-4 min-h-0 h-full relative overflow-hidden">
          <div className="flex-1 h-full min-w-0">

            {graphLoading ? (
              <div className="h-full min-h-[450px] muster-panel flex items-center justify-center" role="status">
                <p className="text-sm font-medium muster-text-muted">Loading knowledge graph…</p>
              </div>
            ) : graphError && graphTree.nodes.length === 0 ? (
              <div className="h-full min-h-[450px] muster-panel flex flex-col items-center justify-center text-center px-4" role="alert">
                <p className="text-sm font-medium muster-text-danger">{graphError}</p>
                <button onClick={() => void refreshData()} className="muster-btn muster-btn-secondary text-xs mt-3">Retry</button>
              </div>
            ) : (
              <div className="h-full flex flex-col gap-2">
                {graphError && (
                  <div role="status" className="muster-badge muster-badge-warning normal-case tracking-normal text-xs p-3 flex-none">
                    {graphError} Showing the successfully loaded graph data.
                  </div>
                )}
                {graphTree.nodes.length === 0 ? (
                  <div className="flex-1 min-h-[450px] muster-panel flex items-center justify-center text-center px-4">
                    <p className="text-sm font-medium muster-text-muted">No graph entities are available in this knowledge scope.</p>
                  </div>
                ) : (
                  <div className="flex-1 min-h-0">
                    <KnowledgeGraphCanvas
                      data={graphTree}
                      selectedEntityId={selectedEntity?.entity.id}
                      searchQuery={searchQuery}
                      onSelectNode={handleSelectGraphNode}
                    />
                  </div>
                )}
              </div>
            )}

          </div>

          {/* Entity Details Inspector */}
          {selectedEntity && (
            <div className="muster-panel fixed inset-x-2 bottom-2 max-h-[75vh] lg:relative lg:inset-auto lg:max-h-none lg:w-[420px] lg:h-full p-4 sm:p-5 flex flex-col min-h-0 overflow-hidden z-30 shadow-2xl border border-brand-500/40 lg:border-muster-border">
              {/* Fixed Header */}
              <div className="flex-none flex items-start justify-between gap-2 border-b border-muster-border pb-3 mb-4">
                <div className="min-w-0">
                  <span className="text-[10px] font-bold uppercase tracking-wider muster-accent">
                    {selectedEntity.entity.type}
                  </span>
                  <h2 className="text-base font-bold flex items-center gap-2 muster-text-primary">
                    {selectedEntity.entity.name}
                    <button
                      onClick={() => handleOpenEditEntity(selectedEntity.entity)}
                      className="muster-btn muster-btn-icon muster-btn-ghost"
                      title="Edit Entity Node"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </h2>
                  {selectedEntity.entity.identifier && (
                    <p className="text-xs font-mono mt-0.5 muster-text-muted">{selectedEntity.entity.identifier}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowAddRelationModal(true)} className="muster-btn muster-btn-soft">
                    + Edge
                  </button>
                  <button
                    onClick={handleCloseInspector}
                    className="muster-btn muster-btn-icon muster-btn-ghost"
                    title="Close Panel"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Gained Knowledge Facts List */}
              <div className="flex-1 flex flex-col min-h-0 min-w-0 mb-4">
                <div className="flex-none flex items-center justify-between gap-2 mb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider muster-text-muted">
                    Attached Gained Knowledge ({selectedEntity.facts.length})
                  </h4>
                  <button
                    onClick={() => handleOpenAddFactForEntity(selectedEntity.entity)}
                    className="muster-btn muster-btn-soft"
                    title="Add Gained Knowledge Fact for this node"
                  >
                    + Add Fact
                  </button>
                </div>

                {selectedEntity.facts.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center text-center p-4 rounded-md border border-muster-border">
                    <p className="text-xs italic muster-text-muted">No specific facts attached directly.</p>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 min-h-0">
                    {selectedEntity.facts.map((f: KBFact) => (
                      <div key={f.id} className="p-3 rounded-md border border-muster-border text-xs group flex flex-col justify-between">
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold muster-text-primary">{f.title}</p>
                            <div className="flex items-center opacity-60 group-hover:opacity-100">
                              <button
                                onClick={() => handleOpenEditFact(f)}
                                className="muster-btn muster-btn-icon muster-btn-ghost"
                                title="Edit Fact"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => handleDeleteFact(f.id)}
                                className="muster-btn muster-btn-icon muster-btn-ghost-danger"
                                title="Delete Fact"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                          <p className="mt-1.5 whitespace-pre-wrap leading-relaxed muster-text-secondary">{f.content}</p>
                        </div>
                        <div className="mt-2 pt-1.5 border-t border-muster-border flex items-center justify-between text-[10px] muster-text-muted">
                          <span>Category: {f.category}</span>
                          <span>Confidence: {Math.round(f.confidence * 100)}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Graph Relations */}
              <div className="flex-none border-t border-muster-border pt-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider mb-2 muster-text-muted">
                  Graph Links ({selectedEntity.outgoing_relations.length + selectedEntity.incoming_relations.length})
                </h4>
                <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                  {selectedEntity.outgoing_relations.map((r: KBRelation) => (
                    <div key={r.id} className="text-xs p-2 rounded-md border border-muster-border bg-muster-base flex items-center justify-between gap-2">
                      <span className="muster-text-secondary font-mono">--( {r.relation_type} )--&gt;</span>
                      <span className="font-semibold muster-accent">{r.target_entity_name || 'Target'}</span>
                    </div>
                  ))}
                  {selectedEntity.incoming_relations.map((r: KBRelation) => (
                    <div key={r.id} className="text-xs p-2 rounded-md border border-muster-border bg-muster-base flex items-center justify-between gap-2">
                      <span className="font-semibold muster-accent">{r.source_entity_name || 'Source'}</span>
                      <span className="muster-text-secondary font-mono">--( {r.relation_type} )--&gt;</span>
                    </div>
                  ))}
                  {selectedEntity.outgoing_relations.length === 0 && selectedEntity.incoming_relations.length === 0 && (
                    <p className="text-xs italic muster-text-muted">No graph edges linked to this entity.</p>
                  )}
                </div>
              </div>
            </div>
          )}

        </div>
      )}


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
