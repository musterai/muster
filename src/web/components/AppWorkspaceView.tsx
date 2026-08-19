import React, { lazy } from 'react';
import {
  useActivityWorkspace,
  useAdminWorkspace,
  useAgentWorkspace,
  useBoardWorkspace,
  useDocumentWorkspace,
  useKnowledgeWorkspace,
  useWorkspaceNavigation,
} from '../WorkspaceViewContext.js';
import { LazyBoundary, LazyViewRegion } from './LazyBoundary.js';

const AgentGrid = lazy(() => import('./AgentGrid.js').then((module) => ({ default: module.AgentGrid })));
const KanbanBoard = lazy(() => import('./KanbanBoard.js').then((module) => ({ default: module.KanbanBoard })));
const DocumentVault = lazy(() => import('./DocumentVault.js').then((module) => ({ default: module.DocumentVault })));
const TacticalTerminal = lazy(() => import('./TacticalTerminal.js').then((module) => ({ default: module.TacticalTerminal })));
const KnowledgeBaseView = lazy(() => import('./KnowledgeBase.js').then((module) => ({ default: module.KnowledgeBaseView })));
const TokensView = lazy(() => import('./TokensView.js').then((module) => ({ default: module.TokensView })));
const WorkspaceAdmin = lazy(() => import('./WorkspaceAdmin.js').then((module) => ({ default: module.WorkspaceAdmin })));

const BoardWorkspaceView = React.memo<{ focusVersion: number }>(({ focusVersion }) => {
  const { data, requests, actions } = useBoardWorkspace();
  return <LazyBoundary label="Kanban Board" resetKey="board">
    <LazyViewRegion label="Kanban Board" focusVersion={focusVersion}>
      <KanbanBoard
        boards={data.boards}
        board={data.board}
        selectedBoardId={data.selectedBoardId}
        onSelectBoard={actions.selectBoard}
        columns={data.columns}
        cards={data.cards}
        agents={data.agents}
        users={data.users}
        currentUser={data.currentUser}
        documents={data.documents}
        projectId={data.projectId}
        newCardRequest={requests.newCard}
        openCardRequest={requests.openCard}
        onMoveCard={actions.moveCard}
        onMoveColumn={actions.moveColumn}
        onNewCardRequestHandled={actions.newCardRequestHandled}
        onOpenCardRequestHandled={actions.openCardRequestHandled}
        onOpenNewColumn={actions.requestNewColumn}
        onOpenNewBoard={actions.requestNewBoard}
        onDeleteBoard={actions.deleteBoard}
        onOpenDocumentInVault={actions.openDocumentInVault}
        onRefresh={actions.refresh}
      />
    </LazyViewRegion>
  </LazyBoundary>;
});

const AgentWorkspaceView = React.memo<{ focusVersion: number }>(({ focusVersion }) => {
  const { data, actions } = useAgentWorkspace();
  return <LazyBoundary label="Agents" resetKey="agents">
    <LazyViewRegion label="Agents" focusVersion={focusVersion}>
      <AgentGrid
        agents={data.agents}
        users={data.users}
        cards={data.cards}
        workspaceId={data.workspaceId}
        onHeartbeat={actions.heartbeat}
        onUnregisterAgent={actions.unregister}
        onOpenRegisterAgent={actions.requestRegister}
        onRefresh={actions.refresh}
      />
    </LazyViewRegion>
  </LazyBoundary>;
});

const DocumentWorkspaceView = React.memo<{ focusVersion: number }>(({ focusVersion }) => {
  const { data, actions } = useDocumentWorkspace();
  return <LazyBoundary label="Design Documents" resetKey={`docs:${data.selectedDocId ?? ''}`}>
    <LazyViewRegion label="Design Documents" focusVersion={focusVersion}>
      <DocumentVault
        documents={data.documents}
        selectedDocId={data.selectedDocId}
        onSelectDoc={actions.select}
        onOpenNewDoc={actions.requestNew}
        onRefresh={actions.refresh}
      />
    </LazyViewRegion>
  </LazyBoundary>;
});

const KnowledgeWorkspaceView = React.memo<{ focusVersion: number }>(({ focusVersion }) => {
  const { data, actions } = useKnowledgeWorkspace();
  return <LazyBoundary label="Knowledge Base" resetKey={`kb:${data.selectedEntityId ?? ''}`}>
    <LazyViewRegion label="Knowledge Base" focusVersion={focusVersion}>
      <KnowledgeBaseView
        currentProject={data.currentProject}
        initialEntityId={data.selectedEntityId}
        onSelectEntity={actions.selectEntity}
      />
    </LazyViewRegion>
  </LazyBoundary>;
});

const ActivityWorkspaceView = React.memo<{ focusVersion: number }>(({ focusVersion }) => {
  const { data, actions } = useActivityWorkspace();
  return <LazyBoundary label="Activity Log" resetKey="activity">
    <LazyViewRegion label="Activity Log" focusVersion={focusVersion}>
      <TacticalTerminal
        events={data.events}
        agents={data.agents}
        cards={data.cards}
        documents={data.documents}
        onRefresh={actions.refresh}
      />
    </LazyViewRegion>
  </LazyBoundary>;
});

const AdminWorkspaceView = React.memo<{ focusVersion: number }>(({ focusVersion }) => {
  const { workspaceId, currentUser, authMode } = useAdminWorkspace();
  return <LazyBoundary label="Workspace Admin" resetKey={`admin:${workspaceId ?? ''}`}>
    <LazyViewRegion label="Workspace Admin" focusVersion={focusVersion}>
      {workspaceId
        ? <WorkspaceAdmin workspaceId={workspaceId} currentUser={currentUser} authMode={authMode} />
        : <div className="text-center py-16 muster-text-muted text-sm">No workspace found yet.</div>}
    </LazyViewRegion>
  </LazyBoundary>;
});

export const AppWorkspaceView: React.FC = React.memo(() => {
  const { activeTab, activeViewTitle, viewFocusVersion } = useWorkspaceNavigation();
  return (
    <main aria-labelledby="active-view-heading" className="flex-1 flex flex-col min-h-0 w-full px-4 sm:px-6 lg:px-8 pt-4 pb-16 md:pb-4 overflow-hidden">
      <h1 id="active-view-heading" className="sr-only">{activeViewTitle}</h1>
      {activeTab === 'agents' && <AgentWorkspaceView focusVersion={viewFocusVersion} />}
      {activeTab === 'board' && <BoardWorkspaceView focusVersion={viewFocusVersion} />}
      {activeTab === 'docs' && <DocumentWorkspaceView focusVersion={viewFocusVersion} />}
      {activeTab === 'kb' && <KnowledgeWorkspaceView focusVersion={viewFocusVersion} />}
      {activeTab === 'activity' && <ActivityWorkspaceView focusVersion={viewFocusVersion} />}
      {activeTab === 'tokens' && (
        <LazyBoundary label="API Tokens" resetKey="tokens">
          <LazyViewRegion label="API Tokens" focusVersion={viewFocusVersion}>
            <div className="muster-panel p-6 max-w-4xl mx-auto my-8 space-y-4">
              <h2 className="text-sm font-bold muster-text-primary">API Tokens Management</h2>
              <TokensView />
            </div>
          </LazyViewRegion>
        </LazyBoundary>
      )}
      {activeTab === 'admin' && <AdminWorkspaceView focusVersion={viewFocusVersion} />}
    </main>
  );
});
