import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as vis from 'vis-network/standalone/esm/vis-network.js';
import { DataSet } from 'vis-data';
import type {
  KBGraphFilters,
  KBGraphLink,
  KBGraphNode,
  KBGraphTree,
  KBGraphTruncation,
} from '../types.js';
import { KnowledgeEntityRelationList } from './KnowledgeEntityRelationList.js';
import { ZoomIn, ZoomOut, RefreshCw, Move, Search, Zap, Layers3 } from 'lucide-react';
import { useTheme } from '../ThemeContext.js';

export const DEFAULT_GRAPH_NODE_LIMIT = 50;
export const DEFAULT_GRAPH_EDGE_LIMIT = 200;
export const DEPTH_TWO_GRAPH_NODE_LIMIT = 100;
export const DEPTH_TWO_GRAPH_EDGE_LIMIT = 500;

export interface KnowledgeGraphCanvasProps {
  data: KBGraphTree;
  selectedEntityId?: string;
  searchQuery?: string;
  filters?: KBGraphFilters;
  expandedEntityIds?: string[];
  onSelectNode: (node: KBGraphNode) => void;
  onExpandNode?: (node: KBGraphNode) => void;
  onRequestDepthTwo?: () => void;
  onSelectRelation?: (link: KBGraphLink) => void;
  reducedMotion?: boolean;
  showAccessibleList?: boolean;
}

interface BoundedGraph {
  nodes: KBGraphNode[];
  links: KBGraphLink[];
  rootId?: string;
  depth: number;
  totalNodes: number;
  totalLinks: number;
  truncation: KBGraphTruncation;
}

interface GraphPalette {
  bg: string;
  border: string;
  highlightBg: string;
  text: string;
}

// These colors are a categorical chart scale. Type is also rendered as text,
// shape, and an HTML list row, so color is never the only meaning channel.
const TYPE_COLORS_DARK: Record<string, GraphPalette> = {
  ip_address: { bg: '#1e3a8a', border: '#60a5fa', highlightBg: '#2563eb', text: '#dbeafe' },
  email: { bg: '#831843', border: '#f472b6', highlightBg: '#db2777', text: '#fce7f3' },
  server: { bg: '#064e3b', border: '#34d399', highlightBg: '#059669', text: '#d1fae5' },
  service: { bg: '#3b0764', border: '#c084fc', highlightBg: '#7c3aed', text: '#f3e8ff' },
  database: { bg: '#78350f', border: '#fbbf24', highlightBg: '#d97706', text: '#fef3c7' },
  network: { bg: '#0c4a6e', border: '#38bdf8', highlightBg: '#0284c7', text: '#e0f2fe' },
  credential_ref: { bg: '#7f1d1d', border: '#fb7185', highlightBg: '#dc2626', text: '#ffe4e6' },
  person: { bg: '#881337', border: '#fb7185', highlightBg: '#e11d48', text: '#ffe4e6' },
  project: { bg: '#312e81', border: '#a5b4fc', highlightBg: '#4338ca', text: '#e0e7ff' },
  device: { bg: '#164e63', border: '#67e8f9', highlightBg: '#0e7490', text: '#cffafe' },
  custom: { bg: '#1f2937', border: '#9ca3af', highlightBg: '#4b5563', text: '#e5e7eb' },
};

