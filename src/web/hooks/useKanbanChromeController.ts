import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Board, Card, Column } from '../types.js';
import type { CardDateSortOrder } from '../kanban.js';
import { api } from '../api.js';
import { useBoardViewMode, type BoardViewMode } from './useBoardViewMode.js';

export interface KanbanToolbarController {
  model: {
    boards: Board[];
    board: Board;
    selectedBoardId: string | null;
    boardViewMode: BoardViewMode;
    cards: Card[];
    cardDateSortOrder: CardDateSortOrder;
  };
  actions: {
    selectBoard(boardId: string): void;
    openNewBoard?(): void;
    openBoardSettings(): void;
    setBoardViewMode(mode: BoardViewMode): void;
    openCard(cardId: string): void;
    toggleSort(): void;
  };
}

export interface BoardSettingsController {
  model: {
    board: Board;
    boardNameInput: string;
    columns: Column[];
  };
  actions: {
    setBoardNameInput(name: string): void;
    rename(): void;
    close(): void;
    openNewColumn(): void;
    editColumn(column: Column): void;
    deleteBoard(boardId: string): void;
  };
}

export interface MobileLaneController {
  model: {
    columns: Column[];
    cards: Card[];
    focusedColumnIndex: number;
  };
  actions: {
    selectLane(columnIndex: number, columnId: string): void;
  };
}

interface UseKanbanChromeControllerOptions {
  boards: Board[];
  board: Board | null;
  selectedBoardId: string | null;
  columns: Column[];
  cards: Card[];
  onSelectBoard(boardId: string): void;
  onOpenNewBoard?(): void;
  onOpenNewColumn(): void;
  onEditColumn(column: Column): void;
  onDeleteBoard(boardId: string): void;
  onRefresh(): void;
}

export function useKanbanChromeController({
  boards,
  board,
  selectedBoardId,
  columns,
  cards,
  onSelectBoard,
  onOpenNewBoard,
  onOpenNewColumn,
  onEditColumn,
  onDeleteBoard,
  onRefresh,
}: UseKanbanChromeControllerOptions) {
  const [isBoardSettingsOpen, setBoardSettingsOpen] = useState(false);
  const [boardNameInput, setBoardNameInput] = useState('');
  const [cardDateSortOrder, setCardDateSortOrder] = useState<CardDateSortOrder>('newest');
  const [focusedColumnIndex, setFocusedColumnIndex] = useState(0);
  const [boardViewMode, setBoardViewMode] = useBoardViewMode();

  useEffect(() => {
    setFocusedColumnIndex((current) => Math.min(current, Math.max(0, columns.length - 1)));
  }, [columns.length]);

  const openBoardSettings = useCallback(() => {
    if (!board) return;
    setBoardNameInput(board.name);
    setBoardSettingsOpen(true);
  }, [board]);

  const closeBoardSettings = useCallback(() => setBoardSettingsOpen(false), []);

  const renameBoard = useCallback(async () => {
    if (!board || !boardNameInput.trim()) return;
    try {
      await api.updateBoard(board.id, boardNameInput.trim());
      setBoardSettingsOpen(false);
      onRefresh();
    } catch (error) {
      console.error('Failed to rename board:', error);
    }
  }, [board, boardNameInput, onRefresh]);

  const toggleSort = useCallback(() => {
    setCardDateSortOrder((current) => current === 'newest' ? 'oldest' : 'newest');
  }, []);

  const selectLane = useCallback((columnIndex: number, columnId: string) => {
    setFocusedColumnIndex(columnIndex);
    document.getElementById(`kanban-column-${columnId}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  }, []);

  const toolbar = useMemo<Omit<KanbanToolbarController, 'actions'> & {
    actions: Omit<KanbanToolbarController['actions'], 'openCard'>;
  }>(() => ({
    model: {
      boards,
      board: board!,
      selectedBoardId,
      boardViewMode,
      cards,
      cardDateSortOrder,
    },
    actions: {
      selectBoard: onSelectBoard,
      openNewBoard: onOpenNewBoard,
      openBoardSettings,
      setBoardViewMode,
      toggleSort,
    },
  }), [boards, board, selectedBoardId, boardViewMode, cards, cardDateSortOrder, onSelectBoard, onOpenNewBoard, openBoardSettings, setBoardViewMode, toggleSort]);

  const settings = useMemo<BoardSettingsController | null>(() => board ? ({
    model: { board, boardNameInput, columns },
    actions: {
      setBoardNameInput,
      rename: renameBoard,
      close: closeBoardSettings,
      openNewColumn: onOpenNewColumn,
      editColumn: onEditColumn,
      deleteBoard: onDeleteBoard,
    },
  }) : null, [board, boardNameInput, columns, renameBoard, closeBoardSettings, onOpenNewColumn, onEditColumn, onDeleteBoard]);

  const mobile = useMemo<MobileLaneController>(() => ({
    model: { columns, cards, focusedColumnIndex },
    actions: { selectLane },
  }), [columns, cards, focusedColumnIndex, selectLane]);

  return {
    state: {
      isBoardSettingsOpen,
      boardViewMode,
      cardDateSortOrder,
      focusedColumnIndex,
    },
    toolbar,
    settings,
    mobile,
    actions: {
      closeBoardSettings,
      setFocusedColumnIndex,
    },
  };
}
