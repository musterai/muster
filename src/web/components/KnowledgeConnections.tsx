import React from 'react';
import type { KBGraphNode, KBGraphTree } from '../types.js';
import { KnowledgeGraphCanvas } from './KnowledgeGraphCanvas.js';
import { KnowledgeEntityRelationList } from './KnowledgeEntityRelationList.js';

export interface KnowledgeConnectionsProps {
  data: KBGraphTree;
  selectedEntityId?: string;
  searchQuery?: string;
  onSelectNode: (node: KBGraphNode) => void;
  onRequestDepthTwo?: () => void;
}

/**
 * The optional connections surface is deliberately its own dynamic-import
 * facade. Keeping the vis renderer behind this boundary means entering
 * Knowledge Home never evaluates or downloads the graph vendor bundle.
 */
export const KnowledgeConnections: React.FC<KnowledgeConnectionsProps> = ({
  data,
  selectedEntityId,
  searchQuery,
  onSelectNode,
  onRequestDepthTwo,
}) => (
  <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,420px)]">
    <section className="flex min-h-[360px] min-w-0 flex-col gap-3" aria-labelledby="knowledge-connections-title">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 id="knowledge-connections-title" className="text-sm font-semibold muster-text-primary">Connections</h2>
          <p className="mt-1 text-xs muster-text-muted">A bounded visual lens for the selected subject.</p>
        </div>
        <span className="muster-badge muster-badge-neutral normal-case tracking-normal">
          {data.depth ? `${data.depth}-hop context` : 'Context'}
        </span>
      </div>
      <div className="muster-panel min-h-[360px] flex-1 overflow-hidden p-2 sm:p-3">
        <KnowledgeGraphCanvas
          data={data}
          selectedEntityId={selectedEntityId}
          searchQuery={searchQuery}
          onSelectNode={onSelectNode}
          onRequestDepthTwo={onRequestDepthTwo}
          showAccessibleList={false}
        />
      </div>
    </section>
    <KnowledgeEntityRelationList
      nodes={data.nodes}
      links={data.links}
      selectedEntityId={selectedEntityId}
      depth={data.depth || 0}
      totalNodes={data.total_nodes}
      totalLinks={data.total_links}
      truncation={data.truncation}
      onSelectNode={onSelectNode}
      onRequestDepthTwo={onRequestDepthTwo}
      className="min-h-[360px]"
    />
  </div>
);

export default KnowledgeConnections;
