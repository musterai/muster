// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/web/api.js';
import { KnowledgeBaseView } from '../src/web/components/KnowledgeBase.js';
import type { KBFact, KBGraphTree, KnowledgeBase, Project } from '../src/web/types.js';

vi.mock('../src/web/components/KnowledgeGraphCanvas.js', () => ({
  KnowledgeGraphCanvas: () => <div data-testid="knowledge-graph" />,
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
    expect(getGraphTree).toHaveBeenCalledWith(kbA.id, undefined, expect.any(AbortSignal));
    expect(getGraphTree).toHaveBeenCalledWith(kbB.id, undefined, expect.any(AbortSignal));

    const factsTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
      .find((button) => button.textContent?.startsWith('Facts'))!;
    await act(async () => factsTab.click());
    expect(container.textContent).toContain('Alpha fact');
    expect(container.textContent).toContain('Bravo fact');
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

    const factsTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
      .find((button) => button.textContent?.startsWith('Facts'))!;
    await act(async () => factsTab.click());
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

    const searchInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      valueSetter.call(searchInput, 'Search');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    });
    expect(searchKnowledge).toHaveBeenCalledTimes(2);
    expect(searchKnowledge).toHaveBeenCalledWith('Search', kbA.id, undefined, expect.any(AbortSignal));
    expect(searchKnowledge).toHaveBeenCalledWith('Search', kbB.id, undefined, expect.any(AbortSignal));

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      valueSetter.call(searchInput, '');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    });
    await settle();

    expect(getKBFacts.mock.calls.length).toBeGreaterThan(2);
    const factsTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
      .find((button) => button.textContent?.startsWith('Facts'))!;
    await act(async () => factsTab.click());
    expect(container.textContent).toContain('Unfiltered browse fact');
    expect(container.textContent).not.toContain('Search-only fact');
  });

  it('keeps successful facts and graph data visible when one scoped request fails', async () => {
    vi.spyOn(api, 'getKBs').mockResolvedValue([kbA, kbB]);
    vi.spyOn(api, 'getKBFacts').mockImplementation(async (kbId) => {
      if (kbId === kbB.id) throw new Error('Bravo facts unavailable');
      return [fact('fact-a', kbA.id, 'Alpha fact survives')];
    });
    vi.spyOn(api, 'getGraphTree').mockImplementation(async (kbId) => {
      if (kbId === kbB.id) throw new Error('Bravo graph unavailable');
      return graph(kbA.id, 'node-alpha');
    });

    await act(async () => {
      root.render(<KnowledgeBaseView currentProject={project} />);
      await Promise.resolve();
    });
    await settle();

    const factsTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
      .find((button) => button.textContent?.startsWith('Facts'))!;
    await act(async () => factsTab.click());
    expect(container.textContent).toContain('Alpha fact survives');
    expect(container.textContent).toContain('Showing the successfully loaded facts');
    expect(container.textContent).not.toContain('Knowledge facts could not be loaded');

    const graphTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
      .find((button) => button.textContent?.startsWith('Graph'))!;
    await act(async () => graphTab.click());
    expect(container.querySelector('[data-testid="knowledge-graph"]')).not.toBeNull();
    expect(container.textContent).toContain('Showing the successfully loaded graph data');
  });
});
