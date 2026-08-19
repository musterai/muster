// File: src/web/App.tsx
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Project, Board, Column, Card, Agent, User, AuthMe, Document, Event, ProjectSummary } from './types.js';
import { api, ApiError, getLocalProxyToken } from './api.js';
import { Header } from './components/Header.js';
import { AppWorkspaceView } from './components/AppWorkspaceView.js';
import { MobileBottomNav } from './components/MobileBottomNav.js';
import { UserAccountModal } from './components/UserAccountModal.js';
import { ShortcutsHelpModal } from './components/ShortcutsHelpModal.js';
import { ThemeProvider } from './ThemeContext.js';
import {
  shouldAlertOnCompletion,
  completionAlert,
  fireBrowserNotification,
  requestNotificationPermission,
} from './notifications.js';
import {
  NewProjectModal,
  EditProjectModal,
  NewBoardModal,
  NewColumnModal,
  NewAgentModal,
  NewDocModal,
} from './components/Modals.js';
import { readBrowserLocation, updateBrowserLocation, type AppTab as TabType } from './navigation.js';
import {
  WorkspaceViewProvider,
  type WorkspaceViewController,
} from './WorkspaceViewContext.js';
import { useAppDialogController } from './hooks/useAppDialogController.js';

const parseLocation = readBrowserLocation;

function updateLocation(
  projectSlug: string | null,
  tab: TabType,
  docId?: string | null,
  entityId?: string | null,
  boardSlug?: string | null,
  replace = false,
): void {
  updateBrowserLocation(projectSlug, tab, { docId, entityId, boardSlug, replace });
}

// ─── Main App Component ────────────────────────────────────────────────────────

