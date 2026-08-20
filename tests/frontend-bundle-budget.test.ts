import { describe, expect, it } from 'vitest';
import { checkBundleBudget } from '../scripts/check-frontend-bundle.mjs';

const files = {
  entry: 'assets/index-abc.js',
  board: 'assets/KanbanBoard-abc.js',
  knowledge: 'assets/KnowledgeBase-abc.js',
  connections: 'assets/KnowledgeConnections-abc.js',
  agents: 'assets/AgentGrid-abc.js',
  graph: 'assets/vendor-graph-abc.js',
};

function fixture() {
  const manifest = {
    'index.html': {
      file: files.entry,
      src: 'index.html',
      isEntry: true,
      imports: [],
      dynamicImports: ['components/KanbanBoard.tsx', 'components/KnowledgeBase.tsx', 'components/AgentGrid.tsx'],
    },
    'components/KanbanBoard.tsx': {
      file: files.board,
      src: 'components/KanbanBoard.tsx',
      isDynamicEntry: true,
      imports: [],
    },
    'components/KnowledgeBase.tsx': {
      file: files.knowledge,
      src: 'components/KnowledgeBase.tsx',
      isDynamicEntry: true,
      imports: [],
      dynamicImports: ['components/KnowledgeConnections.tsx'],
    },
    'components/KnowledgeConnections.tsx': {
      file: files.connections,
      src: 'components/KnowledgeConnections.tsx',
      isDynamicEntry: true,
      imports: ['_vendor-graph.js'],
    },
    'components/AgentGrid.tsx': {
      file: files.agents,
      src: 'components/AgentGrid.tsx',
      isDynamicEntry: true,
      imports: [],
    },
    '_vendor-graph.js': { file: files.graph, name: 'vendor-graph' },
  };
  const chunk = (
    file: string,
    name: string,
    facadeModuleId: string | null,
    moduleIds: string[],
    imports: string[] = [],
    dynamicImports: string[] = [],
    isEntry = false,
  ) => ({
    file,
    name,
    facadeModuleId,
    moduleIds,
    imports,
    dynamicImports,
    isEntry,
    isDynamicEntry: !isEntry && facadeModuleId !== null,
  });
  const metadata = {
    version: 1,
    chunks: [
      chunk(files.entry, 'index', 'index.html', ['main.tsx'], [], [files.board, files.knowledge, files.agents], true),
      chunk(files.board, 'KanbanBoard', 'components/KanbanBoard.tsx', ['components/KanbanBoard.tsx']),
      chunk(files.knowledge, 'KnowledgeBase', 'components/KnowledgeBase.tsx', ['components/KnowledgeBase.tsx'], [], [files.connections]),
      chunk(files.connections, 'KnowledgeConnections', 'components/KnowledgeConnections.tsx', ['components/KnowledgeConnections.tsx'], [files.graph]),
      chunk(files.agents, 'AgentGrid', 'components/AgentGrid.tsx', ['components/AgentGrid.tsx']),
      chunk(files.graph, 'vendor-graph', null, [
        'node_modules/vis-data/peer/esm/vis-data.mjs',
        'node_modules/vis-network/standalone/esm/vis-network.mjs',
      ]),
    ],
  };
  const budget = {
    initialEntry: { maxBytes: 100, maxGzipBytes: 100 },
    initialRoute: { sources: ['components/KanbanBoard.tsx'], maxBytes: 1000, maxGzipBytes: 1000 },
    defaultChunk: { maxBytes: 100, maxGzipBytes: 100 },
    chunkOverrides: {
      graphVendor: {
        chunkName: 'vendor-graph',
        maxBytes: 1000,
        maxGzipBytes: 1000,
        reason: 'Graph-only dependency bundle.',
        allowedModulePrefixes: [
          'node_modules/vis-network/',
          'node_modules/vis-data/',
          'node_modules/vis-util/',
          'node_modules/component-emitter/',
          'node_modules/keycharm/',
          'node_modules/uuid/',
        ],
        requiredModulePrefixes: ['node_modules/vis-network/', 'node_modules/vis-data/'],
        allowedImporterFacades: ['components/KnowledgeConnections.tsx'],
      },
    },
  };
  const sizes: Record<string, { bytes: number; gzipBytes: number }> = {
    [files.entry]: { bytes: 10, gzipBytes: 10 },
    [files.board]: { bytes: 20, gzipBytes: 20 },
    [files.knowledge]: { bytes: 20, gzipBytes: 20 },
    [files.connections]: { bytes: 20, gzipBytes: 20 },
    [files.agents]: { bytes: 20, gzipBytes: 20 },
    [files.graph]: { bytes: 500, gzipBytes: 500 },
  };
  return {
    manifest,
    metadata,
    budget,
    sizeOf: (file: string) => {
      if (!sizes[file]) throw new Error(`missing fixture size for ${file}`);
      return sizes[file];
    },
  };
}