const TYPE_COLORS_LIGHT: Record<string, GraphPalette> = {
  ip_address: { bg: '#dbeafe', border: '#1d4ed8', highlightBg: '#bfdbfe', text: '#1e3a8a' },
  email: { bg: '#fce7f3', border: '#be185d', highlightBg: '#fbcfe8', text: '#831843' },
  server: { bg: '#d1fae5', border: '#047857', highlightBg: '#a7f3d0', text: '#064e3b' },
  service: { bg: '#ede9fe', border: '#6d28d9', highlightBg: '#ddd6fe', text: '#4c1d95' },
  database: { bg: '#fef3c7', border: '#b45309', highlightBg: '#fde68a', text: '#78350f' },
  network: { bg: '#e0f2fe', border: '#0369a1', highlightBg: '#bae6fd', text: '#0c4a6e' },
  credential_ref: { bg: '#fee2e2', border: '#b91c1c', highlightBg: '#fca5a5', text: '#7f1d1d' },
  person: { bg: '#ffe4e6', border: '#be123c', highlightBg: '#fecdd3', text: '#881337' },
  project: { bg: '#e0e7ff', border: '#4338ca', highlightBg: '#c7d2fe', text: '#312e81' },
  device: { bg: '#cffafe', border: '#0e7490', highlightBg: '#a5f3fc', text: '#164e63' },
  custom: { bg: '#f3f4f6', border: '#4b5563', highlightBg: '#e5e7eb', text: '#1f2937' },
};

const TYPE_SHAPES: Record<string, string> = {
  ip_address: 'diamond',
  email: 'ellipse',
  server: 'square',
  service: 'triangle',
  database: 'database',
  network: 'hexagon',
  credential_ref: 'star',
  person: 'dot',
  project: 'box',
  device: 'square',
  custom: 'dot',
};

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stablePosition(id: string): { x: number; y: number } {
  const hash = hashString(id);
  const angle = ((hash % 360) * Math.PI) / 180;
  // Coordinates are a property of the entity, not of the current response
  // order or graph size. That keeps a legacy/full-graph fallback deterministic
  // even when facts are refreshed or a filter changes the ranking order.
  const radius = 120 + ((hash >>> 8) % 7) * 34;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function sortNodes(nodes: KBGraphNode[]): KBGraphNode[] {
  return [...nodes].sort((a, b) =>
    (b.fact_count || 0) - (a.fact_count || 0) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id),
  );
}

function sortLinks(links: KBGraphLink[]): KBGraphLink[] {
  return [...links].sort((a, b) =>
    a.relation_type.localeCompare(b.relation_type) || a.id.localeCompare(b.id),
  );
}

function getLinks(data: KBGraphTree): KBGraphLink[] {
  return data.links?.length ? data.links : data.edges ?? [];
}

function applyFilters(
  nodes: KBGraphNode[],
  links: KBGraphLink[],
  filters?: KBGraphFilters,
): { nodes: KBGraphNode[]; links: KBGraphLink[] } {
  if (!filters) return { nodes, links };
  const kbIds = filters.kb_ids?.length ? new Set(filters.kb_ids) : null;
  const entityTypes = filters.entity_types?.length ? new Set(filters.entity_types) : null;
  const relationTypes = filters.relation_types?.length ? new Set(filters.relation_types) : null;
  const filteredNodes = nodes.filter((node) =>
    (!kbIds || kbIds.has(node.kb_id)) &&
    (!entityTypes || entityTypes.has(node.type)),
  );
  const nodeIds = new Set(filteredNodes.map((node) => node.id));
  const filteredLinks = links.filter((link) =>
    nodeIds.has(link.source) &&
    nodeIds.has(link.target) &&
    (!relationTypes || relationTypes.has(link.relation_type)),
  );
  return { nodes: filteredNodes, links: filteredLinks };
}

/**
 * Build the client-side safety bound used while older controllers still hand
 * the component a full graph. MUS-87 context responses already arrive bounded;
 * this second guard keeps a stale/legacy response from creating a hairball.
 */
