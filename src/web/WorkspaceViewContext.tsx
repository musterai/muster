import React, { createContext, useContext } from 'react';
import type {
  Agent,
  AuthMe,
  Board,
  Card,
  Column,
  Document,
  Event,
  Project,
  User,
} from './types.js';
import type { AppTab } from './navigation.js';

export interface WorkspaceViewController {
  navigation: {
    activeTab: AppTab;
    activeViewTitle: string;
    selectedProjectId: string | null;
    selectedBoardId: string | null;
    selectedDocId: string | null;
    selectedEntityId: string | null;
  };
  data: {
    projects: Project[];
    boards: Board[];
    board: Board | null;
    columns: Column[];
    cards: Card[];
    agents: Agent[];
    users: User[];
    currentUser: AuthMe['user'] | null;
    authMode: AuthMe['auth_mode'] | null;
    documents: Document[];
    events: Event[];
    workspaceId: string | null;
  };
  requests: {
    newCard: { columnId?: string; token: number } | null;
    openCard: { cardId: string; token: number } | null;
  };
  actions: {
    agentHeartbeat(agentId: string): void;
    unregisterAgent(agentId: string): void;
    requestRegisterAgent(): void;
    refresh(): void;
    selectBoard(boardId: string): void;
    moveCard(cardId: string, targetColumnId: string, position?: string): void;
    moveColumn(columnId: string, position: string): void;
    newCardRequestHandled(): void;
    openCardRequestHandled(): void;
    requestNewColumn(): void;
    requestNewBoard(): void;
    deleteBoard(boardId: string): void;
    openDocumentInVault(docId: string): void;
    selectDoc(docId: string): void;
    requestNewDoc(): void;
    selectEntity(entityId: string | null): void;
  };
}

const WorkspaceViewContext = createContext<WorkspaceViewController | null>(null);

export const WorkspaceViewProvider: React.FC<{
  controller: WorkspaceViewController;
  children: React.ReactNode;
}> = ({ controller, children }) => (
  <WorkspaceViewContext.Provider value={controller}>
    {children}
  </WorkspaceViewContext.Provider>
);

export function useWorkspaceView(): WorkspaceViewController {
  const controller = useContext(WorkspaceViewContext);
  if (!controller) {
    throw new Error('useWorkspaceView must be used inside WorkspaceViewProvider');
  }
  return controller;
}