export const App: React.FC = () => {
  const initialNav = readBrowserLocation();

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>(initialNav.tab);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(initialNav.docId);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(initialNav.entityId);
  const [summary, setSummary] = useState<ProjectSummary | null>(null);

  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const selectedBoardIdRef = useRef<string | null>(null);
  const selectedBoardSlugRef = useRef<string | null>(initialNav.boardSlug);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [currentUser, setCurrentUser] = useState<AuthMe['user'] | null>(null);
  const [authMode, setAuthMode] = useState<AuthMe['auth_mode'] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [boardActionError, setBoardActionError] = useState<string | null>(null);
  // MUS-45: card-completion alert for the human operator.
  const [completionBanner, setCompletionBanner] = useState<{ id: string; heading: string; detail: string } | null>(null);
  const [notificationState, setNotificationState] = useState<'granted' | 'denied' | 'default' | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const activeViewTitle: Record<TabType, string> = {
    board: 'Kanban board',
    agents: 'Agents',
    docs: 'Design documents',
    activity: 'Activity log',
    kb: 'Knowledge base',
    tokens: 'API tokens',
    admin: 'Workspace administration',
  };

  const activeBoardNotDoneCount = useMemo(() => {
    if (!selectedBoardId || !columns.length) return null;
    const terminalColumnIds = new Set(columns.filter((col) => col.is_terminal === 1).map((col) => col.id));
    return cards.filter((c) => !c.archived && !terminalColumnIds.has(c.column_id)).length;
  }, [selectedBoardId, columns, cards]);

  const {
    showNewProjectModal,
    setShowNewProjectModal,
    showEditProjectModal,
    setShowEditProjectModal,
    showNewBoardModal,
    setShowNewBoardModal,
    showNewColumnModal,
    setShowNewColumnModal,
    showRegisterAgentModal,
    setShowRegisterAgentModal,
    showNewDocModal,
    setShowNewDocModal,
    showUserAccountModal,
    setShowUserAccountModal,
    userAccountInitialTab,
    setUserAccountInitialTab,
    showShortcutsHelpModal,
    setShowShortcutsHelpModal,
    newCardRequest,
    setNewCardRequest,
    openCardRequest,
    setOpenCardRequest,
    requestNewCard,
  } = useAppDialogController();

  const rememberSelectedBoard = useCallback((boardId: string | null) => {
    selectedBoardIdRef.current = boardId;
    setSelectedBoardId(boardId);
  }, []);

  // Global keydown listener for ? shortcuts help
  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent) => {
      const activeElement = document.activeElement;
      const isTyping =
        activeElement &&
        (activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA' ||
          activeElement.tagName === 'SELECT' ||
          (activeElement as HTMLElement).isContentEditable);

      if (!isTyping && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        setShowShortcutsHelpModal((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
  }, []);

  // Load Projects
  const loadProjects = useCallback(async (selectId?: string) => {
    try {
      const list = await api.getProjects();
      setProjects(list);

      const nav = parseLocation();
      const projectFromRoute = nav.projectSlug
        ? list.find((project) => project.slug === nav.projectSlug)
        : undefined;
      const selectedProject = selectId
        ? list.find((project) => project.id === selectId)
        : projectFromRoute || list[0];

      if (selectedProject) {
        const boardSlug = selectedProject.id === projectFromRoute?.id ? nav.boardSlug : null;
        selectedBoardSlugRef.current = boardSlug;
        setSelectedProjectId(selectedProject.id);
        updateLocation(selectedProject.slug, activeTab, selectedDocId, selectedEntityId, boardSlug, true);
      }
    } catch (err) {
      console.error('Error loading projects:', err);
    }
  }, [activeTab, selectedDocId, selectedEntityId]);

  // Load Selected Project Data
  const loadProjectData = useCallback(async () => {
    if (!selectedProjectId) return;

    try {
      const [sumData, boardsData, agentsData, usersData, docsData, eventsData] = await Promise.all([
        api.getProjectSummary(selectedProjectId),
        api.getBoards(selectedProjectId),
        api.getAgents(),
        api.getUsers(),
        api.getDocuments(selectedProjectId),
        api.getEvents(selectedProjectId, 40),
      ]);

      setSummary(sumData);
      setAgents(agentsData);
      setUsers(usersData);
      setDocuments(docsData);
      setEvents(eventsData);
      setConnectionError(null);

      setBoards(boardsData);
      const nav = parseLocation();
      const activeBoardId = selectedBoardIdRef.current;
      const isAllRoute = nav.boardSlug === 'all' || activeBoardId === 'all';
      const targetBoard: Board | null = isAllRoute
        ? { id: 'all', project_id: selectedProjectId, name: 'All Boards', slug: 'all', created_at: '', updated_at: '' }
        : (activeBoardId && boardsData.find((candidate) => candidate.id === activeBoardId))
          || (nav.boardSlug && boardsData.find((candidate) => candidate.slug === nav.boardSlug))
          || boardsData[0]
          || null;
      const targetBoardId = targetBoard?.id ?? null;
      rememberSelectedBoard(targetBoardId);
      selectedBoardSlugRef.current = targetBoard?.slug ?? null;
      updateLocation(nav.projectSlug, nav.tab, nav.docId, nav.entityId, targetBoard?.slug ?? null, true);

      if (targetBoardId) {
        const boardDetails = await api.getBoardDetails(targetBoardId, selectedProjectId);
        if (selectedBoardIdRef.current !== targetBoardId) return;
        setBoard(boardDetails);
        setColumns(boardDetails.columns || []);
        setCards(boardDetails.cards || []);
      } else {
        rememberSelectedBoard(null);
        setBoard(null);
        setColumns([]);
        setCards([]);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Project was deleted — clear selection and reload the list
        setSelectedProjectId(null);
        setSummary(null);
        setBoards([]);
        rememberSelectedBoard(null);
        setBoard(null);
        setColumns([]);
        setCards([]);
        setAgents([]);
        setUsers([]);
        setDocuments([]);
        setEvents([]);
        loadProjects();
      } else if (err instanceof ApiError && err.status === 502) {
        // The local muster connect proxy couldn't reach the upstream
        // server — never render this as a silent empty board.
        setConnectionError('Cannot reach the Muster server. Retrying…');
      } else {
        console.error('Error loading project data:', err);
      }
    }
  }, [selectedProjectId, loadProjects, rememberSelectedBoard]);

  // Sync state when selectedProjectId or activeTab or selectedDocId changes
  const handleSelectProject = (projectId: string) => {
    setBoards([]);
    rememberSelectedBoard(null);
    setBoard(null);
    setColumns([]);
    setCards([]);
    setSelectedProjectId(projectId);
    selectedBoardSlugRef.current = null;
    const project = projects.find((candidate) => candidate.id === projectId);
    updateLocation(project?.slug ?? null, activeTab, selectedDocId, selectedEntityId, null);
  };

  const handleSelectTab = (tab: TabType) => {
    setActiveTab(tab);
    const project = projects.find((candidate) => candidate.id === selectedProjectId);
    if (project) {
      const boardSlug = tab === 'board'
        ? (selectedBoardIdRef.current === 'all' ? 'all' : (boards.find((candidate) => candidate.id === selectedBoardIdRef.current)?.slug ?? selectedBoardSlugRef.current))
        : null;
      updateLocation(project.slug, tab, selectedDocId, selectedEntityId, boardSlug);
    }
  };

  const handleSelectBoard = async (boardId: string) => {
    if (boardId === selectedBoardIdRef.current) return;

    rememberSelectedBoard(boardId);
    const project = projects.find((candidate) => candidate.id === selectedProjectId);
    const selectedBoard: Board | undefined = boardId === 'all'
      ? { id: 'all', project_id: selectedProjectId!, name: 'All Boards', slug: 'all', created_at: '', updated_at: '' }
      : boards.find((candidate) => candidate.id === boardId);
    selectedBoardSlugRef.current = selectedBoard?.slug ?? null;
    if (project && selectedBoard) {
      updateLocation(project.slug, 'board', null, null, selectedBoard.slug);
    }
    try {
      if (!selectedProjectId) return;
      const boardDetails = await api.getBoardDetails(boardId, selectedProjectId);
      if (selectedBoardIdRef.current !== boardId) return;
      setBoard(boardDetails);
      setColumns(boardDetails.columns || []);
      setCards(boardDetails.cards || []);
    } catch (err) {
      console.error('Failed to select board:', err);
      loadProjectData();
    }
  };

  const handleSelectDoc = (docId: string) => {
    setSelectedDocId(docId);
    const project = projects.find((candidate) => candidate.id === selectedProjectId);
    if (project) {
      updateLocation(project.slug, 'docs', docId, null);
    }
  };

  // Handle Browser Back / Forward buttons (popstate)
  useEffect(() => {
    const handlePopState = () => {
      const { projectSlug, tab, boardSlug, docId, entityId } = parseLocation();
      const project = projects.find((candidate) => candidate.slug === projectSlug);
      if (project) {
        setSelectedProjectId(project.id);
      }
      if (tab === 'board') {
        selectedBoardSlugRef.current = boardSlug;
        rememberSelectedBoard(boards.find((candidate) => candidate.slug === boardSlug)?.id ?? null);
      }
      setActiveTab(tab);
      setSelectedDocId(docId);
      setSelectedEntityId(entityId);

      // A board URL can change without the project changing when the user
      // navigates with the browser back/forward buttons.
      if (project && project.id === selectedProjectId) {
        loadProjectData();
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [boards, loadProjectData, projects, rememberSelectedBoard, selectedProjectId]);


  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Who's signed in — drives the header display, comment authorship default,
  // and per-user theme storage. Null in open/local mode (no OIDC session).
  useEffect(() => {
    api.getMe()
      .then((me) => {
        setCurrentUser(me.user);
        setAuthMode(me.auth_mode);
        setWorkspaceId(me.workspace?.id || null);
      })
      .catch((err) => console.error('Error loading current user:', err));
  }, []);

  // Open-mode-only: let the browser claim a human identity with no OIDC
  // involved. Every request already carries full trust in open mode, so this
  // just gives that trust a name (see POST /auth/local).
  const handleSetLocalIdentity = useCallback(async (identity: string | { displayName?: string; userId?: string }) => {
    const { user } = await api.setLocalIdentity(identity);
    setCurrentUser(user);
  }, []);

  useEffect(() => {
    loadProjectData();
  }, [loadProjectData]);

  // Real-Time SSE Event Stream + Polling Fallback Hook
  useEffect(() => {
    if (!selectedProjectId) return;

    // 1. Real-Time SSE EventSource
    // EventSource can't set an Authorization header, so under `muster
    // connect` (MUS-27) the loopback token rides along as a query param —
    // the proxy's requireLocalToken() gate accepts either.
    const localToken = getLocalProxyToken();
    const sseUrl = `/api/v1/projects/${selectedProjectId}/events/stream${localToken ? `?local_token=${encodeURIComponent(localToken)}` : ''}`;
    const eventSource = new EventSource(sseUrl);

    const handleEvent = (e: MessageEvent) => {
      try {
        const newEvt: Event = JSON.parse(e.data);
        setEvents((prev) => [newEvt, ...prev.slice(0, 49)]);
        loadProjectData();      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };

    eventSource.onmessage = handleEvent;
    eventSource.onerror = (err) => {
      console.warn('SSE connection error, falling back to polling:', err);
    };

    // 2. Continuous 3-second background polling fallback
    const pollInterval = setInterval(() => {
      loadProjectData();
    }, 3000);

    return () => {
      eventSource.close();
      clearInterval(pollInterval);
    };
  }, [selectedProjectId, loadProjectData]);

  // MUS-45: alert the human when a card lands in the Done lane. Both the SSE
  // stream and the 3-second polling fallback flow into the `events` state, so
  // diffing it once covers both transports. The initial load is history and
  // is seeded into the seen-set without alerting.
  const seenEventIdsRef = useRef<Set<string> | null>(null);

  const alertForCompletedCard = useCallback((evt: Event) => {
    if (!shouldAlertOnCompletion(evt, currentUser?.id)) return;
    const actorName =
      evt.actor_name ||
      agents.find((a) => a.id === evt.actor_id)?.name ||
      users.find((u) => u.id === evt.actor_id)?.display_name ||
      null;
    const alert = completionAlert(evt, actorName);
    setCompletionBanner({ id: evt.id, ...alert });
    fireBrowserNotification('Card completed', `${alert.heading} — ${alert.detail}`);
  }, [agents, users, currentUser]);

  useEffect(() => {
    const seen = seenEventIdsRef.current;
    if (!seen) {
      seenEventIdsRef.current = new Set(events.map((e) => e.id));
      return;
    }
    const fresh = events.filter((e) => !seen.has(e.id));
    if (fresh.length === 0) return;
    for (const e of fresh) seen.add(e.id);
    // Keep the seen-set bounded to the sliding events window.
    if (seen.size > 500) {
      seen.clear();
      for (const e of events) seen.add(e.id);
    }
    for (const e of fresh) alertForCompletedCard(e);
  }, [events, alertForCompletedCard]);

  // Auto-dismiss the completion banner after 10 seconds.
  useEffect(() => {
    if (!completionBanner) return;
    const timer = setTimeout(() => setCompletionBanner(null), 10000);
    return () => clearTimeout(timer);
  }, [completionBanner]);

  // MUS-45: header bell — request browser-notification permission from a
  // user gesture so the prompt is reliably shown.
  const handleNotificationToggle = useCallback(async () => {
    const permission = await requestNotificationPermission();
    setNotificationState(permission);
  }, []);

  const handleMoveCard = async (cardId: string, targetColumnId: string, position?: string) => {
    setBoardActionError(null);
    try {
      await api.moveCard(cardId, targetColumnId, position);
      loadProjectData();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'The card could not be moved.';
      setBoardActionError(`Card move refused: ${message}`);
      console.error('Failed to move card:', err);
    }
  };

  const handleMoveColumn = async (columnId: string, position: string) => {
    try {
      await api.moveColumn(columnId, position);
      loadProjectData();
    } catch (err) {
      console.error('Failed to move column:', err);
    }
  };

  const handleAgentHeartbeat = async (agentId: string) => {
    try {
      await api.agentHeartbeat(agentId);
      loadProjectData();
    } catch (err) {
      console.error('Failed to send heartbeat:', err);
    }
  };

  const handleUnregisterAgent = async (agentId: string) => {
    try {
      await api.unregisterAgent(agentId);
      loadProjectData();
    } catch (err) {
      console.error('Failed to unregister agent:', err);
    }
  };

  const handleOpenNewCardModal = (colId?: string) => {
    requestNewCard(colId);
    if (activeTab !== 'board') {
      handleSelectTab('board');
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      await api.deleteProject(projectId);
      const remaining = projects.filter((p) => p.id !== projectId);
      const nextProjectId = remaining.length > 0 ? remaining[0].id : undefined;
      setSelectedProjectId(nextProjectId || null);
      loadProjects(nextProjectId);
    } catch (err) {
      console.error('Failed to delete project:', err);
    }
  };

  const handleDeleteBoard = async (boardId: string) => {
    try {
      await api.deleteBoard(boardId);
      if (selectedBoardIdRef.current === boardId) {
        rememberSelectedBoard(null);
      }
      loadProjectData();
    } catch (err) {
      console.error('Failed to delete board:', err);
    }
  };

  const workspaceController: WorkspaceViewController = {
    navigation: {
      activeTab,
      activeViewTitle: activeViewTitle[activeTab],
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
      agentHeartbeat: handleAgentHeartbeat,
      unregisterAgent: handleUnregisterAgent,
      requestRegisterAgent: () => setShowRegisterAgentModal(true),
      refresh: loadProjectData,
      selectBoard: handleSelectBoard,
      moveCard: handleMoveCard,
      moveColumn: handleMoveColumn,
      newCardRequestHandled: () => setNewCardRequest(null),
      openCardRequestHandled: () => setOpenCardRequest(null),
      requestNewColumn: () => setShowNewColumnModal(true),
      requestNewBoard: () => setShowNewBoardModal(true),
      deleteBoard: handleDeleteBoard,
      openDocumentInVault: (docId) => {
        setActiveTab('docs');
        handleSelectDoc(docId);
      },
      selectDoc: handleSelectDoc,
      requestNewDoc: () => setShowNewDocModal(true),
      selectEntity: (entityId) => {
        setSelectedEntityId(entityId);
        if (selectedProjectId) updateLocation(selectedProjectId, 'kb', null, entityId);
      },
    },
  };

  return (
    <ThemeProvider userId={currentUser?.id ?? null}>
    <div className="h-screen flex flex-col bg-muster-base muster-text-primary font-sans w-full overflow-hidden">

      {/* Platform Header */}
      <Header
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={handleSelectProject}
        onDeleteProject={handleDeleteProject}
        onOpenEditProject={() => setShowEditProjectModal(true)}
        summary={summary}
        activeBoardNotDoneCount={activeBoardNotDoneCount}
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        onOpenNewProject={() => setShowNewProjectModal(true)}
        onOpenNewBoard={() => setShowNewBoardModal(true)}
        onOpenRegisterAgent={() => setShowRegisterAgentModal(true)}
        onOpenNewCard={() => handleOpenNewCardModal()}
        onOpenNewDoc={() => setShowNewDocModal(true)}
        currentUser={currentUser}
        authMode={authMode}
        onSetLocalIdentity={handleSetLocalIdentity}
        onOpenUserAccount={(tab) => {
          setUserAccountInitialTab(tab || 'appearance');
          setShowUserAccountModal(true);
        }}
        onOpenShortcutsHelp={() => setShowShortcutsHelpModal(true)}
        notificationState={notificationState}
        onNotificationToggle={handleNotificationToggle}
      />

      {connectionError && (
        <div role="alert" className="flex-none bg-danger-950 border-b border-danger-600/40 text-danger-300 text-xs font-sans px-4 py-2 text-center">
          {connectionError}
        </div>
      )}

      {boardActionError && (
        <div role="alert" className="flex-none flex items-center justify-between gap-3 bg-warning-950 border-b border-warning-600/40 text-warning-200 text-xs font-sans px-4 py-2">
          <span>{boardActionError}</span>
          <button
            type="button"
            className="muster-btn muster-btn-ghost"
            onClick={() => setBoardActionError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* MUS-45: card completed — alert the human operator */}
      {completionBanner && (
        <div role="status" className="flex-none flex items-center justify-between gap-3 bg-success-950 border-b border-success-600/40 text-success-200 text-xs font-sans px-4 py-2">
          <span className="min-w-0 truncate">
            <span className="font-semibold">Card completed:</span> {completionBanner.heading} — {completionBanner.detail}
          </span>
          <button
            type="button"
            className="muster-btn muster-btn-ghost flex-none"
            onClick={() => setCompletionBanner(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <WorkspaceViewProvider controller={workspaceController}>
        <AppWorkspaceView />
      </WorkspaceViewProvider>
      {/* Mobile Bottom Navigation Bar */}
      <MobileBottomNav activeTab={activeTab} onSelectTab={handleSelectTab} />


      {/* Modals */}
      {showNewProjectModal && (
        <NewProjectModal
          onClose={() => setShowNewProjectModal(false)}
          onSuccess={(newId) => {
            handleSelectProject(newId);
            loadProjects(newId);
          }}
        />
      )}

      {showEditProjectModal && selectedProjectId && projects.some((p) => p.id === selectedProjectId) && (
        <EditProjectModal
          project={projects.find((p) => p.id === selectedProjectId)!}
          onClose={() => setShowEditProjectModal(false)}
          onSuccess={() => {
            loadProjects(selectedProjectId);
            loadProjectData();
          }}
          onDeleteProject={handleDeleteProject}
        />
      )}

      {showNewBoardModal && selectedProjectId && (
        <NewBoardModal
          projectId={selectedProjectId}
          onClose={() => setShowNewBoardModal(false)}
          onSuccess={loadProjectData}
        />
      )}

      {showNewColumnModal && board && (
        <NewColumnModal
          boardId={board.id}
          onClose={() => setShowNewColumnModal(false)}
          onSuccess={loadProjectData}
        />
      )}

      {showRegisterAgentModal && (
        <NewAgentModal
          onClose={() => setShowRegisterAgentModal(false)}
          onSuccess={loadProjectData}
        />
      )}

      {showNewDocModal && selectedProjectId && (
        <NewDocModal
          projectId={selectedProjectId}
          onClose={() => setShowNewDocModal(false)}
          onSuccess={(newDoc) => {
            if (newDoc && newDoc.id) {
              handleSelectDoc(newDoc.id);
            }
            loadProjectData();
          }}
        />
      )}

      {showUserAccountModal && (
        <UserAccountModal
          currentUser={currentUser}
          workspaceId={workspaceId}
          authMode={authMode}
          onSetLocalIdentity={handleSetLocalIdentity}
          initialTab={userAccountInitialTab}
          onClose={() => setShowUserAccountModal(false)}
        />
      )}

      {showShortcutsHelpModal && (
        <ShortcutsHelpModal onClose={() => setShowShortcutsHelpModal(false)} />
      )}
    </div>
    </ThemeProvider>
  );
};