export function buildBoundedGraph(
  data: KBGraphTree,
  selectedEntityId?: string,
  expandedEntityIds: string[] = [],
  filters?: KBGraphFilters,
): BoundedGraph {
  const filtered = applyFilters(data.nodes ?? [], getLinks(data), filters);
  const rawNodes = filtered.nodes;
  const rawLinks = filtered.links;
  const rootId = data.root_id ?? selectedEntityId;
  const depth = Math.max(0, Math.min(2, data.depth ?? (rootId ? 1 : 0)));
  const nodeLimit = depth >= 2 ? DEPTH_TWO_GRAPH_NODE_LIMIT : DEFAULT_GRAPH_NODE_LIMIT;
  const edgeLimit = depth >= 2 ? DEPTH_TWO_GRAPH_EDGE_LIMIT : DEFAULT_GRAPH_EDGE_LIMIT;
  const nodeById = new Map(rawNodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Set<string>>();

  rawLinks.forEach((link) => {
    if (!nodeById.has(link.source) || !nodeById.has(link.target)) return;
    const sourceNeighbors = adjacency.get(link.source) ?? new Set<string>();
    sourceNeighbors.add(link.target);
    adjacency.set(link.source, sourceNeighbors);
    const targetNeighbors = adjacency.get(link.target) ?? new Set<string>();
    targetNeighbors.add(link.source);
    adjacency.set(link.target, targetNeighbors);
  });

  const visibleIds = new Set<string>();
  const distances = new Map<string, number>();
  const queue: string[] = [];
  if (rootId && nodeById.has(rootId)) {
    visibleIds.add(rootId);
    distances.set(rootId, 0);
    queue.push(rootId);
  }
  const expanded = new Set(expandedEntityIds);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDistance = distances.get(current) ?? 0;
    const canExpand = currentDistance < depth || expanded.has(current);
    if (!canExpand) continue;
    const nextDistance = Math.min(2, currentDistance + 1);
    const neighbors = [...(adjacency.get(current) ?? [])].sort();
    for (const neighbor of neighbors) {
      if (!distances.has(neighbor)) {
        distances.set(neighbor, nextDistance);
        visibleIds.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  const rankedNodes = rootId && visibleIds.size > 0
    ? sortNodes(rawNodes.filter((node) => visibleIds.has(node.id)))
    : sortNodes(rawNodes);
  const boundedNodes = rankedNodes.slice(0, nodeLimit);
  const boundedIds = new Set(boundedNodes.map((node) => node.id));
  const expandableIds = new Set(data.truncation?.expandable_entity_ids ?? []);
  rawLinks.forEach((link) => {
    if (boundedIds.has(link.source) && !boundedIds.has(link.target)) expandableIds.add(link.source);
    if (boundedIds.has(link.target) && !boundedIds.has(link.source)) expandableIds.add(link.target);
  });
  const boundedLinks = sortLinks(rawLinks.filter((link) => boundedIds.has(link.source) && boundedIds.has(link.target))).slice(0, edgeLimit);
  const totalNodes = filters ? rawNodes.length : Math.max(data.total_nodes ?? 0, rawNodes.length);
  const totalLinks = filters ? rawLinks.length : Math.max(data.total_links ?? 0, rawLinks.length);
  const truncated = Boolean(data.truncation?.truncated) ||
    rawNodes.length > boundedNodes.length ||
    rawLinks.filter((link) => boundedIds.has(link.source) && boundedIds.has(link.target)).length > boundedLinks.length ||
    totalNodes > boundedNodes.length ||
    totalLinks > boundedLinks.length;

  return {
    nodes: boundedNodes,
    links: boundedLinks,
    rootId,
    depth,
    totalNodes,
    totalLinks,
    truncation: {
      truncated,
      node_limit: data.truncation?.node_limit ?? nodeLimit,
      edge_limit: data.truncation?.edge_limit ?? edgeLimit,
      nodes_returned: boundedNodes.length,
      edges_returned: boundedLinks.length,
      expandable_entity_ids: [...expandableIds].sort(),
    },
  };
}

function formatNode(
  node: KBGraphNode,
  isSelected: boolean,
  isRoot: boolean,
  isSearchMatched: boolean,
  isSearchActive: boolean,
  linkCount: number,
  isDark: boolean,
  zoomScale: number,
) {
  const palette = isDark ? TYPE_COLORS_DARK : TYPE_COLORS_LIGHT;
  const colors = palette[node.type] || palette.custom;
  const labelVisible = isSelected || isRoot || isSearchMatched || zoomScale >= 1.08;
  let labelText = labelVisible ? node.name : '';
  if (labelVisible && node.identifier && node.identifier !== node.name) {
    labelText += `\n(${node.identifier})`;
  }

  const factCount = node.fact_count || 0;
  const weight = factCount * 2 + linkCount;
  const baseSize = isSelected || isRoot ? 24 : 18;
  let nodeSize = Math.min(48, baseSize + weight * 3);
  if (isSearchMatched) nodeSize += 6;

  const selectedBorder = isDark ? '#c4b5fd' : '#5b21b6';
  const dimBg = isDark ? '#0f172a' : '#e5e7eb';
  const dimBorder = isDark ? '#1e293b' : '#cbd5e1';
  const dimText = isDark ? '#64748b' : '#94a3b8';
  const strokeColor = isDark ? '#020617' : '#ffffff';
  let bgColor = colors.bg;
  let borderColor = isSelected || isRoot ? selectedBorder : colors.border;
  let textColor = colors.text;
  let borderWidth = isSelected ? 4 : isRoot ? 3 : 2;
  let opacity = 1;
  let shadowSize = isSelected || isRoot ? 14 : 8;
  let shadowColor = isDark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.15)';

  if (isSearchActive) {
    if (isSearchMatched) {
      borderColor = '#f59e0b';
      bgColor = colors.highlightBg;
      borderWidth = 4;
      shadowSize = 16;
      shadowColor = 'rgba(245, 158, 11, 0.8)';
    } else {
      opacity = 0.28;
      bgColor = dimBg;
      borderColor = dimBorder;
      textColor = dimText;
    }
  }

  return {
    id: node.id,
    kb_id: node.kb_id,
    entity_type: node.type,
    label: labelText,
    title: `${node.name} · ${node.type}${node.identifier ? ` · ${node.identifier}` : ''}`,
    shape: TYPE_SHAPES[node.type] || TYPE_SHAPES.custom,
    size: nodeSize,
    opacity,
    font: {
      color: textColor,
      size: isSearchMatched ? 13 : 12,
      face: 'sans-serif',
      multi: 'html',
      strokeWidth: isDark ? 3 : 2,
      strokeColor,
    },
    color: {
      background: bgColor,
      border: borderColor,
      highlight: { background: colors.highlightBg, border: '#f59e0b' },
      hover: { background: colors.highlightBg, border: selectedBorder },
    },
    borderWidth,
    shadow: {
      enabled: true,
      color: shadowColor,
      size: shadowSize,
      x: 2,
      y: 4,
    },
  };
}

function motionAnimation(reducedMotion: boolean, duration: number) {
  return reducedMotion ? false : { duration, easingFunction: 'easeInOutQuad' };
}

function readReducedMotionPreference(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export const KnowledgeGraphCanvas: React.FC<KnowledgeGraphCanvasProps> = ({
  data,
  selectedEntityId,
  searchQuery,
  filters,
  expandedEntityIds = [],
  onSelectNode,
  onExpandNode,
  onRequestDepthTwo,
  onSelectRelation,
  reducedMotion,
  showAccessibleList = true,
}) => {
  const { theme } = useTheme();
  const isDark = theme.mode === 'dark';
  const [systemReducedMotion, setSystemReducedMotion] = useState(readReducedMotionPreference);
  const [zoomScale, setZoomScale] = useState(1);
  const [focusedEdgeIds, setFocusedEdgeIds] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<any>(null);
  const nodesDataSetRef = useRef<DataSet<any> | null>(null);
  const edgesDataSetRef = useRef<DataSet<any> | null>(null);
  const dataNodesRef = useRef<KBGraphNode[]>([]);
  const fittedNodeSetKeyRef = useRef<string | null>(null);
  const renderedClusterKeyRef = useRef<string | null>(null);
  const clusterIdsRef = useRef<Set<string>>(new Set());
  const onSelectNodeRef = useRef(onSelectNode);

  const motionReduced = reducedMotion ?? systemReducedMotion;
  const boundedGraph = useMemo(
    () => buildBoundedGraph(data, selectedEntityId, expandedEntityIds, filters),
    [data, selectedEntityId, expandedEntityIds, filters],
  );
  const searchMatchedIds = useMemo(() => {
    if (!searchQuery?.trim()) return new Set<string>();
    const query = searchQuery.toLowerCase().trim();
    return new Set(
      boundedGraph.nodes
        .filter((node) =>
          node.name.toLowerCase().includes(query) ||
          Boolean(node.identifier?.toLowerCase().includes(query)) ||
          node.type.toLowerCase().includes(query),
        )
        .map((node) => node.id),
    );
  }, [boundedGraph.nodes, searchQuery]);
  const isSearchActive = Boolean(searchQuery?.trim());
  const isOverviewClustered = !boundedGraph.rootId && data.nodes.length > DEFAULT_GRAPH_NODE_LIMIT;
  // A node-set change is the only context change that warrants an automatic
  // fit. Root/selection, labels, edge focus, and metadata refreshes must keep
  // the operator's current viewport intact.
  const nodeSetKey = useMemo(
    () => boundedGraph.nodes.map((node) => node.id).sort().join(','),
    [boundedGraph.nodes],
  );
  const clusterKey = useMemo(
    () => [
      isOverviewClustered ? 'clustered' : 'plain',
      boundedGraph.nodes.map((node) => `${node.id}:${node.kb_id}`).sort().join(','),
    ].join('|'),
    [boundedGraph.nodes, isOverviewClustered],
  );

  useEffect(() => {
    onSelectNodeRef.current = onSelectNode;
  }, [onSelectNode]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (event: MediaQueryListEvent) => setSystemReducedMotion(event.matches);
    mediaQuery.addEventListener?.('change', handleChange);
    return () => mediaQuery.removeEventListener?.('change', handleChange);
  }, []);

  useEffect(() => {
    dataNodesRef.current = boundedGraph.nodes;
  }, [boundedGraph.nodes]);

  // Mount Network once. The HTML list below is the complete keyboard path;
  // this canvas is an optional visual enhancement and never the only control.
  useEffect(() => {
    if (!containerRef.current) return undefined;

    const nodesDataSet = new DataSet([]);
    const edgesDataSet = new DataSet([]);
    nodesDataSetRef.current = nodesDataSet;
    edgesDataSetRef.current = edgesDataSet;

    const options = {
      // Every rendered node receives an explicit deterministic coordinate
      // below. Disable vis' layout/physics work so updates cannot restart a
      // stabilization pass and move the graph under the operator's cursor.
      layout: { improvedLayout: false },
      nodes: { scaling: { min: 14, max: 48 } },
      edges: { smooth: { type: 'continuous', roundness: 0.2 } },
      physics: {
        enabled: false,
        stabilization: false,
      },
      interaction: {
        hover: true,
        tooltipDelay: 180,
        zoomView: true,
        zoomSpeed: 0.05,
        dragView: true,
        dragNodes: true,
        keyboard: false,
      },
    };

    const NetworkConstructor = (vis as any).Network || vis;
    const network = new NetworkConstructor(containerRef.current, { nodes: nodesDataSet, edges: edgesDataSet }, options);
    networkRef.current = network;

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      networkRef.current?.setSize?.('100%', '100%');
      networkRef.current?.redraw?.();
    });
    resizeObserver?.observe(containerRef.current);

    network.on('click', (params: { nodes: (string | number)[] }) => {
      if (!params.nodes.length) return;
      const clickedId = String(params.nodes[0]);
      if (network.isCluster?.(clickedId)) {
        network.openCluster?.(clickedId);
        clusterIdsRef.current.delete(clickedId);
        return;
      }
      const found = dataNodesRef.current.find((node) => node.id === clickedId);
      if (found) onSelectNodeRef.current(found);
    });
    network.on('hoverEdge', (params: { edge?: string | number }) => {
      if (params.edge === undefined) return;
      setFocusedEdgeIds(new Set([String(params.edge)]));
    });
    network.on('blurEdge', () => setFocusedEdgeIds(new Set()));
    network.on('selectEdge', (params: { edges?: (string | number)[] }) => {
      setFocusedEdgeIds(new Set((params.edges ?? []).map(String)));
    });
    network.on('zoom', (params: { scale?: number }) => {
      if (typeof params.scale === 'number') setZoomScale(params.scale);
    });
    network.on('afterDrawing', (context: CanvasRenderingContext2D) => {
      const nodes = dataNodesRef.current;
      const positions = network.getPositions?.(nodes.map((node) => node.id)) ?? {};
      const textColor = getComputedStyle(document.documentElement).getPropertyValue('--color-text-primary').trim() || (isDark ? '#f4f4f5' : '#18181b');
      context.save();
      context.font = 'bold 11px sans-serif';
      context.fillStyle = textColor;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      nodes.forEach((node) => {
        const position = positions[node.id];
        if (!position || !node.fact_count) return;
        context.fillText(`${node.fact_count}`, position.x, position.y);
      });
      context.restore();
    });

    return () => {
      resizeObserver?.disconnect();
      network.destroy?.();
      networkRef.current = null;
      nodesDataSetRef.current = null;
      edgesDataSetRef.current = null;
      clusterIdsRef.current.clear();
    };
    // Mount must be stable; graph motion is explicitly disabled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeExistingClusters = () => {
    const network = networkRef.current;
    if (!network) return;
    [...clusterIdsRef.current].forEach((clusterId) => {
      if (network.isCluster?.(clusterId)) network.openCluster?.(clusterId);
    });
    clusterIdsRef.current.clear();
  };

  const applyOverviewClusters = () => {
    const network = networkRef.current;
    if (!network || !isOverviewClustered) return;
    const byKb = new Map<string, number>();
    boundedGraph.nodes.forEach((node) => byKb.set(node.kb_id, (byKb.get(node.kb_id) ?? 0) + 1));
    byKb.forEach((count, kbId) => {
      if (count < 4) return;
      const clusterId = `kb-cluster-${kbId}`;
      network.cluster?.({
        joinCondition: (nodeOptions: { kb_id?: string; isCluster?: boolean }) => nodeOptions.kb_id === kbId && !nodeOptions.isCluster,
        clusterNodeProperties: {
          id: clusterId,
          label: `KB · ${count} entities`,
          title: `Knowledge Base cluster with ${count} entities`,
          shape: 'hexagon',
          size: 34,
          borderWidth: 3,
        },
      });
      clusterIdsRef.current.add(clusterId);
    });
  };

  // Keep the vis DataSets bounded and preserve positions for rows that remain
  // in the context. Legacy full-graph responses are reduced before rendering.
  useEffect(() => {
    const nodesDataSet = nodesDataSetRef.current;
    const edgesDataSet = edgesDataSetRef.current;
    const network = networkRef.current;
    if (!nodesDataSet || !edgesDataSet || !network) return;

    const clusterStructureChanged = renderedClusterKeyRef.current !== clusterKey;
    if (clusterStructureChanged) closeExistingClusters();
    const degreeMap = new Map<string, number>();
    boundedGraph.links.forEach((link) => {
      degreeMap.set(link.source, (degreeMap.get(link.source) ?? 0) + 1);
      degreeMap.set(link.target, (degreeMap.get(link.target) ?? 0) + 1);
    });
    const nodeIds = new Set(boundedGraph.nodes.map((node) => node.id));
    const existingNodeIds = new Set(nodesDataSet.getIds().map(String));
    existingNodeIds.forEach((id) => {
      if (!nodeIds.has(id)) nodesDataSet.remove(id);
    });
    nodesDataSet.update(boundedGraph.nodes.map((node) => {
      const existing = nodesDataSet.get(node.id) as { x?: number; y?: number } | null;
      const formatted = formatNode(
        node,
        selectedEntityId === node.id,
        boundedGraph.rootId === node.id,
        searchMatchedIds.has(node.id),
        isSearchActive,
        degreeMap.get(node.id) ?? 0,
        isDark,
        zoomScale,
      );
      return existing?.x !== undefined && existing?.y !== undefined
        ? { ...formatted, x: existing.x, y: existing.y }
        : { ...formatted, ...stablePosition(node.id) };
    }));

    const linkIds = new Set(boundedGraph.links.map((link) => link.id));
    const existingLinkIds = new Set(edgesDataSet.getIds().map(String));
    existingLinkIds.forEach((id) => {
      if (!linkIds.has(id)) edgesDataSet.remove(id);
    });
    const selectedOrRoot = selectedEntityId ?? boundedGraph.rootId;
    edgesDataSet.update(boundedGraph.links.map((link) => {
      const isFocused = focusedEdgeIds.has(link.id) ||
        (selectedOrRoot !== undefined && (link.source === selectedOrRoot || link.target === selectedOrRoot));
      const isConnectedToMatch = searchMatchedIds.has(link.source) || searchMatchedIds.has(link.target);
      const baseEdgeColor = isDark ? '#64748b' : '#64748b';
      const dimEdgeColor = isDark ? '#334155' : '#cbd5e1';
      const edgeColor = isSearchActive && !isConnectedToMatch ? dimEdgeColor : baseEdgeColor;
      const edgeOpacity = isSearchActive && !isConnectedToMatch ? 0.2 : 0.82;
      return {
        id: link.id,
        from: link.source,
        to: link.target,
        label: isFocused || zoomScale >= 1.28 ? link.relation_type : '',
        title: `${link.relation_type}${link.description ? ` · ${link.description}` : ''}`,
        font: {
          color: isDark ? '#cbd5e1' : '#475569',
          size: 10,
          face: 'sans-serif',
          strokeWidth: isDark ? 3 : 2,
          strokeColor: isDark ? '#020617' : '#ffffff',
          align: 'horizontal',
        },
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
        color: { color: edgeColor, highlight: '#f59e0b', hover: isDark ? '#c4b5fd' : '#5b21b6', opacity: edgeOpacity },
        width: isFocused ? 3 : 1.6,
        smooth: { type: 'continuous', roundness: 0.2 },
      };
    }));

    if (selectedEntityId) network.selectNodes?.([selectedEntityId]);
    if (clusterStructureChanged && isOverviewClustered) {
      // The cluster operation is intentionally limited to overview mode. A
      // selected context keeps real node identities and stable positions.
      applyOverviewClusters();
    }
    if (clusterStructureChanged) {
      renderedClusterKeyRef.current = clusterKey;
    }
    if (boundedGraph.nodes.length > 0 && fittedNodeSetKeyRef.current !== nodeSetKey) {
      fittedNodeSetKeyRef.current = nodeSetKey;
      // A context fit is intentionally immediate. Selection, search, hover,
      // theme, and zoom updates never reach this branch, so the viewport is
      // preserved while the operator explores the current graph.
      network.fit?.({ animation: false });
    }
  }, [
    boundedGraph,
    clusterKey,
    focusedEdgeIds,
    isDark,
    isOverviewClustered,
    isSearchActive,
    motionReduced,
    searchMatchedIds,
    selectedEntityId,
    nodeSetKey,
    zoomScale,
  ]);

  const handleZoomIn = () => {
    const network = networkRef.current;
    if (!network) return;
    network.moveTo?.({ scale: network.getScale() * 1.12, animation: motionAnimation(motionReduced, 150) });
  };

  const handleZoomOut = () => {
    const network = networkRef.current;
    if (!network) return;
    network.moveTo?.({ scale: network.getScale() / 1.12, animation: motionAnimation(motionReduced, 150) });
  };

  const handleResetView = () => {
    networkRef.current?.fit?.({ animation: motionAnimation(motionReduced, 400) });
  };

  return (
    <div className="muster-panel relative flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <div className="relative min-h-[280px] flex-1 overflow-hidden sm:min-h-[340px] lg:min-h-[360px]">
        {boundedGraph.nodes.length === 0 && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-muster-surface px-4 text-center muster-text-muted">
            <Zap className="mb-3 h-12 w-12 muster-text-faint" aria-hidden="true" />
            <p className="text-base font-medium">No graph context available</p>
            <p className="mt-1 text-sm">Select an entity to open a bounded neighborhood.</p>
          </div>
        )}

        {isSearchActive && (
          <div className="muster-badge muster-badge-warning absolute left-3 top-3 z-20 gap-1.5 px-3 py-1.5 text-xs normal-case tracking-normal backdrop-blur-md" role="status">
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Search active: {searchMatchedIds.size} {searchMatchedIds.size === 1 ? 'node' : 'nodes'} matched</span>
          </div>
        )}

        {isOverviewClustered && (
          <div className="muster-badge absolute bottom-3 left-3 z-20 gap-1.5 px-3 py-1.5 text-xs normal-case tracking-normal backdrop-blur-md" role="status">
            <Layers3 className="h-3.5 w-3.5 muster-accent" aria-hidden="true" />
            <span>Overview grouped by knowledge base · {boundedGraph.nodes.length} visible of {boundedGraph.totalNodes}</span>
          </div>
        )}

        <div className="muster-panel absolute right-3 top-3 z-20 flex items-center gap-1 p-1 backdrop-blur-md" role="toolbar" aria-label="Graph view controls">
          <button type="button" onClick={handleZoomIn} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" title="Zoom in" aria-label="Zoom in">
            <ZoomIn className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={handleZoomOut} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" title="Zoom out" aria-label="Zoom out">
            <ZoomOut className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={handleResetView} className="muster-btn muster-btn-icon muster-btn-soft muster-touch-target" title="Fit graph to screen" aria-label="Fit graph to screen">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div
          ref={containerRef}
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label="Knowledge graph visualization. Use the entity and relation list below to navigate the graph."
        />

        {!isOverviewClustered && boundedGraph.nodes.length > 0 && (
          <div className="muster-panel absolute bottom-3 left-3 z-20 hidden items-center gap-2 px-3 py-1.5 text-[11px] muster-text-muted backdrop-blur-md sm:flex">
            <Move className="h-3.5 w-3.5 muster-accent" aria-hidden="true" />
            <span>Drag to arrange · zoom for labels · select a relation for its label</span>
          </div>
        )}
      </div>

      {showAccessibleList && (
        <KnowledgeEntityRelationList
          nodes={boundedGraph.nodes}
          links={boundedGraph.links}
          selectedEntityId={selectedEntityId}
          depth={boundedGraph.depth}
          totalNodes={boundedGraph.totalNodes}
          totalLinks={boundedGraph.totalLinks}
          truncation={boundedGraph.truncation}
          onSelectNode={onSelectNode}
          onExpandNode={onExpandNode}
          onRequestDepthTwo={onRequestDepthTwo}
          onSelectRelation={onSelectRelation}
          className="max-h-[48vh] shrink-0 overflow-y-auto lg:max-h-[18rem]"
        />
      )}
    </div>
  );
};
