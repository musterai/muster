// @vitest-environment jsdom
import React, { act, useCallback, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/web/api.js';
import {
  WorkspaceViewProviders,
  type WorkspaceViewControllers,
  useActivityWorkspace,
  useBoardWorkspace,
  useWorkspaceNavigation,
  useWorkspaceViewControllers,
} from '../src/web/WorkspaceViewContext.js';
import { AppWorkspaceView } from '../src/web/components/AppWorkspaceView.js';
import { KanbanBoard } from '../src/web/components/KanbanBoard.js';
import { BoardSettingsDialog } from '../src/web/components/kanban/BoardSettingsDialog.js';
import { KanbanToolbar } from '../src/web/components/kanban/KanbanToolbar.js';
import { MobileLaneSwitcher } from '../src/web/components/kanban/MobileLaneSwitcher.js';
import { useKanbanChromeController } from '../src/web/hooks/useKanbanChromeController.js';
import type { Board, Card, Column } from '../src/web/types.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const board: Board = {
  id: 'board-1', project_id: 'project-1', name: 'Development', slug: 'development',
  created_at: '', updated_at: '',
};
const columns: Column[] = [
  { id: 'todo', board_id: board.id, name: 'To Do', position: 'a', wip_limit: null, is_terminal: 0 },
  { id: 'done', board_id: board.id, name: 'Done', position: 'z', wip_limit: null, is_terminal: 1 },
];
const cards: Card[] = [{
  id: 'card-1', key: 'MUS-1', board_id: board.id, column_id: 'todo', title: 'Test card',
  description: null, position: 'm', priority: 'medium', due_date: null,
  created_at: '', updated_at: '', archived: 0, is_epic: 0,
}];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
  container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('workspace view context seam', () => {
  const controllers = (overrides: Partial<WorkspaceViewControllers> = {}): WorkspaceViewControllers => ({
    navigation: {
      activeTab: 'admin', activeViewTitle: 'Workspace administration', viewFocusVersion: 1,
    },
    board: {
      data: {
        boards: [], board: null, selectedBoardId: null, columns: [], cards: [], agents: [],
        users: [], currentUser: null, documents: [], projectId: null,
      },
      requests: { newCard: null, openCard: null },
      actions: {
        selectBoard: vi.fn(), moveCard: vi.fn(), moveColumn: vi.fn(),
        newCardRequestHandled: vi.fn(), openCardRequestHandled: vi.fn(),
        requestNewColumn: vi.fn(), requestNewBoard: vi.fn(), deleteBoard: vi.fn(),
        openDocumentInVault: vi.fn(), refresh: vi.fn(),
      },
    },
    agents: {
      data: { agents: [], users: [], cards: [], workspaceId: null },
      actions: { heartbeat: vi.fn(), unregister: vi.fn(), requestRegister: vi.fn(), refresh: vi.fn() },
    },
    documents: {
      data: { documents: [], selectedDocId: null },
      actions: { select: vi.fn(), requestNew: vi.fn(), refresh: vi.fn() },
    },
    knowledge: {
      data: { currentProject: null, selectedEntityId: null },
      actions: { selectEntity: vi.fn() },
    },
    activity: {
      data: { events: [], agents: [], cards: [], documents: [] },
      actions: { refresh: vi.fn() },
    },
    admin: { workspaceId: null, currentUser: null, authMode: 'open' },
    ...overrides,
  });

  it('renders the selected view without a pass-through prop surface', async () => {
    const controller = controllers();

    await act(async () => root.render(
      <WorkspaceViewProviders controllers={controller}>
        <AppWorkspaceView />
      </WorkspaceViewProviders>,
    ));

    expect(container.querySelector('#active-view-heading')?.textContent).toBe('Workspace administration');
    expect(container.textContent).toContain('No workspace found yet.');
    const region = container.querySelector<HTMLElement>('[data-lazy-view="workspace-admin"]')!;
    expect(document.activeElement).toBe(region);

    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    await act(async () => root.render(
      <WorkspaceViewProviders controllers={{
        ...controller,
        navigation: { ...controller.navigation, viewFocusVersion: 2 },
      }}>
        <AppWorkspaceView />
      </WorkspaceViewProviders>,
    ));
    expect(container.querySelector('[data-lazy-view="workspace-admin"]')).toBe(region);
    expect(document.activeElement).toBe(region);
    outside.remove();
  });

  it('isolates unrelated domain updates and keeps actions stable without stale state', async () => {
    const renders = { navigation: 0, board: 0, activity: 0 };
    const boardActions: Array<() => void> = [];
    const observedVersions: number[] = [];
    let bumpActivity!: () => void;
    let bumpBoard!: () => void;

    const NavigationProbe = React.memo(() => {
      useWorkspaceNavigation();
      renders.navigation += 1;
      return null;
    });
    const BoardProbe = React.memo(() => {
      const controller = useBoardWorkspace();
      renders.board += 1;
      boardActions.push(controller.actions.refresh);
      return null;
    });
    const ActivityProbe = React.memo(() => {
      useActivityWorkspace();
      renders.activity += 1;
      return null;
    });

    const Harness = () => {
      const [activityVersion, setActivityVersion] = useState(0);
      const [boardVersion, setBoardVersion] = useState(0);
      const boardVersionRef = useRef(boardVersion);
      boardVersionRef.current = boardVersion;
      bumpActivity = useCallback(() => setActivityVersion((value) => value + 1), []);
      bumpBoard = useCallback(() => setBoardVersion((value) => value + 1), []);
      const stableRefresh = useCallback(() => observedVersions.push(boardVersionRef.current), []);
      const base = useMemo(() => controllers(), []);
      const activityEvents = useMemo(
        () => activityVersion ? [{ id: `event-${activityVersion}` } as never] : [],
        [activityVersion],
      );
      const splitControllers = useWorkspaceViewControllers({
        ...base,
        board: {
          ...base.board,
          data: { ...base.board.data, projectId: `board-${boardVersion}` },
          actions: { ...base.board.actions, refresh: stableRefresh },
        },
        activity: {
          ...base.activity,
          data: {
            ...base.activity.data,
            events: activityEvents,
          },
        },
      });
      return <WorkspaceViewProviders controllers={splitControllers}>
        <NavigationProbe />
        <BoardProbe />
        <ActivityProbe />
      </WorkspaceViewProviders>;
    };

    await act(async () => root.render(<Harness />));
    expect(renders).toEqual({ navigation: 1, board: 1, activity: 1 });
    const initialAction = boardActions.at(-1)!;

    await act(async () => bumpActivity());
    expect(renders).toEqual({ navigation: 1, board: 1, activity: 2 });
    expect(boardActions.at(-1)).toBe(initialAction);

    await act(async () => bumpBoard());
    expect(renders).toEqual({ navigation: 1, board: 2, activity: 2 });
    expect(boardActions.at(-1)).toBe(initialAction);
    boardActions.at(-1)!();
    expect(observedVersions).toEqual([1]);
  });
});

