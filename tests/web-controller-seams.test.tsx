// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/web/api.js';
import {
  WorkspaceViewProvider,
  type WorkspaceViewController,
} from '../src/web/WorkspaceViewContext.js';
import { AppWorkspaceView } from '../src/web/components/AppWorkspaceView.js';
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
  it('renders the selected view without a pass-through prop surface', async () => {
    const controller: WorkspaceViewController = {
      navigation: {
        activeTab: 'admin', activeViewTitle: 'Workspace administration',
        selectedProjectId: null, selectedBoardId: null, selectedDocId: null, selectedEntityId: null,
      },
      data: {
        projects: [], boards: [], board: null, columns: [], cards: [], agents: [], users: [],
        currentUser: null, authMode: 'open', documents: [], events: [], workspaceId: null,
      },
      requests: { newCard: null, openCard: null },
      actions: {
        agentHeartbeat: vi.fn(), unregisterAgent: vi.fn(), requestRegisterAgent: vi.fn(),
        refresh: vi.fn(), selectBoard: vi.fn(), moveCard: vi.fn(), moveColumn: vi.fn(),
        newCardRequestHandled: vi.fn(), openCardRequestHandled: vi.fn(),
        requestNewColumn: vi.fn(), requestNewBoard: vi.fn(), deleteBoard: vi.fn(),
        openDocumentInVault: vi.fn(), selectDoc: vi.fn(), requestNewDoc: vi.fn(),
        selectEntity: vi.fn(),
      },
    };

    await act(async () => root.render(
      <WorkspaceViewProvider controller={controller}>
        <AppWorkspaceView />
      </WorkspaceViewProvider>,
    ));

    expect(container.querySelector('#active-view-heading')?.textContent).toBe('Workspace administration');
    expect(container.textContent).toContain('No workspace found yet.');
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
