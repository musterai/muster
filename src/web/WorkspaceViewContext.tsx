import React, { createContext, useContext, useMemo } from 'react';
import type { Agent, AuthMe, Board, Card, Column, Document, Event, Project, User } from './types.js';
import type { AppTab } from './navigation.js';

export interface WorkspaceNavigationController {
  activeTab: AppTab;
  activeViewTitle: string;
}

export interface BoardWorkspaceController {
  data: {
    boards: Board[];
    board: Board | null;
    selectedBoardId: string | null;
    columns: Column[];
    cards: Card[];
    agents: Agent[];
    users: User[];
    currentUser: AuthMe['user'] | null;
    documents: Document[];
    projectId: string | null;
  };
  requests: {
    newCard: { columnId?: string; token: number } | null;
    openCard: { cardId: string; token: number } | null;
  };
  actions: {
    selectBoard(boardId: string): void;
    moveCard(cardId: string, targetColumnId: string, position?: string): void;
    moveColumn(columnId: string, position: string): void;
    newCardRequestHandled(): void;
    openCardRequestHandled(): void;
    requestNewColumn(): void;
    requestNewBoard(): void;
    deleteBoard(boardId: string): void;
    openDocumentInVault(docId: string): void;
    refresh(): void;
  };
}

export interface AgentWorkspaceController {
  data: { agents: Agent[]; users: User[]; cards: Card[]; workspaceId: string | null };
  actions: {
    heartbeat(agentId: string): void;
    unregister(agentId: string): void;
    requestRegister(): void;
    refresh(): void;
  };
}

export interface DocumentWorkspaceController {
  data: { documents: Document[]; selectedDocId: string | null };
  actions: { select(docId: string): void; requestNew(): void; refresh(): void };
}

export interface KnowledgeWorkspaceController {
  data: { currentProject: Project | null; selectedEntityId: string | null };
  actions: { selectEntity(entityId: string | null): void };
}

export interface ActivityWorkspaceController {
  data: { events: Event[]; agents: Agent[]; cards: Card[]; documents: Document[] };
  actions: { refresh(): void };
}

export interface AdminWorkspaceController {
  workspaceId: string | null;
  currentUser: AuthMe['user'] | null;
  authMode: AuthMe['auth_mode'] | null;
}

export interface WorkspaceViewControllers {
  navigation: WorkspaceNavigationController;
  board: BoardWorkspaceController;
  agents: AgentWorkspaceController;
  documents: DocumentWorkspaceController;
  knowledge: KnowledgeWorkspaceController;
  activity: ActivityWorkspaceController;
  admin: AdminWorkspaceController;
}

/** Memoize each view domain independently so unrelated App state stays local. */
export function useWorkspaceViewControllers(input: WorkspaceViewControllers): WorkspaceViewControllers {
  const navigation = useMemo(() => input.navigation, [
    input.navigation.activeTab,
    input.navigation.activeViewTitle,
  ]);
  const board = useMemo(() => input.board, [
    input.board.data.boards,
    input.board.data.board,
    input.board.data.selectedBoardId,
    input.board.data.columns,
    input.board.data.cards,
    input.board.data.agents,
    input.board.data.users,
    input.board.data.currentUser,
    input.board.data.documents,
    input.board.data.projectId,
    input.board.requests.newCard,
    input.board.requests.openCard,
    input.board.actions.selectBoard,
    input.board.actions.moveCard,
    input.board.actions.moveColumn,
    input.board.actions.newCardRequestHandled,
    input.board.actions.openCardRequestHandled,
    input.board.actions.requestNewColumn,
    input.board.actions.requestNewBoard,
    input.board.actions.deleteBoard,
    input.board.actions.openDocumentInVault,
    input.board.actions.refresh,
  ]);
  const agents = useMemo(() => input.agents, [
    input.agents.data.agents,
    input.agents.data.users,
    input.agents.data.cards,
    input.agents.data.workspaceId,
    input.agents.actions.heartbeat,
    input.agents.actions.unregister,
    input.agents.actions.requestRegister,
    input.agents.actions.refresh,
  ]);
  const documents = useMemo(() => input.documents, [
    input.documents.data.documents,
    input.documents.data.selectedDocId,
    input.documents.actions.select,
    input.documents.actions.requestNew,
    input.documents.actions.refresh,
  ]);
  const knowledge = useMemo(() => input.knowledge, [
    input.knowledge.data.currentProject,
    input.knowledge.data.selectedEntityId,
    input.knowledge.actions.selectEntity,
  ]);
  const activity = useMemo(() => input.activity, [
    input.activity.data.events,
    input.activity.data.agents,
    input.activity.data.cards,
    input.activity.data.documents,
    input.activity.actions.refresh,
  ]);
  const admin = useMemo(() => input.admin, [
    input.admin.workspaceId,
    input.admin.currentUser,
    input.admin.authMode,
  ]);
  return useMemo(() => ({
    navigation, board, agents, documents, knowledge, activity, admin,
  }), [activity, admin, agents, board, documents, knowledge, navigation]);
}

const NavigationContext = createContext<WorkspaceNavigationController | null>(null);
const BoardContext = createContext<BoardWorkspaceController | null>(null);
const AgentContext = createContext<AgentWorkspaceController | null>(null);
const DocumentContext = createContext<DocumentWorkspaceController | null>(null);
const KnowledgeContext = createContext<KnowledgeWorkspaceController | null>(null);
const ActivityContext = createContext<ActivityWorkspaceController | null>(null);
const AdminContext = createContext<AdminWorkspaceController | null>(null);

export const WorkspaceViewProviders: React.FC<{
  controllers: WorkspaceViewControllers;
  children: React.ReactNode;
}> = ({ controllers, children }) => (
  <NavigationContext.Provider value={controllers.navigation}>
    <BoardContext.Provider value={controllers.board}>
      <AgentContext.Provider value={controllers.agents}>
        <DocumentContext.Provider value={controllers.documents}>
          <KnowledgeContext.Provider value={controllers.knowledge}>
            <ActivityContext.Provider value={controllers.activity}>
              <AdminContext.Provider value={controllers.admin}>{children}</AdminContext.Provider>
            </ActivityContext.Provider>
          </KnowledgeContext.Provider>
        </DocumentContext.Provider>
      </AgentContext.Provider>
    </BoardContext.Provider>
  </NavigationContext.Provider>
);

function requiredContext<T>(value: T | null, name: string): T {
  if (!value) throw new Error(`${name} must be used inside WorkspaceViewProviders`);
  return value;
}

export const useWorkspaceNavigation = () => requiredContext(useContext(NavigationContext), 'useWorkspaceNavigation');
export const useBoardWorkspace = () => requiredContext(useContext(BoardContext), 'useBoardWorkspace');
export const useAgentWorkspace = () => requiredContext(useContext(AgentContext), 'useAgentWorkspace');
export const useDocumentWorkspace = () => requiredContext(useContext(DocumentContext), 'useDocumentWorkspace');
export const useKnowledgeWorkspace = () => requiredContext(useContext(KnowledgeContext), 'useKnowledgeWorkspace');
export const useActivityWorkspace = () => requiredContext(useContext(ActivityContext), 'useActivityWorkspace');
export const useAdminWorkspace = () => requiredContext(useContext(AdminContext), 'useAdminWorkspace');
