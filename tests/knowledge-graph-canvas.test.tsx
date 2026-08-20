// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBoundedGraph,
  DEPTH_TWO_GRAPH_EDGE_LIMIT,
  DEPTH_TWO_GRAPH_NODE_LIMIT,
  DEFAULT_GRAPH_EDGE_LIMIT,
  DEFAULT_GRAPH_NODE_LIMIT,
  KnowledgeGraphCanvas,
} from '../src/web/components/KnowledgeGraphCanvas.js';
import { KnowledgeEntityRelationList } from '../src/web/components/KnowledgeEntityRelationList.js';
import type { KBGraphNode, KBGraphTree } from '../src/web/types.js';

const fakeNetworkState = vi.hoisted(() => ({
  instances: [] as Array<{
    options: any;
    handlers: Record<string, (params: any) => void>;
    fitCalls: any[];
    focusCalls: any[];
    stopSimulationCalls: number;
    clusterCalls: any[];
    openClusterCalls: any[];
    data: { nodes: any; edges: any };
  }>,
}));

vi.mock('vis-network/standalone/esm/vis-network.js', () => ({
  Network: class FakeNetwork {
    options: any;
    handlers: Record<string, (params: any) => void> = {};
    fitCalls: any[] = [];
    focusCalls: any[] = [];
    stopSimulationCalls = 0;
    clusterCalls: any[] = [];
    openClusterCalls: any[] = [];
    data: { nodes: any; edges: any };

    constructor(_container: HTMLElement, data: { nodes: any; edges: any }, options: any) {
      this.data = data;
      this.options = options;
      fakeNetworkState.instances.push(this);
    }

    on(event: string, handler: (params: any) => void) { this.handlers[event] = handler; }
    setOptions() {}
    setSize() {}
    redraw() {}
    getPositions() { return {}; }
    getScale() { return 1; }
    fit(options: any) { this.fitCalls.push(options); }
    focus(options: any) { this.focusCalls.push(options); }
    moveTo() {}
    selectNodes() {}
    stopSimulation() { this.stopSimulationCalls += 1; }
    storePositions() {}
    isCluster() { return false; }
    openCluster(id: string) { this.openClusterCalls.push(id); }
    cluster(options: any) { this.clusterCalls.push(options); }
    destroy() {}
  },
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const node = (id: string, factCount = 1): KBGraphNode => ({
  id,
  name: `Entity ${id}`,
  type: id === 'root' ? 'project' : 'server',
  identifier: null,
  kb_id: id.startsWith('a') ? 'kb-a' : 'kb-b',
  fact_count: factCount,
});

const graph = (nodes: KBGraphNode[], links: KBGraphTree['links'], extra: Partial<KBGraphTree> = {}): KBGraphTree => ({
  nodes,
  links,
  page: { limit: 100, has_more: false, next_cursor: null },
  ...extra,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fakeNetworkState.instances.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe('bounded knowledge graph context', () => {
  it('keeps the selected subject plus one hop by default', () => {
    const nodes = ['root', 'n1', 'n2', 'n3'].map((id) => node(id));
    const links = [
      { id: 'r1', source: 'root', target: 'n1', relation_type: 'owns' },
      { id: 'r2', source: 'n1', target: 'n2', relation_type: 'runs_on' },
      { id: 'r3', source: 'n2', target: 'n3', relation_type: 'connected_to' },
    ];
    const bounded = buildBoundedGraph(graph(nodes, links), 'root');

    expect(bounded.depth).toBe(1);
    expect(bounded.nodes.map((entry) => entry.id).sort()).toEqual(['n1', 'root']);
    expect(bounded.links.map((entry) => entry.id)).toEqual(['r1']);
    expect(bounded.truncation.truncated).toBe(true);
    expect(bounded.truncation.expandable_entity_ids).toContain('n1');
  });

  it('allows explicit depth two and enforces the larger 100/500 ceiling', () => {
    const nodes = Array.from({ length: DEPTH_TWO_GRAPH_NODE_LIMIT + 12 }, (_, index) => node(`n${index}`, index));
    const links = Array.from({ length: DEPTH_TWO_GRAPH_EDGE_LIMIT + 12 }, (_, index) => ({
      id: `r${index}`,
      source: `n${index % nodes.length}`,
      target: `n${(index + 1) % nodes.length}`,
      relation_type: 'connected_to',
    }));
    const bounded = buildBoundedGraph(graph(nodes, links, { depth: 2 }), 'n0');

    expect(bounded.depth).toBe(2);
    expect(bounded.nodes.length).toBeLessThanOrEqual(DEPTH_TWO_GRAPH_NODE_LIMIT);
    expect(bounded.links.length).toBeLessThanOrEqual(DEPTH_TWO_GRAPH_EDGE_LIMIT);
    expect(bounded.truncation.node_limit).toBe(DEPTH_TWO_GRAPH_NODE_LIMIT);
    expect(bounded.truncation.edge_limit).toBe(DEPTH_TWO_GRAPH_EDGE_LIMIT);
    expect(bounded.truncation.truncated).toBe(true);
  });

  it('caps an unselected overview and honors graph filters', () => {
    const nodes = Array.from({ length: DEFAULT_GRAPH_NODE_LIMIT + 8 }, (_, index) => node(`a${index}`));
    const links = nodes.slice(1).map((entry, index) => ({
      id: `r${index}`,
      source: nodes[0].id,
      target: entry.id,
      relation_type: index % 2 === 0 ? 'owns' : 'runs_on',
    }));
    const bounded = buildBoundedGraph(graph(nodes, links), undefined, [], { kb_ids: ['kb-a'], relation_types: ['owns'] });

    expect(bounded.nodes.length).toBe(DEFAULT_GRAPH_NODE_LIMIT);
    expect(bounded.links.length).toBeLessThanOrEqual(DEFAULT_GRAPH_EDGE_LIMIT);
    expect(bounded.nodes.every((entry) => entry.kb_id === 'kb-a')).toBe(true);
    expect(bounded.links.every((entry) => entry.relation_type === 'owns')).toBe(true);
    expect(bounded.truncation.node_limit).toBe(DEFAULT_GRAPH_NODE_LIMIT);
  });
});

describe('accessible graph representation', () => {
  it('provides roving entity focus, relation rows, and expansion metadata', async () => {
    const nodes = [node('a1'), node('a2')];
    const links = [{ id: 'r1', source: 'a1', target: 'a2', relation_type: 'owns' }];
    const selected: string[] = [];
    await act(async () => root.render(
      <KnowledgeEntityRelationList
        nodes={nodes}
        links={links}
        selectedEntityId="a1"
        depth={1}
        totalNodes={12}
        totalLinks={18}
        truncation={{ truncated: true, node_limit: 50, edge_limit: 200, nodes_returned: 2, edges_returned: 1, expandable_entity_ids: ['a2'] }}
        onSelectNode={(entry) => selected.push(entry.id)}
        onExpandNode={(entry) => selected.push(`expand:${entry.id}`)}
        onRequestDepthTwo={() => selected.push('depth:2')}
      />,
    ));

    expect(container.textContent).toContain('Showing 2 of 12 entities and 1 of 18 relations');
    expect(container.textContent).toContain('This is a bounded context');
    expect(container.querySelector('[aria-label="Expand context for Entity a2"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Show second-degree context"]')).not.toBeNull();

    const entityButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('ul[aria-label="Knowledge graph entities"] button'));
    expect(entityButtons[0]?.tabIndex).toBe(0);
    expect(entityButtons[1]?.tabIndex).toBe(-1);
    await act(async () => {
      entityButtons[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const movedButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('ul[aria-label="Knowledge graph entities"] button'));
    expect(movedButtons[1]?.tabIndex).toBe(0);
  });

  it('keeps the canvas supplemental while exposing the same HTML list', async () => {
    const nodes = [node('a1'), node('a2')];
    const links = [{ id: 'r1', source: 'a1', target: 'a2', relation_type: 'owns' }];
    await act(async () => root.render(
      <KnowledgeGraphCanvas
        data={graph(nodes, links, { root_id: 'a1', depth: 1 })}
        selectedEntityId="a1"
        onSelectNode={() => {}}
        reducedMotion
      />,
    ));

    expect(container.querySelector('[role="img"][aria-label*="entity and relation list"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="knowledge-entity-relation-list"]')).not.toBeNull();
  });
});

describe('stable canvas lifecycle', () => {
  it('disables physics, uses deterministic coordinates, and does not refit on visual state changes', async () => {
    const nodes = [node('a1'), node('a2')];
    const links = [{ id: 'r1', source: 'a1', target: 'a2', relation_type: 'owns' }];

    await act(async () => root.render(
      <KnowledgeGraphCanvas
        data={graph(nodes, links, { root_id: 'a1', depth: 1 })}
        selectedEntityId="a1"
        searchQuery="server"
        onSelectNode={() => {}}
        reducedMotion={false}
      />,
    ));

    const network = fakeNetworkState.instances[0];
    expect(network).toBeDefined();
    expect(network.options.layout.improvedLayout).toBe(false);
    expect(network.options.physics).toEqual({ enabled: false, stabilization: false });
    expect(network.fitCalls).toHaveLength(1);
    expect(network.fitCalls[0]).toEqual({ animation: false });
    expect(network.focusCalls).toHaveLength(0);
    expect(network.stopSimulationCalls).toBe(0);

    const initialPosition = {
      x: network.data.nodes.get('a1').x,
      y: network.data.nodes.get('a1').y,
    };

    await act(async () => root.render(
      <KnowledgeGraphCanvas
        data={graph([node('a2'), node('a1')], links, { root_id: 'a1', depth: 1 })}
        selectedEntityId="a2"
        searchQuery="a2"
        onSelectNode={() => {}}
        reducedMotion={false}
      />,
    ));

    expect(network.fitCalls).toHaveLength(1);
    expect(network.focusCalls).toHaveLength(0);
    expect(network.data.nodes.get('a1')).toMatchObject(initialPosition);

    await act(async () => {
      network.handlers.hoverEdge?.({ edge: 'r1' });
    });

    expect(network.fitCalls).toHaveLength(1);
    expect(network.focusCalls).toHaveLength(0);
  });

  it('fits once when a genuinely new node context arrives', async () => {
    const firstNodes = [node('a1'), node('a2')];
    const firstLinks = [{ id: 'r1', source: 'a1', target: 'a2', relation_type: 'owns' }];
    await act(async () => root.render(
      <KnowledgeGraphCanvas
        data={graph(firstNodes, firstLinks, { root_id: 'a1', depth: 1 })}
        selectedEntityId="a1"
        onSelectNode={() => {}}
        reducedMotion
      />,
    ));

    const network = fakeNetworkState.instances[0];
    expect(network.fitCalls).toHaveLength(1);

    await act(async () => root.render(
      <KnowledgeGraphCanvas
        data={graph(
          [node('a1'), node('a3')],
          [{ id: 'r2', source: 'a1', target: 'a3', relation_type: 'runs_on' }],
          { root_id: 'a1', depth: 1 },
        )}
        selectedEntityId="a1"
        onSelectNode={() => {}}
        reducedMotion
      />,
    ));

    expect(network.fitCalls).toHaveLength(2);
    expect(network.fitCalls[1]).toEqual({ animation: false });
  });

  it('does not rebuild overview clusters for search or hover styling', async () => {
    const nodes = Array.from({ length: DEFAULT_GRAPH_NODE_LIMIT + 8 }, (_, index) => node(`a${index}`));
    const links = nodes.slice(1).map((entry, index) => ({
      id: `r${index}`,
      source: nodes[0].id,
      target: entry.id,
      relation_type: 'owns',
    }));
    const overview = graph(nodes, links);

    await act(async () => root.render(
      <KnowledgeGraphCanvas
        data={overview}
        searchQuery=""
        onSelectNode={() => {}}
        reducedMotion
      />,
    ));

    const network = fakeNetworkState.instances[0];
    expect(network.clusterCalls).toHaveLength(1);
    expect(network.fitCalls).toHaveLength(1);

    await act(async () => root.render(
      <KnowledgeGraphCanvas
        data={overview}
        searchQuery="Entity a"
        onSelectNode={() => {}}
        reducedMotion
      />,
    ));
    await act(async () => {
      network.handlers.hoverEdge?.({ edge: 'r1' });
    });

    expect(network.clusterCalls).toHaveLength(1);
    expect(network.openClusterCalls).toHaveLength(0);
    expect(network.fitCalls).toHaveLength(1);
  });
});
