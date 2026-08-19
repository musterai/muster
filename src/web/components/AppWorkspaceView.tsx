import React from 'react';
import {
  useActivityWorkspace,
  useAdminWorkspace,
  useAgentWorkspace,
  useBoardWorkspace,
  useDocumentWorkspace,
  useKnowledgeWorkspace,
  useWorkspaceNavigation,
} from '../WorkspaceViewContext.js';
import { AgentGrid } from './AgentGrid.js';
import { DocumentVault } from './DocumentVault.js';
import { KanbanBoard } from './KanbanBoard.js';
import { KnowledgeBaseView } from './KnowledgeBase.js';
import { TacticalTerminal } from './TacticalTerminal.js';
import { TokensView } from './TokensView.js';
import { WorkspaceAdmin } from './WorkspaceAdmin.js';

const BoardWorkspaceView = React.memo(() => {
  const { data, requests, actions } = useBoardWorkspace();
  return <KanbanBoard
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
  />;
});

const AgentWorkspaceView = React.memo(() => {
  const { data, actions } = useAgentWorkspace();
  return <AgentGrid
    agents={data.agents}
    users={data.users}
    cards={data.cards}
    workspaceId={data.workspaceId}
    onHeartbeat={actions.heartbeat}
    onUnregisterAgent={actions.unregister}
    onOpenRegisterAgent={actions.requestRegister}
    onRefresh={actions.refresh}
  />;
});

const DocumentWorkspaceView = React.memo(() => {
  const { data, actions } = useDocumentWorkspace();
  return <DocumentVault
    documents={data.documents}
    selectedDocId={data.selectedDocId}
    onSelectDoc={actions.select}
    onOpenNewDoc={actions.requestNew}
    onRefresh={actions.refresh}
  />;
});

const KnowledgeWorkspaceView = React.memo(() => {
  const { data, actions } = useKnowledgeWorkspace();
  return <KnowledgeBaseView
    currentProject={data.currentProject}
    initialEntityId={data.selectedEntityId}
    onSelectEntity={actions.selectEntity}
  />;
});

const ActivityWorkspaceView = React.memo(() => {
  const { data, actions } = useActivityWorkspace();
  return <TacticalTerminal
    events={data.events}
    agents={data.agents}
    cards={data.cards}
    documents={data.documents}
    onRefresh={actions.refresh}
  />;
});

const AdminWorkspaceView = React.memo(() => {
  const { workspaceId, currentUser, authMode } = useAdminWorkspace();
  return workspaceId
    ? <WorkspaceAdmin workspaceId={workspaceId} currentUser={currentUser} authMode={authMode} />
    : <div className="text-center py-16 muster-text-muted text-sm">No workspace found yet.</div>;
});

export const AppWorkspaceView: React.FC = React.memo(() => {
  const { activeTab, activeViewTitle } = useWorkspaceNavigation();
  return (
    <main aria-labelledby="active-view-heading" className="flex-1 flex flex-col min-h-0 w-full px-4 sm:px-6 lg:px-8 pt-4 pb-16 md:pb-4 overflow-hidden">
      <h1 id="active-view-heading" className="sr-only">{activeViewTitle}</h1>
      {activeTab === 'agents' && <AgentWorkspaceView />}
      {activeTab === 'board' && <BoardWorkspaceView />}
      {activeTab === 'docs' && <DocumentWorkspaceView />}
      {activeTab === 'kb' && <KnowledgeWorkspaceView />}
      {activeTab === 'activity' && <ActivityWorkspaceView />}
      {activeTab === 'tokens' && (
        <div className="muster-panel p-6 max-w-4xl mx-auto my-8 space-y-4">
          <h2 className="text-sm font-bold muster-text-primary">API Tokens Management</h2>
          <TokensView />
        </div>
      )}
      {activeTab === 'admin' && <AdminWorkspaceView />}
    </main>
  );
});
