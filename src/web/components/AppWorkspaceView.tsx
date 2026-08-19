import React from 'react';
import type { AuthMe, Agent, Board, Card, Column, Document, Event, Project, User } from '../types.js';
import type { AppTab } from '../navigation.js';
import { AgentGrid } from './AgentGrid.js';
import { DocumentVault } from './DocumentVault.js';
import { KanbanBoard } from './KanbanBoard.js';
import { KnowledgeBaseView } from './KnowledgeBase.js';
import { TacticalTerminal } from './TacticalTerminal.js';
import { TokensView } from './TokensView.js';
import { WorkspaceAdmin } from './WorkspaceAdmin.js';

interface AppWorkspaceViewProps {
  activeTab: AppTab;
  activeViewTitle: string;
  projects: Project[];
  selectedProjectId: string | null;
  boards: Board[];
  board: Board | null;
  selectedBoardId: string | null;
  columns: Column[];
  cards: Card[];
  agents: Agent[];
  users: User[];
  currentUser: AuthMe['user'] | null;
  authMode: AuthMe['auth_mode'] | null;
  documents: Document[];
  events: Event[];
  workspaceId: string | null;
  selectedDocId: string | null;
  selectedEntityId: string | null;
  newCardRequest: { columnId?: string; token: number } | null;
  openCardRequest: { cardId: string; token: number } | null;
  onAgentHeartbeat: (agentId: string) => void;
  onUnregisterAgent: (agentId: string) => void;
  onRequestRegisterAgent: () => void;
  onRefresh: () => void;
  onSelectBoard: (boardId: string) => void;
  onMoveCard: (cardId: string, targetColumnId: string, position?: string) => void;
  onMoveColumn: (columnId: string, position: string) => void;
  onNewCardRequestHandled: () => void;
  onOpenCardRequestHandled: () => void;
  onRequestNewColumn: () => void;
  onRequestNewBoard: () => void;
  onDeleteBoard: (boardId: string) => void;
  onOpenDocumentInVault: (docId: string) => void;
  onSelectDoc: (docId: string) => void;
  onRequestNewDoc: () => void;
  onSelectEntity: (entityId: string | null) => void;
}

export const AppWorkspaceView: React.FC<AppWorkspaceViewProps> = ({
  activeTab,
  activeViewTitle,
  projects,
  selectedProjectId,
  boards,
  board,
  selectedBoardId,
  columns,
  cards,
  agents,
  users,
  currentUser,
  authMode,
  documents,
  events,
  workspaceId,
  selectedDocId,
  selectedEntityId,
  newCardRequest,
  openCardRequest,
  onAgentHeartbeat,
  onUnregisterAgent,
  onRequestRegisterAgent,
  onRefresh,
  onSelectBoard,
  onMoveCard,
  onMoveColumn,
  onNewCardRequestHandled,
  onOpenCardRequestHandled,
  onRequestNewColumn,
  onRequestNewBoard,
  onDeleteBoard,
  onOpenDocumentInVault,
  onSelectDoc,
  onRequestNewDoc,
  onSelectEntity,
}) => (
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
