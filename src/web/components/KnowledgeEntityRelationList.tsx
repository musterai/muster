import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Expand, GitBranch, Network, Waypoints } from 'lucide-react';
import type { KBGraphLink, KBGraphNode, KBGraphTruncation } from '../types.js';

export interface KnowledgeEntityRelationListProps {
  nodes: KBGraphNode[];
  links: KBGraphLink[];
  selectedEntityId?: string;
  depth?: number;
  totalNodes?: number;
  totalLinks?: number;
  truncation?: KBGraphTruncation;
  onSelectNode: (node: KBGraphNode) => void;
  onExpandNode?: (node: KBGraphNode) => void;
  onRequestDepthTwo?: () => void;
  onSelectRelation?: (link: KBGraphLink) => void;
  className?: string;
}

function displayType(type: string): string {
  return type
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function relationLabel(link: KBGraphLink, nodeById: Map<string, KBGraphNode>): string {
  const source = nodeById.get(link.source)?.name || link.source;
  const target = nodeById.get(link.target)?.name || link.target;
  return `${source} ${link.relation_type} ${target}`;
}

/**
 * The HTML counterpart to the vis canvas. It is intentionally kept as a
 * separate component so the controller can place it beside or below the
 * canvas without making canvas interaction a prerequisite for accessibility.
 */
export const KnowledgeEntityRelationList: React.FC<KnowledgeEntityRelationListProps> = ({
  nodes,
  links,
  selectedEntityId,
  depth = 0,
  totalNodes,
  totalLinks,
  truncation,
  onSelectNode,
  onExpandNode,
  onRequestDepthTwo,
  onSelectRelation,
  className = '',
}) => {
  const orderedNodes = useMemo(
    () => [...nodes].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    [nodes],
  );
  const orderedLinks = useMemo(
    () => [...links].sort((a, b) => a.relation_type.localeCompare(b.relation_type) || a.id.localeCompare(b.id)),
    [links],
  );
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const expandableIds = useMemo(
    () => new Set(truncation?.expandable_entity_ids ?? []),
    [truncation?.expandable_entity_ids],
  );
  const [activeNodeId, setActiveNodeId] = useState(selectedEntityId ?? orderedNodes[0]?.id ?? '');
  const nodeButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const previousSelectedEntityIdRef = useRef(selectedEntityId);

  useEffect(() => {
    const selectionChanged = previousSelectedEntityIdRef.current !== selectedEntityId;
    previousSelectedEntityIdRef.current = selectedEntityId;
    if (selectionChanged && selectedEntityId && nodeById.has(selectedEntityId)) {
      setActiveNodeId(selectedEntityId);
      return;
    }
    if (!nodeById.has(activeNodeId)) {
      setActiveNodeId(orderedNodes[0]?.id ?? '');
    }
  }, [activeNodeId, nodeById, orderedNodes, selectedEntityId]);

  const moveActiveNode = (nextIndex: number) => {
    if (orderedNodes.length === 0) return;
    const boundedIndex = (nextIndex + orderedNodes.length) % orderedNodes.length;
    const nextNode = orderedNodes[boundedIndex];
    setActiveNodeId(nextNode.id);
    nodeButtonRefs.current[nextNode.id]?.focus();
  };

  const handleNodeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        moveActiveNode(index + 1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        moveActiveNode(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveActiveNode(0);
        break;
      case 'End':
        event.preventDefault();
        moveActiveNode(orderedNodes.length - 1);
        break;
      default:
        break;
    }
  };

  const visibleNodeCount = truncation?.nodes_returned ?? nodes.length;
  const visibleLinkCount = truncation?.edges_returned ?? links.length;
  const scopeNodeCount = Math.max(totalNodes ?? visibleNodeCount, visibleNodeCount);
  const scopeLinkCount = Math.max(totalLinks ?? visibleLinkCount, visibleLinkCount);
  const nodeCountSummary = truncation?.truncated && scopeNodeCount <= visibleNodeCount
    ? `Showing ${visibleNodeCount} visible entities; more are available`
    : `Showing ${visibleNodeCount} of ${scopeNodeCount} entities`;
  const linkCountSummary = truncation?.truncated && scopeLinkCount <= visibleLinkCount
    ? `${visibleLinkCount} visible relations; more are available`
    : `${visibleLinkCount} of ${scopeLinkCount} relations`;
  const canRequestDepthTwo = Boolean(onRequestDepthTwo && selectedEntityId && depth < 2);

  return (
    <section
      className={`muster-panel flex min-h-0 flex-col gap-3 p-3 ${className}`}
      aria-labelledby="knowledge-context-list-title"
      data-testid="knowledge-entity-relation-list"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="knowledge-context-list-title" className="flex items-center gap-2 text-sm font-semibold muster-text-primary">
            <Network className="h-4 w-4 muster-accent" aria-hidden="true" />
            Context entities and relations
          </h2>
          <p className="mt-1 text-xs muster-text-muted" aria-live="polite" data-testid="graph-context-summary">
            {nodeCountSummary} and {linkCountSummary}
            {depth > 0 ? ` · ${depth}-hop context` : ' · overview'}
          </p>
        </div>
        {canRequestDepthTwo && (
          <button
            type="button"
            className="muster-btn muster-btn-soft muster-touch-target"
            onClick={onRequestDepthTwo}
            aria-label="Show second-degree context"
          >
            <Waypoints className="h-4 w-4" aria-hidden="true" />
            Show second degree
          </button>
        )}
      </div>

      {truncation?.truncated && (
        <div className="muster-badge muster-badge-warning w-full justify-start gap-2 normal-case tracking-normal" role="status">
          <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            This is a bounded context. Expand a branch to load more entities
            {truncation.expandable_entity_ids.length > 0 ? '.' : ' when available.'}
          </span>
        </div>
      )}

      <div className="grid min-h-0 gap-4 md:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide muster-text-muted">Entities</h3>
            <span className="text-[11px] muster-text-faint">{visibleNodeCount} visible</span>
          </div>
          {orderedNodes.length === 0 ? (
            <p className="rounded-md border border-dashed border-muster-border p-3 text-xs muster-text-muted">
              Select an entity to open its context.
            </p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto pr-1" aria-label="Knowledge graph entities">
              {orderedNodes.map((node, index) => {
                const isSelected = node.id === selectedEntityId;
                const canExpand = expandableIds.has(node.id) && Boolean(onExpandNode);
                return (
                  <li key={node.id} className="flex items-stretch gap-1">
                    <button
                      ref={(element) => {
                        nodeButtonRefs.current[node.id] = element;
                      }}
                      type="button"
                      className={`flex min-w-0 flex-1 items-center gap-2 rounded-md border border-muster-border bg-muster-surface px-2 py-2 text-left text-xs transition-colors ${isSelected ? 'muster-accent-bg muster-accent-border' : 'hover:bg-muster-surface-hover'}`}
                      aria-pressed={isSelected}
                      aria-label={`${node.name}, ${displayType(node.type)}${node.identifier ? `, ${node.identifier}` : ''}${node.fact_count ? `, ${node.fact_count} facts` : ''}`}
                      tabIndex={activeNodeId === node.id ? 0 : -1}
                      onFocus={() => setActiveNodeId(node.id)}
                      onKeyDown={(event) => handleNodeKeyDown(event, index)}
                      onClick={() => {
                        setActiveNodeId(node.id);
                        onSelectNode(node);
                      }}
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-muster-border muster-text-muted" aria-hidden="true">
                        {node.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium muster-text-primary">{node.name}</span>
                        <span className="block truncate muster-text-faint">
                          {displayType(node.type)}{node.identifier && node.identifier !== node.name ? ` · ${node.identifier}` : ''}
                        </span>
                      </span>
                      {node.fact_count > 0 && (
                        <span className="shrink-0 rounded-full bg-muster-surface-hover px-1.5 py-0.5 text-[10px] muster-text-muted" aria-label={`${node.fact_count} facts`}>
                          {node.fact_count}
                        </span>
                      )}
                    </button>
                    {canExpand && (
                      <button
                        type="button"
                        className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target shrink-0"
                        onClick={() => onExpandNode?.(node)}
                        aria-label={`Expand context for ${node.name}`}
                        title={`Expand context for ${node.name}`}
                      >
                        <Expand className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide muster-text-muted">Relations</h3>
            <span className="text-[11px] muster-text-faint">{visibleLinkCount} visible</span>
          </div>
          {orderedLinks.length === 0 ? (
            <p className="rounded-md border border-dashed border-muster-border p-3 text-xs muster-text-muted">
              No relations are available in this context.
            </p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto pr-1" aria-label="Knowledge graph relations">
              {orderedLinks.map((link) => {
                const label = relationLabel(link, nodeById);
                return (
                  <li key={link.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md border border-muster-border bg-muster-surface px-2 py-2 text-left text-xs hover:bg-muster-surface-hover"
                      onClick={() => {
                        onSelectRelation?.(link);
                        const source = nodeById.get(link.source);
                        if (source) onSelectNode(source);
                      }}
                      aria-label={`Relation: ${label}`}
                    >
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 muster-accent" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium muster-text-primary">{label}</span>
                        {link.description && <span className="block truncate muster-text-faint">{link.description}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
};
