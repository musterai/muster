import React from 'react';
import { DraggableProvided, Droppable } from '@hello-pangea/dnd';
import { Card, Column } from '../../types.js';
import { GripVertical, Plus, Edit2 } from 'lucide-react';
import { CardItem } from './CardItem.js';

const DONE_LANE_PAGE_SIZE = 10;

interface KanbanColumnProps {
  column: Column;
  columnIndex: number;
  allColumns: Column[];
  columnCards: Card[];
  visibleColumnCards: Card[];
  focusedColumnIdx: number;
  focusedCardId: string | null;
  copiedKeyCardId: string | null;
  doneVisibleLimit?: number;
  columnDragProvided?: DraggableProvided;
  droppableId?: string;
  highlightEpicId?: string | null;
  maxHeightClass?: string;
  onOpenNewCardForm?: (columnId: string) => void;
  onEditColumnSettings?: (column: Column) => void;
  onFocusCard: (cardId: string) => void;
  onOpenCard: (cardId: string, isEdit?: boolean) => void;
  onCopyKey: (key: string, cardId: string, e: React.MouseEvent) => void;
  onDeleteCard: (cardId: string, title: string) => void;
  onMoveCard: (cardId: string, targetColId: string) => Promise<void>;
  onSetDoneVisibleLimit: (columnId: string, limit: number) => void;
  onHoverEpicId?: (epicId: string | null) => void;
}

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  column,
  columnIndex,
  allColumns,
  columnCards,
  visibleColumnCards,
  focusedColumnIdx,
  focusedCardId,
  copiedKeyCardId,
  doneVisibleLimit = DONE_LANE_PAGE_SIZE,
  columnDragProvided,
  droppableId,
  highlightEpicId,
  maxHeightClass,
  onOpenNewCardForm,
  onEditColumnSettings,
  onFocusCard,
  onOpenCard,
  onCopyKey,
  onDeleteCard,
  onMoveCard,
  onSetDoneVisibleLimit,
  onHoverEpicId,
}) => {
  const isExceededWip = column.wip_limit !== null && columnCards.length > column.wip_limit;
  const isAtWipLimit = column.wip_limit !== null && columnCards.length === column.wip_limit;
  const hiddenCount = columnCards.length - visibleColumnCards.length;

  return (
    <section
      id={`kanban-column-${column.id}`}
      aria-labelledby={`kanban-column-heading-${column.id}`}
      ref={columnDragProvided?.innerRef}
      {...columnDragProvided?.draggableProps}
      className={`w-72 sm:w-80 flex-shrink-0 flex flex-col ${maxHeightClass || 'max-h-full'} rounded-xl border font-sans ${
        isExceededWip
          ? 'bg-danger-950/20 border-danger-500/40'
          : isAtWipLimit
          ? 'bg-warning-950/20 border-warning-500/40'
          : 'bg-muster-base border-muster-border'
      }`}
    >
      {/* Column Header */}
      <div
        className={`p-3.5 border-b flex items-center justify-between rounded-t-xl ${
          focusedColumnIdx === columnIndex
            ? 'bg-brand-950/40 border-brand-500/40'
            : isExceededWip
            ? 'bg-danger-950/40 border-danger-500/50 text-danger-300'
            : isAtWipLimit
            ? 'bg-warning-950/40 border-warning-500/50 text-warning-300'
            : 'border-muster-border muster-text-primary'
        }`}
      >
        <div className="flex items-center space-x-2">
          {columnDragProvided?.dragHandleProps && (
            <span
              {...columnDragProvided.dragHandleProps}
              className="cursor-grab active:cursor-grabbing muster-text-muted hover:muster-text-primary -ml-1 flex-shrink-0"
              title="Drag to reorder column"
              aria-label={`Drag to reorder ${column.name} column`}
            >
              <GripVertical className="w-3.5 h-3.5" />
            </span>
          )}
          <h3 id={`kanban-column-heading-${column.id}`} className="font-sans text-xs font-bold tracking-wide uppercase">{column.name}</h3>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-muster-surface-hover muster-text-secondary border border-muster-border">
            {columnCards.length}
          </span>
        </div>

        <div className="flex items-center space-x-1.5">
          {column.wip_limit !== null && (
            <span
              title="WIP limit"
              className={`text-[10px] font-mono font-semibold ${
                isExceededWip ? 'muster-text-danger' : isAtWipLimit ? 'muster-text-warning' : 'muster-text-muted'
              }`}
            >
              {columnCards.length}/{column.wip_limit}
            </span>
          )}

          {onOpenNewCardForm && (
            <button
              onClick={() => onOpenNewCardForm(column.id)}
              className="muster-touch-target p-1 hover:bg-neutral-800 muster-text-muted hover:text-brand-400 rounded transition-colors cursor-pointer"
              title="Add card to column"
              aria-label={`Add card to ${column.name}`}
            >
              <Plus className="w-4 h-4" />
            </button>
          )}

          {onEditColumnSettings && (
            <button
              onClick={() => onEditColumnSettings(column)}
              className="muster-touch-target p-1 hover:bg-neutral-800 muster-text-muted hover:text-brand-400 rounded transition-colors cursor-pointer"
              title="Edit column settings"
              aria-label={`Edit ${column.name} column settings`}
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Droppable Area */}
      <Droppable droppableId={droppableId || column.id}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            role="list"
            aria-label={`${column.name} cards`}
            className={`p-3 flex-1 overflow-y-auto space-y-3 transition-colors ${snapshot.isDraggingOver ? 'bg-brand-950/20' : ''}`}
          >
            {visibleColumnCards.map((card, index) => (
              <CardItem
                key={card.id}
                card={card}
                column={column}
                allColumns={allColumns}
                focusedCardId={focusedCardId}
                copiedKeyCardId={copiedKeyCardId}
                index={index}
                highlightEpicId={highlightEpicId}
                onFocusCard={onFocusCard}
                onOpenCard={onOpenCard}
                onCopyKey={onCopyKey}
                onDeleteCard={onDeleteCard}
                onMoveCard={onMoveCard}
                onHoverEpicId={onHoverEpicId}
              />
            ))}
            {provided.placeholder}

            {column.workflow_role === 'terminal' && columnCards.length > DONE_LANE_PAGE_SIZE && (
              <div className="muster-panel p-3 space-y-2 text-center">
                <p className="text-[10px] font-sans muster-text-muted">
                  Showing {visibleColumnCards.length} of {columnCards.length} cards
                </p>
                <div className="flex items-center justify-center gap-2">
                  {hiddenCount > 0 && (
                    <button
                      type="button"
                      onClick={() => onSetDoneVisibleLimit(column.id, doneVisibleLimit + DONE_LANE_PAGE_SIZE)}
                      className="muster-btn muster-btn-soft"
                    >
                      Show {Math.min(DONE_LANE_PAGE_SIZE, hiddenCount)} more
                    </button>
                  )}
                  {doneVisibleLimit > DONE_LANE_PAGE_SIZE && (
                    <button
                      type="button"
                      onClick={() => onSetDoneVisibleLimit(column.id, DONE_LANE_PAGE_SIZE)}
                      className="muster-btn muster-btn-ghost"
                    >
                      Show fewer
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Droppable>
    </section>
  );
};