describe('frontend bundle budget provenance', () => {
  it('accepts legitimate cross-bound graph-only output imported only by Knowledge Base', () => {
    expect(checkBundleBudget(fixture()).failures).toEqual([]);
  });

  it('rejects the reviewer AgentGrid-to-graph manifest remap', () => {
    const data = fixture();
    data.manifest['components/AgentGrid.tsx'].file = files.graph;
    expect(() => checkBundleBudget(data)).toThrow(/Vite manifest maps .*vendor-graph.* more than once/);
  });

  it('rejects duplicate Rollup metadata file records', () => {
    const data = fixture();
    data.metadata.chunks.push({ ...structuredClone(data.metadata.chunks.at(-1)!), name: 'disguised-graph' });
    expect(() => checkBundleBudget(data)).toThrow(/Rollup bundle metadata maps .*vendor-graph.* more than once/);
  });

  it('rejects unrelated modules injected into the graph exception', () => {
    const data = fixture();
    data.metadata.chunks.at(-1)!.moduleIds.push('components/AgentGrid.tsx');
    expect(checkBundleBudget(data).failures.join('\n')).toMatch(/non-allowlisted modules: components\/AgentGrid\.tsx/);
  });

  it('rejects an extra default-route importer and graph reachability', () => {
    const data = fixture();
    const board = data.metadata.chunks.find((chunk) => chunk.file === files.board)!;
    board.imports.push(files.graph);
    data.manifest['components/KanbanBoard.tsx'].imports.push('_vendor-graph.js');
    const failures = checkBundleBudget(data).failures.join('\n');
    expect(failures).toMatch(/importers must be exactly components\/KnowledgeConnections\.tsx/);
    expect(failures).toMatch(/reachable from the default startup route/);
  });

  it('rejects the exact relabeled-facade mutation when AgentGrid becomes the actual graph importer', () => {
    const data = fixture();
    data.manifest['components/KnowledgeBase.tsx'].imports = [];
    data.manifest['components/AgentGrid.tsx'].imports = ['_vendor-graph.js'];
    const knowledge = data.metadata.chunks.find((chunk) => chunk.file === files.knowledge)!;
    const agents = data.metadata.chunks.find((chunk) => chunk.file === files.agents)!;
    knowledge.imports = [];
    agents.imports = [files.graph];
    agents.facadeModuleId = 'components/KnowledgeBase.tsx';

    expect(() => checkBundleBudget(data)).toThrow(/Rollup facade components\/KnowledgeBase\.tsx maps to more than one output file/);
  });

  it('requires exact converted Vite and Rollup import-edge equality', () => {
    const data = fixture();
    data.manifest['components/AgentGrid.tsx'].imports = ['_vendor-graph.js'];
    expect(() => checkBundleBudget(data)).toThrow(/Vite and Rollup imports disagree for .*AgentGrid/);
  });

  it('requires exact converted Vite and Rollup dynamic-import-edge equality', () => {
    const data = fixture();
    data.manifest['index.html'].dynamicImports = ['components/KanbanBoard.tsx', 'components/KnowledgeBase.tsx'];
    expect(() => checkBundleBudget(data)).toThrow(/Vite and Rollup dynamicImports disagree for .*index/);
  });

  it('rejects an allowed-prefix traversal module before graph-package allowlisting', () => {
    const data = fixture();
    data.metadata.chunks.at(-1)!.moduleIds.push('node_modules/vis-network/../../components/AgentGrid.tsx');
    expect(checkBundleBudget(data).failures.join('\n')).toMatch(
      /must not contain non-canonical or traversal segments: node_modules\/vis-network\/\.\.\/\.\.\/components\/AgentGrid\.tsx/,
    );
  });

  it('rejects an exception without a documented reason', () => {
    const data = fixture();
    data.budget.chunkOverrides.graphVendor.reason = '';
    expect(() => checkBundleBudget(data)).toThrow(/reason must document/);
  });

  it('rejects a stale exception whose exact chunk identity disappeared', () => {
    const data = fixture();
    data.budget.chunkOverrides.graphVendor.chunkName = 'renamed-graph';
    const failures = checkBundleBudget(data).failures.join('\n');
    expect(failures).toMatch(/must match exactly one Rollup chunk named renamed-graph \(found 0\)/);
    expect(failures).toMatch(/vendor-graph.*exceeds/);
  });
});
