import React from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, Layers, Layout, Settings } from 'lucide-react';
import type { Board, Card } from '../../types.js';
import type { CardDateSortOrder } from '../../kanban.js';
import type { BoardViewMode } from '../../hooks/useBoardViewMode.js';
import { CardSearch } from '../CardSearch.js';

interface KanbanToolbarProps {
  boards: Board[];
  board: Board;
  selectedBoardId: string | null;
  isEditingBoardName: boolean;
  boardNameInput: string;
  boardViewMode: BoardViewMode;
  cards: Card[];
  cardDateSortOrder: CardDateSortOrder;
  onSelectBoard: (boardId: string) => void;
  onOpenNewBoard?: () => void;
  onBoardNameInput: (name: string) => void;
  onRenameBoard: () => void;
  onCancelRename: () => void;
  onOpenBoardSettings: () => void;
  onSetBoardViewMode: (mode: BoardViewMode) => void;
  onOpenCard: (cardId: string) => void;
  onToggleSort: () => void;
}

export const KanbanToolbar: React.FC<KanbanToolbarProps> = ({
  boards,
  board,
  selectedBoardId,
  isEditingBoardName,
  boardNameInput,
  boardViewMode,
  cards,
  cardDateSortOrder,
  onSelectBoard,
  onOpenNewBoard,
  onBoardNameInput,
  onRenameBoard,
  onCancelRename,
  onOpenBoardSettings,
  onSetBoardViewMode,
  onOpenCard,
  onToggleSort,
}) => (
  <div className="flex-none flex items-center justify-between border-b border-muster-border pb-3 gap-2 sm:gap-3">
    <div className="flex items-center space-x-2 sm:space-x-2.5 shrink-0 min-w-0">
      <Layout className="w-5 h-5 muster-accent shrink-0" />
      {isEditingBoardName ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onRenameBoard();
          }}
          className="flex items-center space-x-2"
        >
          <input
            type="text"
            value={boardNameInput}
            onChange={(event) => onBoardNameInput(event.target.value)}
            className="muster-input text-sm py-1 font-bold"
            autoFocus
          />
          <button type="submit" className="muster-btn muster-btn-primary py-1 px-2.5 text-xs">Save</button>
          <button type="button" onClick={onCancelRename} className="muster-btn muster-btn-secondary py-1 px-2.5 text-xs">Cancel</button>
        </form>
      ) : (
        <div className="flex items-center space-x-1 shrink-0 min-w-0">
          <div className="relative flex items-center shrink-0 min-w-0">
            <select
              value={selectedBoardId || board.id}
              onChange={(event) => event.target.value === '__NEW_BOARD__' ? onOpenNewBoard?.() : onSelectBoard(event.target.value)}
              className="muster-input muster-touch-target text-sm sm:text-base font-bold py-1 pl-2 pr-7 bg-transparent hover:bg-muster-surface-hover border-transparent hover:border-muster-border rounded-lg cursor-pointer font-sans muster-text-primary focus:ring-1 focus:ring-brand-500 appearance-none max-w-[160px] xs:max-w-[220px] sm:max-w-[340px] truncate"
              aria-label="Select board"
            >
              <option value="all" className="bg-muster-surface text-xs font-bold py-1 muster-accent">🌐 All Boards (All Cards)</option>
              {boards.map((candidate) => (
                <option key={candidate.id} value={candidate.id} className="bg-muster-surface text-xs font-semibold py-1">{candidate.name}</option>
              ))}
              {onOpenNewBoard && (
                <option value="__NEW_BOARD__" className="bg-muster-surface text-xs font-semibold py-1 muster-accent font-bold">+ Create New Board...</option>
              )}
            </select>
            <ChevronDown className="w-4 h-4 muster-text-muted absolute right-1.5 pointer-events-none" />
          </div>
          {board.id !== 'all' && (
            <button
              onClick={onOpenBoardSettings}
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
          onClick={() => onSetBoardViewMode('default')}
          aria-pressed={boardViewMode === 'default'}
          className={`muster-touch-target px-2 py-1 text-xs font-sans rounded-md flex items-center space-x-1.5 transition-colors cursor-pointer ${boardViewMode === 'default' ? 'bg-brand-950 text-brand-300 font-semibold border border-brand-500/40 shadow-sm' : 'muster-text-muted hover:muster-text-primary'}`}
          title="Standard Column View"
        >
          <Layout className="w-3.5 h-3.5" /><span className="hidden sm:inline">Columns</span>
        </button>
        <button
          onClick={() => onSetBoardViewMode('swimlanes')}
          aria-pressed={boardViewMode === 'swimlanes'}
          className={`muster-touch-target px-2 py-1 text-xs font-sans rounded-md flex items-center space-x-1.5 transition-colors cursor-pointer ${boardViewMode === 'swimlanes' ? 'bg-brand-950 text-brand-300 font-semibold border border-brand-500/40 shadow-sm' : 'muster-text-muted hover:muster-text-primary'}`}
          title="Epic Swimlanes View"
        >
          <Layers className="w-3.5 h-3.5" /><span className="hidden sm:inline">Epic Swimlanes</span>
        </button>
      </div>
      <CardSearch cards={cards} placeholder="Search card..." onSelectCard={(card) => onOpenCard(card.id)} className="w-36 sm:w-60 min-w-0" />
      <button
        onClick={onToggleSort}
        className="muster-btn muster-btn-icon muster-btn-secondary p-1.5 shrink-0"
        title={`Sort cards: ${cardDateSortOrder === 'newest' ? 'Newest updated first (click for oldest first)' : 'Oldest updated first (click for newest first)'}`}
        aria-label="Toggle card sort order by date updated"
      >
        {cardDateSortOrder === 'newest'
          ? <ArrowDownWideNarrow className="w-4 h-4 muster-accent" />
          : <ArrowUpNarrowWide className="w-4 h-4 muster-accent" />}
      </button>
    </div>
  </div>
);