describe('Kanban chrome controller', () => {
  it('coordinates toolbar, settings, and mobile lane interactions accessibly with stable handlers', async () => {
    const selectBoard = vi.fn();
    const refresh = vi.fn();
    const updateBoard = vi.spyOn(api, 'updateBoard').mockResolvedValue(board);
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    let latest: ReturnType<typeof useKanbanChromeController> | null = null;
    const handlerSnapshots: Array<{ toggleSort: () => void; selectLane: (index: number, id: string) => void }> = [];

    const Harness = () => {
      const chrome = useKanbanChromeController({
        boards: [board], board, selectedBoardId: board.id, columns, cards,
        onSelectBoard: selectBoard, onOpenNewBoard: vi.fn(), onOpenNewColumn: vi.fn(),
        onDeleteBoard: vi.fn(), onRefresh: refresh,
      });
      latest = chrome;
      handlerSnapshots.push({
        toggleSort: chrome.toolbar.actions.toggleSort,
        selectLane: chrome.mobile.actions.selectLane,
      });
      return <>
        <KanbanToolbar controller={{
          ...chrome.toolbar,
          actions: { ...chrome.toolbar.actions, openCard: vi.fn() },
        }} />
        <div id="kanban-column-todo" />
        <div id="kanban-column-done" />
        <MobileLaneSwitcher controller={chrome.mobile} />
        {chrome.state.isBoardSettingsOpen && chrome.settings
          ? <BoardSettingsDialog controller={chrome.settings} />
          : null}
      </>;
    };

    await act(async () => root.render(<Harness />));
    const settingsButton = container.querySelector<HTMLButtonElement>('[aria-label="Board settings"]')!;
    const swimlaneButton = container.querySelector<HTMLButtonElement>('[title="Epic Swimlanes View"]')!;
    const sortButton = container.querySelector<HTMLButtonElement>('[aria-label="Toggle card sort order by date updated"]')!;
    expect(swimlaneButton.getAttribute('aria-pressed')).toBe('false');
    expect(sortButton.title).toContain('Newest updated first');

    const firstHandlers = handlerSnapshots.at(-1)!;
    await act(async () => swimlaneButton.click());
    expect(swimlaneButton.getAttribute('aria-pressed')).toBe('true');
    await act(async () => sortButton.click());
    expect(sortButton.title).toContain('Oldest updated first');
    expect(handlerSnapshots.at(-1)!.toggleSort).toBe(firstHandlers.toggleSort);
    expect(handlerSnapshots.at(-1)!.selectLane).toBe(firstHandlers.selectLane);

    const laneButtons = [...container.querySelectorAll<HTMLButtonElement>('.muster-chip')];
    expect(laneButtons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    await act(async () => laneButtons[1].click());
    expect(laneButtons[1].getAttribute('aria-pressed')).toBe('true');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest', inline: 'center' });

    settingsButton.focus();
    await act(async () => settingsButton.click());
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBe('board-settings-title');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(settingsButton);

    await act(async () => settingsButton.click());
    const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="Board name"]')!;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      valueSetter.call(nameInput, 'Renamed board');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const form = nameInput.closest('form')!;
    await act(async () => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
    expect(updateBoard).toHaveBeenCalledWith(board.id, 'Renamed board');
    expect(refresh).toHaveBeenCalledOnce();
    expect(latest!.state.isBoardSettingsOpen).toBe(false);
  });
});

describe('rendered Kanban interaction boundaries', () => {
  const todoSecond: Card = {
    ...cards[0], id: 'card-2', key: 'MUS-2', title: 'Second task', position: 'n',
  };
  const doneCard: Card = {
    ...cards[0], id: 'card-3', key: 'MUS-3', title: 'Completed task',
    column_id: 'done', position: 'm',
  };

  function renderBoard(
    onMoveCard = vi.fn(),
    boardColumns = columns,
    boardCards = [cards[0], todoSecond, doneCard],
  ) {
    const onMoveColumn = vi.fn();
    root.render(<KanbanBoard
      boards={[board]}
      board={board}
      selectedBoardId={board.id}
      onSelectBoard={vi.fn()}
      columns={boardColumns}
      cards={boardCards}
      agents={[]}
      users={[]}
      currentUser={null}
      documents={[]}
      projectId={board.project_id}
      onMoveCard={onMoveCard}
      onMoveColumn={onMoveColumn}
      onOpenNewColumn={vi.fn()}
      onOpenNewBoard={vi.fn()}
      onDeleteBoard={vi.fn()}
      onRefresh={vi.fn()}
    />);
    return { onMoveCard, onMoveColumn };
  }

  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  it('owns APG arrow, Home, End, and Enter focus behavior in the rendered board', async () => {
    const getDetails = vi.spyOn(api, 'getCardDetails').mockReturnValue(new Promise(() => {}));
    await act(async () => renderBoard());
    const open = (key: string) => container.querySelector<HTMLButtonElement>(`[aria-label^="Open ${key}:"]`)!;
    await act(async () => open('MUS-1').focus());

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(open('MUS-2'));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(document.activeElement).toBe(open('MUS-1'));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(document.activeElement).toBe(open('MUS-2'));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement).toBe(open('MUS-3'));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(getDetails).toHaveBeenCalledWith('card-3');
  });

  it('skips empty lanes when navigating horizontally in either direction', async () => {
    const emptyReview: Column = {
      id: 'review', board_id: board.id, name: 'Review', position: 'm', wip_limit: null, is_terminal: 0,
    };
    const emptyVerify: Column = {
      id: 'verify', board_id: board.id, name: 'Verify', position: 'n', wip_limit: null, is_terminal: 0,
    };
    await act(async () => renderBoard(
      vi.fn(),
      [columns[0], emptyReview, emptyVerify, columns[1]],
      [cards[0], doneCard],
    ));
    const open = (key: string) => container.querySelector<HTMLButtonElement>(`[aria-label^="Open ${key}:"]`)!;
    await act(async () => open('MUS-1').focus());

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement).toBe(open('MUS-3'));

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(document.activeElement).toBe(open('MUS-1'));
  });

  it('uses the rendered keyboard drag boundary for lift, reorder, drop, cancel, and focus', async () => {
    const onMoveCard = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const cardIndex = this.id === 'kanban-card-card-1' ? 0 : this.id === 'kanban-card-card-2' ? 1 : 0;
      const columnIndex = this.closest?.('#kanban-column-done') ? 1 : 0;
      const left = columnIndex * 320;
      const top = cardIndex * 100;
      return {
        x: left, y: top, left, top, width: 288, height: 80,
        right: left + 288, bottom: top + 80, toJSON: () => ({}),
      } as DOMRect;
    });
    await act(async () => renderBoard(onMoveCard));
    const drag = (key: string) => container.querySelector<HTMLButtonElement>(`[aria-label^="Drag ${key}:"]`)!;
    const key = async (target: HTMLElement, value: string, code?: string) => {
      const keyCodes: Record<string, number> = {
        ' ': 32, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Escape: 27,
      };
      const event = new KeyboardEvent('keydown', {
        key: value, code: code ?? value, bubbles: true, cancelable: true,
      });
      Object.defineProperty(event, 'keyCode', { value: keyCodes[value] ?? 0 });
      await act(async () => target.dispatchEvent(event));
    };

    await act(async () => drag('MUS-1').focus());
    await key(drag('MUS-1'), ' ', 'Space');
    await key(drag('MUS-1'), 'ArrowDown');
    await key(drag('MUS-1'), ' ', 'Space');
    expect(onMoveCard).toHaveBeenCalledOnce();
    expect(onMoveCard.mock.calls[0].slice(0, 2)).toEqual(['card-1', 'todo']);
    expect(document.activeElement).toBe(drag('MUS-1'));

    onMoveCard.mockClear();
    await act(async () => drag('MUS-2').focus());
    await key(drag('MUS-2'), ' ', 'Space');
    await key(drag('MUS-2'), 'ArrowRight');
    await key(drag('MUS-2'), 'Escape');
    expect(onMoveCard).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(drag('MUS-2'));
  });
});
