// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/web/api.js';
import { KnowledgeBaseView } from '../src/web/components/KnowledgeBase.js';
import type { KBEntityContext, KBEntitySummary, KBFact, KBFactBrowseSummary, KBGraphTree, KBKnowledgeOverview, KnowledgeBase, Project } from '../src/web/types.js';

vi.mock('../src/web/components/KnowledgeGraphCanvas.js', () => ({
  KnowledgeGraphCanvas: () => <div data-testid="knowledge-graph" />,
}));

vi.mock('../src/web/components/KnowledgeConnections.js', () => ({
  default: () => <div data-testid="knowledge-connections" />,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const project: Project = {
  id: 'project-1', name: 'Muster', slug: 'muster', description: null,
  key_prefix: 'MUS', card_seq: 1, created_at: '', updated_at: '',
};

const kbA: KnowledgeBase = {
  id: 'kb-a', name: 'Alpha KB', description: null, is_global: 1,
  created_at: '', updated_at: '', linked_project_ids: [project.id],
};
const kbB: KnowledgeBase = {
  id: 'kb-b', name: 'Bravo KB', description: null, is_global: 1,
  created_at: '', updated_at: '', linked_project_ids: [project.id],
};

const fact = (id: string, kb_id: string, title: string): KBFact => ({
  id, kb_id, entity_id: null, title, content: `${title} content`, category: 'general',
  confidence: 1, source_principal_id: null, created_at: '', updated_at: '',
});

const graph = (kb_id: string, id: string): KBGraphTree => ({
  nodes: [{ id, kb_id, name: id, type: 'server', identifier: null, fact_count: 1 }],
  links: [], page: { limit: 100, has_more: false, next_cursor: null },
});

const browseSummary = (id: string, title: string): KBFactBrowseSummary => ({
  id,
  title,
  excerpt: `${title} excerpt`,
  knowledge_base: { id: kbA.id, name: kbA.name },
  category: 'general',
  confidence: 1,
  entity: null,
  source: null,
  created_at: '',
  updated_at: '',
});

const overview = (): KBKnowledgeOverview => ({
  scope: { kind: 'project', id: project.id, name: project.name, knowledge_base_count: 2 },
  totals: { facts: 48, attached_facts: 21, unattached_facts: 27, entities: 18, relations: 22 },
  facets: {
    knowledge_bases: { items: [], has_more: false },
    categories: { items: [], has_more: false },
    entity_types: { items: [], has_more: false },
    relation_types: { items: [], has_more: false },
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe('KnowledgeBaseView reliability', () => {
  it('renders the bounded read model as a stream and caches overview while searching', async () => {
    vi.spyOn(api, 'getKBs').mockResolvedValue([kbA, kbB]);
    const getKnowledgeOverview = vi.spyOn(api, 'getKnowledgeOverview').mockResolvedValue(overview());
    const listKnowledge = vi.spyOn(api, 'listKnowledge').mockResolvedValue({
      items: [browseSummary('summary-1', 'Fast stream fact')],
      page: { limit: 24, has_more: true, next_cursor: 'next' },
    });
    const searchKnowledge = vi.spyOn(api, 'searchKnowledge').mockRejectedValue(new Error('legacy search should not run'));
    const getGraphTree = vi.spyOn(api, 'getGraphTree');

    await act(async () => {
      root.render(<KnowledgeBaseView currentProject={project} />);
      await Promise.resolve();
    });
    await settle();

    expect(getKnowledgeOverview).toHaveBeenCalledTimes(1);
    expect(listKnowledge).toHaveBeenCalledWith(
      { project_id: project.id },
      expect.objectContaining({ q: undefined }),
      { limit: 24 },
      expect.any(AbortSignal),
    );
    expect(getGraphTree).not.toHaveBeenCalled();
    expect(container.querySelector('ul[aria-label="Shared knowledge answers"]')).not.toBeNull();
    expect(container.querySelector('ul[aria-label="Shared knowledge answers"] li')).not.toBeNull();
    expect(container.textContent).toContain('Fast stream fact');
    expect(container.textContent).toContain('48 answers in scope');
    expect(container.textContent).toContain('18 subjects');
    expect(container.textContent).toContain('22 connections');

    const searchInput = container.querySelector('#knowledge-home-search') as HTMLInputElement;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      valueSetter.call(searchInput, 'stream');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    });
    await settle();

    expect(searchKnowledge).not.toHaveBeenCalled();
    expect(getKnowledgeOverview).toHaveBeenCalledTimes(1);
    expect(listKnowledge).toHaveBeenLastCalledWith(
      { project_id: project.id },
      expect.objectContaining({ q: 'stream' }),
      { limit: 24 },
      expect.any(AbortSignal),
    );
  });

  it('browses the aggregate scope directly instead of issuing an empty search', async () => {
    const getKBs = vi.spyOn(api, 'getKBs').mockResolvedValue([kbA, kbB]);
    const searchKnowledge = vi.spyOn(api, 'searchKnowledge').mockRejectedValue(new Error('empty search should not run'));
    const getKBFacts = vi.spyOn(api, 'getKBFacts').mockImplementation(async (kbId) => [
      kbId === kbA.id ? fact('fact-a', kbA.id, 'Alpha fact') : fact('fact-b', kbB.id, 'Bravo fact'),
    ]);
    const getGraphTree = vi.spyOn(api, 'getGraphTree').mockImplementation(async (kbId) => graph(kbId!, `node-${kbId}`));

    await act(async () => {
      root.render(<KnowledgeBaseView currentProject={project} />);
      await Promise.resolve();
    });
    await settle();

    expect(getKBs).toHaveBeenCalledWith(project.id, expect.any(AbortSignal));
    expect(searchKnowledge).not.toHaveBeenCalled();
    expect(getKBFacts).toHaveBeenCalledWith(kbA.id, expect.any(AbortSignal));
    expect(getKBFacts).toHaveBeenCalledWith(kbB.id, expect.any(AbortSignal));
    expect(getGraphTree).not.toHaveBeenCalled();

    expect(container.textContent).toContain('Alpha fact');
    expect(container.textContent).toContain('Bravo fact');
    expect(container.querySelector('button[role="tab"]')).toBeNull();
  });

  it('ignores a superseded scope response after switching knowledge bases', async () => {
    vi.spyOn(api, 'getKBs').mockResolvedValue([kbA, kbB]);
    vi.spyOn(api, 'getGraphTree').mockImplementation(async (kbId) => graph(kbId!, `node-${kbId}`));

    let raceMode = false;
    const alpha = deferred<KBFact[]>();
    const bravo = deferred<KBFact[]>();
    vi.spyOn(api, 'getKBFacts').mockImplementation(async (kbId) => {
      if (raceMode && kbId === kbA.id) return alpha.promise;
      if (raceMode && kbId === kbB.id) return bravo.promise;
      return [kbId === kbA.id ? fact('fact-a', kbA.id, 'Alpha fact') : fact('fact-b', kbB.id, 'Bravo fact')];
    });

    await act(async () => {
      root.render(<KnowledgeBaseView currentProject={project} />);
      await Promise.resolve();
    });
    await settle();
    raceMode = true;

    const selector = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      selector.value = kbA.id;
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      selector.value = kbB.id;
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => bravo.resolve([fact('fact-b-new', kbB.id, 'Bravo newest fact')]));
    await settle();
    await act(async () => alpha.resolve([fact('fact-a-old', kbA.id, 'Alpha stale fact')]));
    await settle();

    expect(container.textContent).toContain('Bravo newest fact');
    expect(container.textContent).not.toContain('Alpha stale fact');
  });

  it('restores the aggregate browse result when search is cleared', async () => {
    vi.spyOn(api, 'getKBs').mockResolvedValue([kbA, kbB]);
    const getKBFacts = vi.spyOn(api, 'getKBFacts').mockImplementation(async (kbId) => [
      fact(`browse-${kbId}`, kbId, 'Unfiltered browse fact'),
    ]);
    const searchKnowledge = vi.spyOn(api, 'searchKnowledge').mockResolvedValue({
      facts: [fact('searched', kbA.id, 'Search-only fact')],
      entities: [],
    });
    vi.spyOn(api, 'getGraphTree').mockImplementation(async (kbId) => graph(kbId!, `node-${kbId}`));

    await act(async () => {
      root.render(<KnowledgeBaseView currentProject={project} />);
      await Promise.resolve();
    });
    await settle();

    const searchInput = container.querySelector('#knowledge-home-search') as HTMLInputElement;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      valueSetter.call(searchInput, 'Search');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    });
    expect(searchKnowledge).toHaveBeenCalledTimes(2);
    expect(searchKnowledge).toHaveBeenCalledWith('search', kbA.id, undefined, expect.any(AbortSignal));
    expect(searchKnowledge).toHaveBeenCalledWith('search', kbB.id, undefined, expect.any(AbortSignal));

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      valueSetter.call(searchInput, '');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    });
    await settle();

    expect(getKBFacts.mock.calls.length).toBeGreaterThan(2);
    expect(container.textContent).toContain('Unfiltered browse fact');
    expect(container.textContent).not.toContain('Search-only fact');
  });

  it('keeps successful facts and graph data visible when one scoped request fails', async () => {
    vi.spyOn(api, 'getKBs').mockResolvedValue([kbA, kbB]);
    const getGraphTree = vi.spyOn(api, 'getGraphTree').mockImplementation(async (kbId) => {
      if (kbId === kbB.id) throw new Error('Bravo graph unavailable');
      return graph(kbA.id, 'node-alpha');
    });
    vi.spyOn(api, 'getKBFacts').mockImplementation(async (kbId) => {
      if (kbId === kbB.id) throw new Error('Bravo facts unavailable');
      return [fact('fact-a', kbA.id, 'Alpha fact survives')];
    });

    await act(async () => {
      root.render(<KnowledgeBaseView currentProject={project} />);
      await Promise.resolve();
    });
    await settle();

    expect(container.textContent).toContain('Alpha fact survives');
    expect(container.textContent).toContain('Showing the answers that loaded successfully');
    expect(container.textContent).not.toContain('Knowledge facts could not be loaded');
    expect(getGraphTree).not.toHaveBeenCalled();
  });

  it('opens subjects from Browse & filters and loads optional connections on demand', async () => {
    vi.spyOn(api, 'getKBs').mockResolvedValue([kbA, kbB]);
    vi.spyOn(api, 'getKnowledgeOverview').mockResolvedValue(overview());
    vi.spyOn(api, 'listKnowledge').mockResolvedValue({
      items: [browseSummary('summary-1', 'Answer with a subject')],
      page: { limit: 24, has_more: false, next_cursor: null },
    });
    const subject: KBEntitySummary = {
      id: 'entity-alpha',
      name: 'Alpha server',
      type: 'server',
      identifier: 'alpha.local',
      knowledge_base: { id: kbA.id, name: kbA.name },
      fact_count: 1,
      incoming_relation_count: 0,
      outgoing_relation_count: 1,
      created_at: '',
      updated_at: '',
    };
    const context: KBEntityContext = {
      scope: overview().scope,
      root: subject,
      facts: { items: [], page: { limit: 50, has_more: false, next_cursor: null } },
      nodes: [{ ...subject, depth: 0 }],
      edges: [],
      depth: 1,
      truncation: {
        truncated: false,
        node_limit: 50,
        edge_limit: 200,
        nodes_returned: 1,
        edges_returned: 0,
        expandable_entity_ids: [],
      },
    };
    const listKnowledgeEntities = vi.spyOn(api, 'listKnowledgeEntities').mockResolvedValue({
      items: [subject],
      page: { limit: 100, has_more: false, next_cursor: null },
    });
    const getEntityContext = vi.spyOn(api, 'getEntityContext').mockResolvedValue(context);

    await act(async () => {
      root.render(<KnowledgeBaseView currentProject={project} />);
      await Promise.resolve();
    });
    await settle();

    expect(getEntityContext).not.toHaveBeenCalled();
    const browseButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Browse & filters'))!;
    await act(async () => browseButton.click());
    expect(container.querySelector('[role="group"][aria-label="Browse mode"]')).not.toBeNull();
    const subjectsButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.startsWith('Subjects'))!;
    await act(async () => subjectsButton.click());
    await settle();
    expect(listKnowledgeEntities).toHaveBeenCalledWith({ project_id: project.id }, {}, { limit: 100 }, expect.any(AbortSignal));
    expect(container.textContent).toContain('Alpha server');
    expect(container.textContent).not.toContain('Connections for Alpha server');

    const subjectButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Alpha server'))!;
    await act(async () => subjectButton.click());
    await settle();
    expect(getEntityContext).toHaveBeenCalledWith(
      { kb_id: kbA.id },
      { entity_id: subject.id },
      { depth: 1, max_nodes: 50, max_edges: 200, fact_limit: 50 },
      expect.any(AbortSignal),
    );
    const showConnections = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Show connections'))!;
    expect(showConnections).toBeDefined();
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .some((button) => button.textContent?.includes('Edit subject'))).toBe(true);
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .some((button) => button.textContent?.includes('Add connection'))).toBe(true);
    await act(async () => showConnections.click());
    await settle();
    expect(container.textContent).toContain('Connections for Alpha server');
    const backToAnswers = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Back to answers'))!;
    await act(async () => backToAnswers.click());
    const closeSubject = container.querySelector<HTMLButtonElement>('button[aria-label="Close subject detail"]')!;
    await act(async () => closeSubject.click());
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .some((button) => button.textContent?.includes('Show connections'))).toBe(false);
  });
});
