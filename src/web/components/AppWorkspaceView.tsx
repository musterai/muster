import React from 'react';
import { useWorkspaceView } from '../WorkspaceViewContext.js';
import { AgentGrid } from './AgentGrid.js';
import { DocumentVault } from './DocumentVault.js';
import { KanbanBoard } from './KanbanBoard.js';
import { KnowledgeBaseView } from './KnowledgeBase.js';
import { TacticalTerminal } from './TacticalTerminal.js';
import { TokensView } from './TokensView.js';
import { WorkspaceAdmin } from './WorkspaceAdmin.js';

export const AppWorkspaceView: React.FC = () => {
  const {
    navigation: {
      activeTab,
      activeViewTitle,
      selectedProjectId,
      selectedBoardId,
      selectedDocId,
      selectedEntityId,
    },
    data: {
      projects,
      boards,
      board,
      columns,
      cards,
      agents,
      users,
      currentUser,
      authMode,
      documents,
      events,
      workspaceId,
    },
    requests: {
      newCard: newCardRequest,
      openCard: openCardRequest,
    },
    actions: {
      agentHeartbeat: onAgentHeartbeat,
      unregisterAgent: onUnregisterAgent,
      requestRegisterAgent: onRequestRegisterAgent,
      refresh: onRefresh,
      selectBoard: onSelectBoard,
      moveCard: onMoveCard,
      moveColumn: onMoveColumn,
      newCardRequestHandled: onNewCardRequestHandled,
      openCardRequestHandled: onOpenCardRequestHandled,
      requestNewColumn: onRequestNewColumn,
      requestNewBoard: onRequestNewBoard,
      deleteBoard: onDeleteBoard,
      openDocumentInVault: onOpenDocumentInVault,
      selectDoc: onSelectDoc,
      requestNewDoc: onRequestNewDoc,
      selectEntity: onSelectEntity,
    },
  } = useWorkspaceView();

  return (
    <main aria-labelledby="active-view-heading" className="flex-1 flex flex-col min-h-0 w-full px-4 sm:px-6 lg:px-8 pt-4 pb-16 md:pb-4 overflow-hidden">
      <h1 id="active-view-heading" className="sr-only">{activeViewTitle}</h1>
      {activeTab === 'agents' && (
        <AgentGrid agents={agents} users={users} cards={cards} workspaceId={workspaceId} onHeartbeat={onAgentHeartbeat} onUnregisterAgent={onUnregisterAgent} onOpenRegisterAgent={onRequestRegisterAgent} onRefresh={onRefresh} />
      )}
      {activeTab === 'board' && (
        <KanbanBoard
          boards={boards} board={board} selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard}
          columns={columns} cards={cards} agents={agents} users={users} currentUser={currentUser}
          documents={documents} projectId={selectedProjectId} newCardRequest={newCardRequest}
          openCardRequest={openCardRequest} onMoveCard={onMoveCard} onMoveColumn={onMoveColumn}
          onNewCardRequestHandled={onNewCardRequestHandled} onOpenCardRequestHandled={onOpenCardRequestHandled}
          onOpenNewColumn={onRequestNewColumn} onOpenNewBoard={onRequestNewBoard} onDeleteBoard={onDeleteBoard}
          onOpenDocumentInVault={onOpenDocumentInVault} onRefresh={onRefresh}
        />
      )}
      {activeTab === 'docs' && <DocumentVault documents={documents} selectedDocId={selectedDocId} onSelectDoc={onSelectDoc} onOpenNewDoc={onRequestNewDoc} onRefresh={onRefresh} />}
      {activeTab === 'kb' && <KnowledgeBaseView currentProject={projects.find((project) => project.id === selectedProjectId) || null} initialEntityId={selectedEntityId} onSelectEntity={onSelectEntity} />}
      {activeTab === 'activity' && <TacticalTerminal events={events} agents={agents} cards={cards} documents={documents} onRefresh={onRefresh} />}
      {activeTab === 'tokens' && (
        <div className="muster-panel p-6 max-w-4xl mx-auto my-8 space-y-4">
          <h2 className="text-sm font-bold muster-text-primary">API Tokens Management</h2>
          <TokensView />
        </div>
      )}
      {activeTab === 'admin' && (workspaceId
        ? <WorkspaceAdmin workspaceId={workspaceId} currentUser={currentUser} authMode={authMode} />
        : <div className="text-center py-16 muster-text-muted text-sm">No workspace found yet.</div>)}
    </main>
  );
};
