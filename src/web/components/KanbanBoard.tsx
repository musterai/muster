// File: src/web/components/KanbanBoard.tsx
import React, { useState, useEffect } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Board, Column, Card, Agent, CardDetails, Document, CardLinkRelationType, CardWorkLinkKind, CardWorkLinkProvider, User, AuthMe } from '../types.js';
import { Layout, Plus, Trash2, Edit2, CheckCircle2, ArrowRight, Settings, Layers, X, ChevronDown, ChevronRight, ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react';
import { api, getLocalProxyToken } from '../api.js';
import {
  CardDateSortOrder,
  DONE_LANE_PAGE_SIZE,
  computeReorderedPosition,
  getLaneCards,
  isDoneLane,
} from '../kanban.js';
import { EditColumnModal } from './Modals.js';
import { DocumentReaderModal } from './DocumentReaderModal.js';
import { CardSearch } from './CardSearch.js';
import { KanbanColumn } from './kanban/KanbanColumn.js';
import { CardDetailDrawer } from './kanban/CardDetailDrawer.js';
import { AccessibleDialog } from './AccessibleDialog.js';

interface KanbanBoardProps {
  boards: Board[];
  board: Board | null;
  selectedBoardId: string | null;
  onSelectBoard: (boardId: string) => void;
  columns: Column[];
  cards: Card[];
  agents: Agent[];
  users: User[];
  currentUser: AuthMe['user'] | null;
  documents: Document[];
  projectId: string | null;
  newCardRequest?: { columnId?: string; token: number } | null;
  openCardRequest?: { cardId: string; token: number } | null;
  onMoveCard: (cardId: string, targetColumnId: string, position?: string) => void;
  onMoveColumn: (columnId: string, position: string) => void;
  onNewCardRequestHandled?: () => void;
  onOpenCardRequestHandled?: () => void;
  onOpenNewColumn: () => void;
  onOpenNewBoard?: () => void;
  onDeleteBoard: (boardId: string) => void;
  onOpenDocumentInVault?: (docId: string) => void;
  onRefresh: () => void;
}

export const KanbanBoard: React.FC<KanbanBoardProps> = ({
  boards,
  board,
  selectedBoardId,
  onSelectBoard,
  columns,
  cards,
  agents,
  users,
  currentUser,
  documents,
  projectId,
  newCardRequest,
  openCardRequest,
  onMoveCard,
  onMoveColumn,
  onNewCardRequestHandled,
  onOpenCardRequestHandled,
  onOpenNewColumn,
  onOpenNewBoard,
  onDeleteBoard,
  onOpenDocumentInVault,
  onRefresh,
}) => {
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [cardDetails, setCardDetails] = useState<CardDetails | null>(null);
  const [copiedKeyCardId, setCopiedKeyCardId] = useState<string | null>(null);
  const [readerDocument, setReaderDocument] = useState<Document | null>(null);
  const [loadingDocumentId, setLoadingDocumentId] = useState<string | null>(null);
  const [showBoardSettingsModal, setShowBoardSettingsModal] = useState(false);
  const [boardNameInput, setBoardNameInput] = useState('');
  const [editingColumn, setEditingColumn] = useState<Column | null>(null);

  const [isEditingBoardName, setIsEditingBoardName] = useState(false);
  const [isEditingCard, setIsEditingCard] = useState(false);
  const [editCardTitle, setEditCardTitle] = useState('');
  const [editCardDescription, setEditCardDescription] = useState('');
  const [editCardPriority, setEditCardPriority] = useState<'critical' | 'high' | 'medium' | 'low'>('medium');
  const [editCardIsEpic, setEditCardIsEpic] = useState(false);
  const [editCardColumnId, setEditCardColumnId] = useState('');

  const [isCreatingCard, setIsCreatingCard] = useState(false);
  const [newCardColumnId, setNewCardColumnId] = useState('');
  const [cardDateSortOrder, setCardDateSortOrder] = useState<CardDateSortOrder>('newest');
  const [doneVisibleLimits, setDoneVisibleLimits] = useState<Record<string, number>>({});
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [focusedColumnIdx, setFocusedColumnIdx] = useState<number>(0);
  const [boardAnnouncement, setBoardAnnouncement] = useState('');
  const [boardViewMode, setBoardViewModeState] = useState<'default' | 'swimlanes'>(() => {
    try {
      const saved = localStorage.getItem('muster_board_view_mode');
      return saved === 'swimlanes' ? 'swimlanes' : 'default';
    } catch {
      return 'default';
    }
  });

  const setBoardViewMode = (mode: 'default' | 'swimlanes') => {
    setBoardViewModeState(mode);
    try {
      localStorage.setItem('muster_board_view_mode', mode);
    } catch (err) {
      console.error('Failed to save board view mode preference:', err);
    }
  };

  const [hoveredEpicId, setHoveredEpicId] = useState<string | null>(null);
  const [collapsedEpics, setCollapsedEpics] = useState<Record<string, boolean>>({});

  const { displayColumns, columnMap } = React.useMemo(() => {
    const map: Record<string, string> = {};
    columns.forEach((c) => {
      map[c.id] = c.name;
    });

    if (selectedBoardId !== 'all' && board?.id !== 'all') {
      return { displayColumns: columns, columnMap: map };
    }

    const uniqueMap = new Map<string, Column>();
    columns.forEach((col) => {
      const nameKey = col.name.trim().toLowerCase();
      if (!uniqueMap.has(nameKey)) {
        uniqueMap.set(nameKey, {
          ...col,
          id: `all-col-${nameKey.replace(/\s+/g, '-')}`,
          board_id: 'all',
        });
      }
    });
    return { displayColumns: Array.from(uniqueMap.values()), columnMap: map };
  }, [columns, selectedBoardId, board]);

  // Keep exactly one card opener in the tab order whenever the rendered board
  // has cards. This also repairs focus state after filtering, pagination, or a
  // move removes the previously focused card from the visible set.
  useEffect(() => {
    const visibleCards = displayColumns.flatMap((column, columnIndex) => {
      const doneLimit = doneVisibleLimits[column.id] ?? DONE_LANE_PAGE_SIZE;
      return getLaneCards(cards, column.id, column.name, cardDateSortOrder, doneLimit, columnMap).visible.map((card) => ({
        card,
        columnIndex,
      }));
    });

    if (visibleCards.length === 0) {
      if (focusedCardId !== null) setFocusedCardId(null);
      return;
    }

    const focusedCard = visibleCards.find(({ card }) => card.id === focusedCardId);
    if (focusedCard) {
      if (focusedColumnIdx !== focusedCard.columnIndex) setFocusedColumnIdx(focusedCard.columnIndex);
      return;
    }

    setFocusedCardId(visibleCards[0].card.id);
    setFocusedColumnIdx(visibleCards[0].columnIndex);
  }, [displayColumns, cards, cardDateSortOrder, doneVisibleLimits, columnMap, focusedCardId, focusedColumnIdx]);

  const handleMoveCardWithResolution = async (cardId: string, targetColId: string, position?: string) => {
    let resolvedTargetColId = targetColId;
    if (targetColId.startsWith('all-col-')) {
      const targetCol = displayColumns.find((c) => c.id === targetColId);
      const targetCard = cards.find((c) => c.id === cardId);
      if (targetCol && targetCard) {
        const targetName = targetCol.name.trim().toLowerCase();
        const matchingRealCol = columns.find(
          (col) => col.board_id === targetCard.board_id && col.name.trim().toLowerCase() === targetName
        ) || columns.find((col) => col.name.trim().toLowerCase() === targetName);
        if (matchingRealCol) {
          resolvedTargetColId = matchingRealCol.id;
        }
      }
    }
    await onMoveCard(cardId, resolvedTargetColId, position);
    const movedCard = cards.find((card) => card.id === cardId);
    const targetColumn = columns.find((column) => column.id === resolvedTargetColId)
      || displayColumns.find((column) => column.id === targetColId);
    setBoardAnnouncement(`${movedCard?.key || 'Card'} moved to ${targetColumn?.name || 'the selected lane'}.`);
  };

  const closeCardModal = () => {
    setSelectedCardId(null);
    setCardDetails(null);
    setIsEditingCard(false);
    setIsCreatingCard(false);
    setNewCardColumnId('');
  };

  // Global Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showBoardSettingsModal) {
          setShowBoardSettingsModal(false);
        } else if (editingColumn) {
          setEditingColumn(null);
        } else if (cardDetails || isCreatingCard) {
          closeCardModal();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showBoardSettingsModal, editingColumn, cardDetails, isCreatingCard]);

  // Keyboard navigation across columns and cards
  useEffect(() => {
    const handleBoardKeyDown = (e: KeyboardEvent) => {
      const activeElement = document.activeElement;
      const isInsideModal = activeElement instanceof HTMLElement
        && Boolean(activeElement.closest('[role="dialog"][aria-modal="true"]'));
      const isTyping =
        activeElement &&
        (activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA' ||
          activeElement.tagName === 'SELECT' ||
          (activeElement as HTMLElement).isContentEditable);

      if (isInsideModal || isTyping || cardDetails || isCreatingCard || showBoardSettingsModal || editingColumn) {
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>('input[placeholder*="Search"]');
        searchInput?.focus();
        return;
      }

      if (displayColumns.length === 0) return;

      // Map columns to their exact visually rendered cards in order
      const colCardsMap: Record<string, Card[]> = {};
      displayColumns.forEach((col) => {
        const doneLimit = doneVisibleLimits[col.id] ?? DONE_LANE_PAGE_SIZE;
        colCardsMap[col.id] = getLaneCards(cards, col.id, col.name, cardDateSortOrder, doneLimit, columnMap).visible;
      });

      // Determine current active column and card index
      let activeColIdx = Math.min(Math.max(0, focusedColumnIdx), displayColumns.length - 1);
      let activeCardIdx = -1;

      if (focusedCardId) {
        for (let i = 0; i < displayColumns.length; i++) {
          const cList = colCardsMap[displayColumns[i].id] || [];
          const idx = cList.findIndex((c) => c.id === focusedCardId);
          if (idx !== -1) {
            activeColIdx = i;
            activeCardIdx = idx;
            break;
          }
        }
      }

      const activeCol = columns[activeColIdx];
      const activeColCards = colCardsMap[activeCol.id] || [];

      const focusCard = (cardId: string) => {
        setFocusedCardId(cardId);
        requestAnimationFrame(() => {
          const card = document.getElementById(`kanban-card-${cardId}`);
          if (card) {
            card.querySelector<HTMLElement>('[data-card-open]')?.focus();
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }
        });
      };

      switch (e.key) {
        case 'ArrowRight': {
          e.preventDefault();
          const nextColIdx = Math.min(columns.length - 1, activeColIdx + 1);
          setFocusedColumnIdx(nextColIdx);
          const nextCol = columns[nextColIdx];
          const nextColCards = colCardsMap[nextCol.id] || [];
          if (nextColCards.length > 0) {
            focusCard(nextColCards[Math.min(activeCardIdx >= 0 ? activeCardIdx : 0, nextColCards.length - 1)].id);
          } else {
            setFocusedCardId(null);
            document.getElementById(`kanban-column-${nextCol.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }
          break;
        }

        case 'ArrowLeft': {
          e.preventDefault();
          const prevColIdx = Math.max(0, activeColIdx - 1);
          setFocusedColumnIdx(prevColIdx);
          const prevCol = columns[prevColIdx];
          const prevColCards = colCardsMap[prevCol.id] || [];
          if (prevColCards.length > 0) {
            focusCard(prevColCards[Math.min(activeCardIdx >= 0 ? activeCardIdx : 0, prevColCards.length - 1)].id);
          } else {
            setFocusedCardId(null);
            document.getElementById(`kanban-column-${prevCol.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }
          break;
        }

        case 'ArrowDown': {
          e.preventDefault();
          if (activeColCards.length > 0) {
            const nextIdx = activeCardIdx >= 0 ? Math.min(activeColCards.length - 1, activeCardIdx + 1) : 0;
            focusCard(activeColCards[nextIdx].id);
          }
          break;
        }

        case 'ArrowUp': {
          e.preventDefault();
          if (activeColCards.length > 0) {
            const prevIdx = activeCardIdx >= 0 ? Math.max(0, activeCardIdx - 1) : activeColCards.length - 1;
            focusCard(activeColCards[prevIdx].id);
          }
          break;
        }

        case 'PageDown': {
          e.preventDefault();
          if (activeColCards.length > 0) {
            const nextIdx = activeCardIdx >= 0 ? Math.min(activeColCards.length - 1, activeCardIdx + 5) : 0;
            focusCard(activeColCards[nextIdx].id);
          }
          break;
        }

        case 'PageUp': {
          e.preventDefault();
          if (activeColCards.length > 0) {
            const prevIdx = activeCardIdx >= 0 ? Math.max(0, activeCardIdx - 5) : activeColCards.length - 1;
            focusCard(activeColCards[prevIdx].id);
          }
          break;
        }

        case 'Home': {
          e.preventDefault();
          if (activeColCards.length > 0) focusCard(activeColCards[0].id);
          break;
        }

        case 'End': {
          e.preventDefault();
          if (activeColCards.length > 0) focusCard(activeColCards[activeColCards.length - 1].id);
          break;
        }

        case 'Enter': {
          if (focusedCardId) {
            e.preventDefault();
            handleOpenCard(focusedCardId);
          }
          break;
        }

        case 'n':
        case 'N':
        case 'c':
        case 'C': {
          e.preventDefault();
          handleOpenNewCardForm(activeCol.id);
          break;
        }

        case 'Delete':
        case 'Backspace': {
          if (focusedCardId) {
            e.preventDefault();
            const focusedCard = cards.find((c) => c.id === focusedCardId);
            if (focusedCard) {
              handleDeleteCard(focusedCard.id, focusedCard.title);
              setFocusedCardId(null);
            }
          }
          break;
        }

        case 'Escape': {
          setFocusedCardId(null);
          break;
        }
      }
    };

    window.addEventListener('keydown', handleBoardKeyDown);
    return () => window.removeEventListener('keydown', handleBoardKeyDown);
  }, [columns, cards, focusedCardId, focusedColumnIdx, cardDateSortOrder, doneVisibleLimits, cardDetails, isCreatingCard, showBoardSettingsModal, editingColumn]);

  // Handle external new card requests
  useEffect(() => {
    if (newCardRequest && newCardRequest.token > 0) {
      handleOpenNewCardForm(newCardRequest.columnId);
      onNewCardRequestHandled?.();
    }
  }, [newCardRequest, onNewCardRequestHandled]);

  // Handle external open card requests
  useEffect(() => {
    if (openCardRequest && openCardRequest.token > 0 && openCardRequest.cardId) {
      setFocusedCardId(openCardRequest.cardId);
      handleOpenCard(openCardRequest.cardId);
      onOpenCardRequestHandled?.();
    }
  }, [openCardRequest, onOpenCardRequestHandled]);

  const handleOpenCard = async (cardId: string, isEdit = false) => {
    setSelectedCardId(cardId);
    setIsCreatingCard(false);
    setIsEditingCard(isEdit);
    try {
      const details = await api.getCardDetails(cardId);
      setCardDetails(details);
      if (isEdit) {
        setEditCardTitle(details.title);
        setEditCardDescription(details.description || '');
        setEditCardPriority(details.priority);
        setEditCardIsEpic(!!details.is_epic);
        setEditCardColumnId(details.column_id);
      }
    } catch (err) {
      console.error('Failed to load card details:', err);
    }
  };

  const handleOpenNewCardForm = (colId?: string) => {
    const targetColId = colId || columns[0]?.id;
    if (!targetColId) return;

    setSelectedCardId(null);
    setCardDetails(null);
    setIsCreatingCard(true);
    setIsEditingCard(true);
    setNewCardColumnId(targetColId);
    setEditCardTitle('');
    setEditCardDescription('');
    setEditCardPriority('medium');
    setEditCardIsEpic(false);
  };

  const handleStartEditingCard = () => {
    if (!cardDetails) return;
    setEditCardTitle(cardDetails.title);
    setEditCardDescription(cardDetails.description || '');
    setEditCardPriority(cardDetails.priority);
    setEditCardIsEpic(!!cardDetails.is_epic);
    setEditCardColumnId(cardDetails.column_id);
    setIsEditingCard(true);
  };

  const handleSaveCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cardDetails || !editCardTitle.trim()) return;

    try {
      const updated = await api.updateCard(cardDetails.id, {
        title: editCardTitle.trim(),
        description: editCardDescription.trim() || undefined,
        priority: editCardPriority,
        is_epic: editCardIsEpic ? 1 : 0,
        column_id: editCardColumnId !== cardDetails.column_id ? editCardColumnId : undefined,
      });

      setCardDetails((prev) => (prev ? { ...prev, ...updated } : null));
      setIsEditingCard(false);
      onRefresh();
    } catch (err) {
      console.error('Failed to update card:', err);
    }
  };

  const handleCreateCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editCardTitle.trim() || !newCardColumnId) return;

    try {
      const newCard = await api.createCard(newCardColumnId, {
        title: editCardTitle.trim(),
        description: editCardDescription.trim() || undefined,
        priority: editCardPriority,
        is_epic: editCardIsEpic,
      });

      closeCardModal();
      onRefresh();
      handleOpenCard(newCard.id);
    } catch (err) {
      console.error('Failed to create card:', err);
    }
  };

  const handleDeleteCard = async (cardId: string, title: string) => {
    if (!confirm(`Are you sure you want to delete card "${title}"?`)) return;

    try {
      await api.deleteCard(cardId);
      closeCardModal();
      onRefresh();
    } catch (err) {
      console.error('Failed to delete card:', err);
    }
  };

  const handleCopyKey = (key: string, cardId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(key);
    setCopiedKeyCardId(cardId);
    setTimeout(() => setCopiedKeyCardId(null), 2000);
  };

  const handleAssignAgent = async (agentId: string) => {
    if (!cardDetails) return;
    try {
      await api.assignCard(cardDetails.id, agentId);
      const updated = await api.getCardDetails(cardDetails.id);
      setCardDetails(updated);
      onRefresh();
    } catch (err) {
      console.error('Failed to assign agent:', err);
    }
  };

  const handleUnassignAgent = async (agentId: string) => {
    if (!cardDetails) return;
    try {
      await api.unassignCard(cardDetails.id, agentId);
      const updated = await api.getCardDetails(cardDetails.id);
      setCardDetails(updated);
      onRefresh();
    } catch (err) {
      console.error('Failed to unassign agent:', err);
    }
  };

  const handleLinkDocument = async (docId: string) => {
    if (!cardDetails) return;
    try {
      await api.linkDocument(cardDetails.id, docId);
      const updated = await api.getCardDetails(cardDetails.id);
      setCardDetails(updated);
      onRefresh();
    } catch (err) {
      console.error('Failed to link document:', err);
    }
  };

  const handleUnlinkDocument = async (docId: string) => {
    if (!cardDetails) return;
    try {
      await api.unlinkDocument(cardDetails.id, docId);
      const updated = await api.getCardDetails(cardDetails.id);
      setCardDetails(updated);
      onRefresh();
    } catch (err) {
      console.error('Failed to unlink document:', err);
    }
  };

  const handleOpenLinkedDocument = async (docId: string) => {
    setLoadingDocumentId(docId);
    try {
      const fullDoc = await api.getDocumentDetails(docId);
      setReaderDocument(fullDoc);
    } catch (err) {
      console.error('Failed to load document content:', err);
    } finally {
      setLoadingDocumentId(null);
    }
  };

  const handleLinkCard = async (targetCardId: string, relationType: CardLinkRelationType) => {
    if (!cardDetails) return;
    try {
      await api.linkCard(cardDetails.id, targetCardId, relationType);
      const updated = await api.getCardDetails(cardDetails.id);
      setCardDetails(updated);
      onRefresh();
    } catch (err) {
      console.error('Failed to link card:', err);
    }
  };

  const handleUnlinkCard = async (linkId: string) => {
    if (!cardDetails) return;
    try {
      await api.unlinkCard(cardDetails.id, linkId);
      const updated = await api.getCardDetails(cardDetails.id);
      setCardDetails(updated);
      onRefresh();
    } catch (err) {
      console.error('Failed to unlink card:', err);
    }
  };

  const handleAddWorkLink = async (data: { kind: CardWorkLinkKind; provider: CardWorkLinkProvider; url: string; external_ref?: string }) => {
    if (!cardDetails) return;
    await api.addWorkLink(cardDetails.id, data);
    const updated = await api.getCardDetails(cardDetails.id);
    setCardDetails(updated);
    onRefresh();
  };

  const handleRemoveWorkLink = async (linkId: string) => {
    if (!cardDetails) return;
    try {
      await api.removeWorkLink(cardDetails.id, linkId);
      const updated = await api.getCardDetails(cardDetails.id);
      setCardDetails(updated);
      onRefresh();
    } catch (err) {
      console.error('Failed to remove work link:', err);
    }
  };

  const handleAddComment = async (authorId: string, content: string) => {
    if (!cardDetails) return;
    try {
      await api.addComment(cardDetails.id, authorId, content);
      const updated = await api.getCardDetails(cardDetails.id);
      setCardDetails(updated);
      onRefresh();
    } catch (err) {
      console.error('Failed to add comment:', err);
    }
  };

  const handleUpdateComment = async (commentId: string, content: string) => {
    if (!cardDetails) return;
    try {
      await api.updateComment(cardDetails.id, commentId, content);
      const updated = await api.getCardDetails(cardDetails.id);
      setCardDetails(updated);
      onRefresh();
    } catch (err) {
      console.error('Failed to update comment:', err);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!cardDetails) return;
    if (!confirm('Are you sure you want to delete this comment?')) return;
    try {
      await api.deleteComment(cardDetails.id, commentId);
      const updated = await api.getCardDetails(cardDetails.id);
      setCardDetails(updated);
      onRefresh();
    } catch (err) {
      console.error('Failed to delete comment:', err);
    }
  };

  const handleRenameBoard = async () => {
    if (!board || !boardNameInput.trim()) return;
    try {
      await api.updateBoard(board.id, boardNameInput.trim());
      setIsEditingBoardName(false);
      onRefresh();
    } catch (err) {
      console.error('Failed to rename board:', err);
    }
  };

  const handleDeleteColumn = async (colId: string) => {
    try {
      await api.deleteColumn(colId);
      setEditingColumn(null);
      onRefresh();
    } catch (err) {
      console.error('Failed to delete column:', err);
    }
  };

  const onDragEnd = (result: DropResult) => {
    const { destination, source, draggableId, type } = result;
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;

    if (type === 'COLUMN') {
      const newPos = computeReorderedPosition(
        columns,
        source.index,
        destination.index
      );
      onMoveColumn(draggableId, newPos);
      return;
    }

    const targetColumnId = destination.droppableId.split(':::')[0];
    const sourceColumnId = source.droppableId.split(':::')[0];

    let targetColCards = cards.filter((c) => {
      if (c.archived) return false;
      if (targetColumnId.startsWith('all-col-')) {
        const targetCol = displayColumns.find((col) => col.id === targetColumnId);
        if (!targetCol) return false;
        const targetName = targetCol.name.trim().toLowerCase();
        const cColName = (columnMap[c.column_id] || '').trim().toLowerCase();
        return cColName === targetName;
      }
      return c.column_id === targetColumnId;
    });
    const targetEpicId = destination.droppableId.includes(':::') ? destination.droppableId.split(':::')[1] : null;
    if (targetEpicId && targetEpicId !== 'unparented') {
      targetColCards = targetColCards.filter((c) => c.parent_epic_id === targetEpicId || c.id === targetEpicId);
    } else if (targetEpicId === 'unparented') {
      targetColCards = targetColCards.filter((c) => !c.is_epic && !c.parent_epic_id);
    }

    const newPos = computeReorderedPosition(
      targetColCards,
      source.droppableId === destination.droppableId ? source.index : targetColCards.length,
      destination.index
    );

    handleMoveCardWithResolution(draggableId, targetColumnId, newPos);
  };

  if (!board) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 muster-text-muted text-sm font-sans">
        Select a board to view tasks.
      </div>
    );
  }

  return (
    <section className="flex-1 flex flex-col h-full min-h-0 font-sans space-y-4" aria-labelledby="kanban-board-heading">
      <h2 id="kanban-board-heading" className="sr-only">{board.name} Kanban board</h2>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{boardAnnouncement}</div>
      {/* Board Header Bar */}
      <div className="flex-none flex items-center justify-between border-b border-muster-border pb-3 gap-2 sm:gap-3">
        <div className="flex items-center space-x-2 sm:space-x-2.5 shrink-0 min-w-0">
          <Layout className="w-5 h-5 muster-accent shrink-0" />
          {isEditingBoardName ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleRenameBoard();
              }}
              className="flex items-center space-x-2"
            >
              <input
                type="text"
                value={boardNameInput}
                onChange={(e) => setBoardNameInput(e.target.value)}
                className="muster-input text-sm py-1 font-bold"
                autoFocus
              />
              <button type="submit" className="muster-btn muster-btn-primary py-1 px-2.5 text-xs">
                Save
              </button>
              <button
                type="button"
                onClick={() => setIsEditingBoardName(false)}
                className="muster-btn muster-btn-secondary py-1 px-2.5 text-xs"
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="flex items-center space-x-1 shrink-0 min-w-0">
              <div className="relative flex items-center shrink-0 min-w-0">
                <select
                  value={selectedBoardId || board.id}
                  onChange={(e) => {
                    if (e.target.value === '__NEW_BOARD__') {
                      onOpenNewBoard?.();
                    } else {
                      onSelectBoard(e.target.value);
                    }
                  }}
                  className="muster-input muster-touch-target text-sm sm:text-base font-bold py-1 pl-2 pr-7 bg-transparent hover:bg-muster-surface-hover border-transparent hover:border-muster-border rounded-lg cursor-pointer font-sans muster-text-primary focus:ring-1 focus:ring-brand-500 appearance-none max-w-[160px] xs:max-w-[220px] sm:max-w-[340px] truncate"
                  aria-label="Select board"
                >
                  <option value="all" className="bg-muster-surface text-xs font-bold py-1 muster-accent">
                    🌐 All Boards (All Cards)
                  </option>
                  {boards.map((b) => (
                    <option key={b.id} value={b.id} className="bg-muster-surface text-xs font-semibold py-1">
                      {b.name}
                    </option>
                  ))}
                  {onOpenNewBoard && (
                    <option value="__NEW_BOARD__" className="bg-muster-surface text-xs font-semibold py-1 muster-accent font-bold">
                      + Create New Board...
                    </option>
                  )}
                </select>
                <ChevronDown className="w-4 h-4 muster-text-muted absolute right-1.5 pointer-events-none" />
              </div>

              {board.id !== 'all' && (
                <button
                  onClick={() => {
                    setBoardNameInput(board.name);
                    setShowBoardSettingsModal(true);
                  }}
                  className="muster-touch-target p-1 muster-text-muted hover:muster-text-primary rounded transition-colors shrink-0"
                  title="Board Settings"
                  aria-label="Board settings"
                >
                  <Settings className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center space-x-2 min-w-0">
          <div className="flex items-center bg-muster-surface p-0.5 rounded-lg border border-muster-border shrink-0">
            <button
              onClick={() => setBoardViewMode('default')}
              aria-pressed={boardViewMode === 'default'}
              className={`muster-touch-target px-2 py-1 text-xs font-sans rounded-md flex items-center space-x-1.5 transition-colors cursor-pointer ${
                boardViewMode === 'default'
                  ? 'bg-brand-950 text-brand-300 font-semibold border border-brand-500/40 shadow-sm'
                  : 'muster-text-muted hover:muster-text-primary'
              }`}
              title="Standard Column View"
            >
              <Layout className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Columns</span>
            </button>
            <button
              onClick={() => setBoardViewMode('swimlanes')}
              aria-pressed={boardViewMode === 'swimlanes'}
              className={`muster-touch-target px-2 py-1 text-xs font-sans rounded-md flex items-center space-x-1.5 transition-colors cursor-pointer ${
                boardViewMode === 'swimlanes'
                  ? 'bg-brand-950 text-brand-300 font-semibold border border-brand-500/40 shadow-sm'
                  : 'muster-text-muted hover:muster-text-primary'
              }`}
              title="Epic Swimlanes View"
            >
              <Layers className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Epic Swimlanes</span>
            </button>
          </div>

          <CardSearch
            cards={cards}
            placeholder="Search card..."
            onSelectCard={(card) => handleOpenCard(card.id)}
            className="w-36 sm:w-60 min-w-0"
          />

          <button
            onClick={() => setCardDateSortOrder((prev) => (prev === 'newest' ? 'oldest' : 'newest'))}
            className="muster-btn muster-btn-icon muster-btn-secondary p-1.5 shrink-0"
            title={`Sort cards: ${cardDateSortOrder === 'newest' ? 'Newest updated first (click for oldest first)' : 'Oldest updated first (click for newest first)'}`}
            aria-label="Toggle card sort order by date updated"
          >
            {cardDateSortOrder === 'newest' ? (
              <ArrowDownWideNarrow className="w-4 h-4 muster-accent" />
            ) : (
              <ArrowUpNarrowWide className="w-4 h-4 muster-accent" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile Column Quick Switcher */}
      {columns.length > 0 && (
        <div className="flex md:hidden items-center space-x-1.5 overflow-x-auto no-scrollbar pb-2 shrink-0">
          {columns.map((col) => {
            const count = cards.filter((c) => c.column_id === col.id && !c.archived).length;
            return (
              <button
                key={col.id}
                onClick={() => {
                  const el = document.getElementById(`kanban-column-${col.id}`);
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                }}
                className={`muster-chip muster-touch-target shrink-0 text-xs font-sans py-1 px-2.5 flex items-center gap-1.5 cursor-pointer ${
                  focusedColumnIdx === columns.findIndex((c) => c.id === col.id)
                    ? 'border-brand-500 bg-brand-950/40 text-brand-300 font-semibold ring-1 ring-brand-500/50'
                    : 'hover:border-brand-500/50'
                }`}
              >
                <span>{col.name}</span>
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-neutral-900 muster-text-muted font-mono">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Main Board Area */}
      {boardViewMode === 'default' ? (
        <DragDropContext onDragEnd={onDragEnd}>
          <Droppable droppableId="board-columns" type="COLUMN" direction="horizontal">
            {(provided) => (
              <div
                ref={provided.innerRef}
                {...provided.droppableProps}
                className="flex-1 flex space-x-4 overflow-x-auto pb-4 min-h-0 select-none"
              >
                {displayColumns.map((column, colIdx) => {
                  const doneLimit = doneVisibleLimits[column.id] ?? DONE_LANE_PAGE_SIZE;
                  const { all: colCards, visible: visibleCards } = getLaneCards(
                    cards,
                    column.id,
                    column.name,
                    cardDateSortOrder,
                    doneLimit,
                    columnMap
                  );

                  return (
                    <Draggable key={column.id} draggableId={column.id} index={colIdx}>
                      {(colDragProvided) => (
                        <KanbanColumn
                          column={column}
                          columnIndex={colIdx}
                          allColumns={displayColumns}
                          columnCards={colCards}
                          visibleColumnCards={visibleCards}
                          focusedColumnIdx={focusedColumnIdx}
                          focusedCardId={focusedCardId}
                          copiedKeyCardId={copiedKeyCardId}
                          doneVisibleLimit={doneLimit}
                          columnDragProvided={colDragProvided}
                          highlightEpicId={hoveredEpicId}
                          onOpenNewCardForm={handleOpenNewCardForm}
                          onEditColumnSettings={setEditingColumn}
                          onFocusCard={setFocusedCardId}
                          onOpenCard={handleOpenCard}
                          onCopyKey={handleCopyKey}
                          onDeleteCard={handleDeleteCard}
                          onMoveCard={async (cId, tId) => handleMoveCardWithResolution(cId, tId)}
                          onSetDoneVisibleLimit={(cId, limit) =>
                            setDoneVisibleLimits((curr) => ({ ...curr, [cId]: limit }))
                          }
                          onHoverEpicId={setHoveredEpicId}
                        />
                      )}
                    </Draggable>
                  );
                })}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      ) : (
        <DragDropContext onDragEnd={onDragEnd}>
          <div className="flex-1 overflow-y-auto space-y-6 pb-6 min-h-0 select-none pr-1">
            {(() => {
              const epics = cards.filter((c) => c.is_epic && !c.archived);
              const unparentedCards = cards.filter((c) => !c.is_epic && !c.parent_epic_id && !c.archived);
              const terminalColIds = new Set(columns.filter((col) => col.is_terminal || isDoneLane(col.name)).map((col) => col.id));

              if (epics.length === 0) {
                return (
                  <div className="p-8 rounded-xl border border-dashed border-muster-border text-center muster-text-muted font-sans text-xs space-y-2">
                    <Layers className="w-8 h-8 mx-auto text-brand-400 opacity-60 mb-2" />
                    <p className="font-semibold text-sm muster-text-primary">No Epics defined on this board yet</p>
                    <p>Create a card and mark it as an <strong>EPIC</strong> to group child tasks into swimlanes.</p>
                  </div>
                );
              }

              return (
                <>
                  {epics.map((epic) => {
                    const children = cards.filter((c) => c.parent_epic_id === epic.id && !c.archived);
                    const doneCount = children.filter((c) => terminalColIds.has(c.column_id)).length;
                    const pct = children.length > 0 ? Math.round((doneCount / children.length) * 100) : 0;
                    const isCompleted = children.length > 0 && doneCount === children.length;
                    const isCollapsed = collapsedEpics[epic.id] ?? isCompleted;

                    return (
                      <div
                        key={epic.id}
                        className="rounded-xl border border-muster-border bg-muster-surface/40 hover:border-brand-500/40 transition-all"
                      >
                        {/* Epic Swimlane Header Bar */}
                        <div className="p-3.5 border-b border-muster-border flex flex-wrap items-center justify-between gap-3 bg-neutral-900/60 rounded-t-xl">
                          <div className="flex items-center space-x-2 min-w-0">
                            <button
                              onClick={() =>
                                setCollapsedEpics((prev) => ({ ...prev, [epic.id]: !isCollapsed }))
                              }
                              className="p-1 hover:bg-neutral-800 rounded muster-text-muted hover:muster-text-primary transition-colors cursor-pointer"
                              title={isCollapsed ? 'Expand Swimlane' : 'Collapse Swimlane'}
                            >
                              {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            </button>
                            <span className="muster-badge muster-badge-accent flex items-center shrink-0">
                              <Layers className="w-3 h-3 mr-1" />
                              {epic.key}
                            </span>
                            <button
                              onClick={() => handleOpenCard(epic.id)}
                              className="font-sans font-bold text-xs sm:text-sm muster-text-primary hover:text-brand-300 truncate max-w-[220px] sm:max-w-md text-left cursor-pointer"
                              title={`View Epic ${epic.key}`}
                            >
                              {epic.title}
                            </button>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-neutral-950 muster-text-muted border border-muster-border">
                              {children.length} {children.length === 1 ? 'task' : 'tasks'}
                            </span>
                            {isCompleted && (
                              <span className="muster-chip muster-badge-success text-[10px] py-0.5 px-2 font-semibold">
                                Completed
                              </span>
                            )}
                          </div>

                          <div className="flex items-center space-x-4">
                            {/* Epic Progress Bar */}
                            <div className="flex items-center space-x-2">
                              <span className="text-[10px] font-mono text-neutral-400">
                                Progress: <strong className="muster-text-primary">{doneCount}/{children.length}</strong> ({pct}%)
                              </span>
                              <div className="w-24 sm:w-32 bg-neutral-950 h-2 rounded-full overflow-hidden border border-muster-border">
                                <div
                                  className="bg-brand-500 h-full transition-all duration-300"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Epic Swimlane Columns */}
                        {!isCollapsed && (
                          <div className="p-3 flex space-x-4 overflow-x-auto">
                            {displayColumns.map((column, colIdx) => {
                              const laneCards = children.filter((c) => {
                                if (column.id.startsWith('all-col-')) {
                                  const cColName = (columnMap[c.column_id] || '').trim().toLowerCase();
                                  return cColName === column.name.trim().toLowerCase();
                                }
                                return c.column_id === column.id;
                              });
                              return (
                                <KanbanColumn
                                  key={`${column.id}:::${epic.id}`}
                                  column={column}
                                  columnIndex={colIdx}
                                  allColumns={displayColumns}
                                  columnCards={laneCards}
                                  visibleColumnCards={laneCards}
                                  focusedColumnIdx={focusedColumnIdx}
                                  focusedCardId={focusedCardId}
                                  copiedKeyCardId={copiedKeyCardId}
                                  doneVisibleLimit={DONE_LANE_PAGE_SIZE}
                                  columnDragProvided={{
                                    draggableProps: {} as any,
                                    dragHandleProps: null as any,
                                    innerRef: () => {},
                                  }}
                                  droppableId={`${column.id}:::${epic.id}`}
                                  onOpenNewCardForm={handleOpenNewCardForm}
                                  onEditColumnSettings={setEditingColumn}
                                  onFocusCard={setFocusedCardId}
                                  onOpenCard={handleOpenCard}
                                  onCopyKey={handleCopyKey}
                                  onDeleteCard={handleDeleteCard}
                                  onMoveCard={async (cId, tId) => handleMoveCardWithResolution(cId, tId)}
                                  onSetDoneVisibleLimit={(cId, limit) =>
                                    setDoneVisibleLimits((curr) => ({ ...curr, [cId]: limit }))
                                  }
                                />
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Unparented Cards Swimlane */}
                  {unparentedCards.length > 0 && (
                    <div className="rounded-xl border border-muster-border bg-muster-surface/20">
                      <div className="p-3.5 border-b border-muster-border flex items-center justify-between bg-neutral-900/40 rounded-t-xl">
                        <div className="flex items-center space-x-2">
                          <h4 className="font-sans font-bold text-xs uppercase tracking-wider text-neutral-400">
                            Standard Tasks (No Epic)
                          </h4>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-neutral-950 muster-text-muted border border-muster-border">
                            {unparentedCards.length}
                          </span>
                        </div>
                      </div>

                      <div className="p-3 flex space-x-4 overflow-x-auto">
                        {displayColumns.map((column, colIdx) => {
                          const laneCards = unparentedCards.filter((c) => {
                            if (column.id.startsWith('all-col-')) {
                              const cColName = (columnMap[c.column_id] || '').trim().toLowerCase();
                              return cColName === column.name.trim().toLowerCase();
                            }
                            return c.column_id === column.id;
                          });
                          return (
                            <KanbanColumn
                              key={`${column.id}:::unparented`}
                              column={column}
                              columnIndex={colIdx}
                              allColumns={displayColumns}
                              columnCards={laneCards}
                              visibleColumnCards={laneCards}
                              focusedColumnIdx={focusedColumnIdx}
                              focusedCardId={focusedCardId}
                              copiedKeyCardId={copiedKeyCardId}
                              doneVisibleLimit={DONE_LANE_PAGE_SIZE}
                              columnDragProvided={{
                                draggableProps: {} as any,
                                dragHandleProps: null as any,
                                innerRef: () => {},
                              }}
                              droppableId={`${column.id}:::unparented`}
                              onOpenNewCardForm={handleOpenNewCardForm}
                              onEditColumnSettings={setEditingColumn}
                              onFocusCard={setFocusedCardId}
                              onOpenCard={handleOpenCard}
                              onCopyKey={handleCopyKey}
                              onDeleteCard={handleDeleteCard}
                              onMoveCard={async (cId, tId) => handleMoveCardWithResolution(cId, tId)}
                              onSetDoneVisibleLimit={(cId, limit) =>
                                setDoneVisibleLimits((curr) => ({ ...curr, [cId]: limit }))
                              }
                              onHoverEpicId={setHoveredEpicId}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </DragDropContext>
      )}

      {/* Card Details / Drawer Modal */}
      {(cardDetails || isCreatingCard) && (
        <CardDetailDrawer
          cardDetails={cardDetails}
          columns={columns}
          allCards={cards}
          users={users}
          agents={agents}
          documents={documents}
          currentUser={currentUser}
          copiedKeyCardId={copiedKeyCardId}
          isEditingCard={isEditingCard}
          isCreatingCard={isCreatingCard}
          editCardTitle={editCardTitle}
          editCardDescription={editCardDescription}
          editCardPriority={editCardPriority}
          editCardIsEpic={editCardIsEpic}
          editCardColumnId={editCardColumnId}
          newCardColumnId={newCardColumnId}
          loadingDocumentId={loadingDocumentId}
          onClose={closeCardModal}
          onCopyKey={handleCopyKey}
          onMoveCard={async (cId, tId) => {
            onMoveCard(cId, tId);
            setCardDetails((prev) => (prev ? { ...prev, column_id: tId } : null));
          }}
          onStartEditingCard={handleStartEditingCard}
          onDeleteCard={handleDeleteCard}
          onSaveCard={handleSaveCard}
          onCreateCard={handleCreateCard}
          setEditCardTitle={setEditCardTitle}
          setEditCardDescription={setEditCardDescription}
          setEditCardPriority={setEditCardPriority}
          setEditCardIsEpic={setEditCardIsEpic}
          setEditCardColumnId={setEditCardColumnId}
          setNewCardColumnId={setNewCardColumnId}
          setIsEditingCard={setIsEditingCard}
          onAssignAgent={handleAssignAgent}
          onUnassignAgent={handleUnassignAgent}
          onOpenLinkedDocument={handleOpenLinkedDocument}
          onLinkDocument={handleLinkDocument}
          onUnlinkDocument={handleUnlinkDocument}
          onLinkCard={handleLinkCard}
          onUnlinkCard={(lId, _title) => handleUnlinkCard(lId)}
          onAddWorkLink={handleAddWorkLink}
          onRemoveWorkLink={handleRemoveWorkLink}
          onOpenCard={handleOpenCard}
          onAddComment={handleAddComment}
          onUpdateComment={handleUpdateComment}
          onDeleteComment={handleDeleteComment}
        />
      )}

      {/* Document Reader Modal */}
      {readerDocument && (
        <DocumentReaderModal
          document={readerDocument}
          onClose={() => setReaderDocument(null)}
          onOpenInVault={onOpenDocumentInVault}
        />
      )}

      {/* Board Settings Modal */}
      {showBoardSettingsModal && (
        <AccessibleDialog
          onClose={() => setShowBoardSettingsModal(false)}
          titleId="board-settings-title"
          className="w-full max-w-md p-5 space-y-4 font-sans"
        >
            <div className="flex items-center justify-between border-b border-muster-border pb-3">
              <h2 id="board-settings-title" className="text-sm font-bold muster-text-primary flex items-center">
                <Settings className="w-4 h-4 mr-2 muster-accent" /> Board Settings
              </h2>
              <button onClick={() => setShowBoardSettingsModal(false)} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" aria-label="Close board settings">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleRenameBoard();
                setShowBoardSettingsModal(false);
              }}
              className="space-y-2"
            >
              <label className="muster-label">Rename Board</label>
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={boardNameInput}
                  onChange={(e) => setBoardNameInput(e.target.value)}
                  placeholder="Board name"
                  className="muster-input flex-1"
                />
                <button
                  type="submit"
                  disabled={!boardNameInput.trim() || boardNameInput === board.name}
                  className="muster-btn muster-btn-primary"
                >
                  Save
                </button>
              </div>
            </form>

            <div className="border-t border-muster-border/60 pt-3 space-y-2">
              <label className="muster-label">Board Actions</label>
              <div className="flex flex-col space-y-2">
                <button
                  onClick={() => {
                    setShowBoardSettingsModal(false);
                    onOpenNewColumn();
                  }}
                  className="muster-btn muster-btn-secondary justify-start text-xs py-2"
                >
                  <Plus className="w-4 h-4 mr-1.5 muster-accent" /> Add New Column
                </button>

                <button
                  onClick={() => {
                    setShowBoardSettingsModal(false);
                    if (
                      confirm(
                        `Are you sure you want to delete board "${board.name}"?\n\nThis will permanently delete all columns and cards on this board.`
                      )
                    ) {
                      onDeleteBoard(board.id);
                    }
                  }}
                  className="muster-btn muster-btn-danger-soft justify-start text-xs py-2"
                >
                  <Trash2 className="w-4 h-4 mr-1.5" /> Delete Board
                </button>
              </div>
            </div>
        </AccessibleDialog>
      )}

      {/* Edit Column Modal */}
      {editingColumn && (
        <EditColumnModal
          column={editingColumn}
          onClose={() => setEditingColumn(null)}
          onSuccess={() => {
            setEditingColumn(null);
            onRefresh();
          }}
          onDelete={(colId) => handleDeleteColumn(colId)}
        />
      )}
    </section>
  );
};
