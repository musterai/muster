import React from 'react';
import { Draggable } from '@hello-pangea/dnd';
import { Card, Column } from '../../types.js';
import { Layers, Layout, Copy, Check, Edit2, Trash2, GripVertical } from 'lucide-react';
import { PrincipalChip } from '../PrincipalChip.js';
import { PRIORITY_BADGE_CLASSES } from '../../utils/card-helpers.js';

interface CardItemProps {
  card: Card;
  column: Column;
  allColumns: Column[];
  focusedCardId: string | null;
  copiedKeyCardId: string | null;
  index: number;
  highlightEpicId?: string | null;
  showBoardName?: boolean;
  showParentEpic?: boolean;
  onFocusCard: (cardId: string) => void;
  onOpenCard: (cardId: string, isEdit?: boolean) => void;
  onCopyKey: (key: string, cardId: string, e: React.MouseEvent) => void;
  onDeleteCard: (cardId: string, title: string) => void;
  onMoveCard: (cardId: string, targetColId: string) => Promise<void>;
  onHoverEpicId?: (epicId: string | null) => void;
}

export const CardItem: React.FC<CardItemProps> = ({
  card,
  column,
  allColumns,
  focusedCardId,
  copiedKeyCardId,
  index,
  highlightEpicId,
  showBoardName = false,
  showParentEpic = true,
  onFocusCard,
  onOpenCard,
  onCopyKey,
  onDeleteCard,
  onMoveCard,
  onHoverEpicId,
}) => {
  const getPriorityBadge = (priority: string) => {
    const cls = PRIORITY_BADGE_CLASSES[priority] || 'muster-badge-neutral';
    return <span className={`muster-badge ${cls}`}>{priority}</span>;
  };

  const isEpicRelated = highlightEpicId && (card.id === highlightEpicId || card.parent_epic_id === highlightEpicId);
  const isDimmed = highlightEpicId && !isEpicRelated;

  return (
    <Draggable
      key={card.id}
      draggableId={card.id}
      index={index}
      disableInteractiveElementBlocking
    >
      {(dragProvided, dragSnapshot) => (
        <div
          id={`kanban-card-${card.id}`}
          role="listitem"
          ref={dragProvided.innerRef}
          {...dragProvided.draggableProps}
          onMouseEnter={() => {
            if (card.is_epic) {
              onHoverEpicId?.(card.id);
            } else if (card.parent_epic_id) {
              onHoverEpicId?.(card.parent_epic_id);
            }
          }}
          onMouseLeave={() => onHoverEpicId?.(null)}
          className={`p-3.5 rounded-lg border transition-all group ${
            isDimmed ? 'opacity-35 transition-opacity' : ''
          } ${
            focusedCardId === card.id
              ? 'ring-2 ring-brand-500 bg-brand-950/30 border-brand-500 shadow-xl scale-[1.01]'
              : isEpicRelated
              ? 'ring-2 ring-brand-400 bg-brand-950/40 border-brand-400 shadow-lg scale-[1.01]'
              : dragSnapshot.isDragging
              ? 'bg-muster-surface border-brand-500 shadow-lg scale-102 z-50'
              : card.is_epic
              ? 'bg-brand-950/20 border-brand-500/50 hover:border-brand-500/80 hover:bg-brand-950/30'
              : 'bg-muster-surface border-muster-border hover:border-brand-500/40 hover:bg-neutral-900/90'
          }`}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-1">
              <button
                {...dragProvided.dragHandleProps}
                className="muster-btn muster-btn-icon muster-btn-ghost muster-card-action"
                aria-label={`Drag ${card.key}: ${card.title}. Press Space to lift, then use arrow keys to reorder.`}
                title="Drag or use the keyboard to reorder card"
              >
                <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <button
                onClick={(e) => onCopyKey(card.key, card.id, e)}
                className="muster-btn muster-btn-ghost muster-card-action font-mono text-[10px]"
                aria-label={`Copy card key ${card.key}`}
                title="Copy card key"
              >
                {copiedKeyCardId === card.id ? <Check className="w-3 h-3" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />}
                <span>{card.key}</span>
              </button>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {!!card.is_epic && (
                <span className="muster-badge muster-badge-accent flex items-center" title="Epic — a container for related work">
                  <Layers className="w-3 h-3 mr-1" aria-hidden="true" />
                  EPIC
                </span>
              )}
              {getPriorityBadge(card.priority)}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenCard(card.id, true);
                }}
                className="muster-btn muster-btn-icon muster-btn-ghost muster-card-action"
                title="Edit Task"
                aria-label={`Edit ${card.key}: ${card.title}`}
              >
                <Edit2 className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteCard(card.id, card.title);
                }}
                className="muster-btn muster-btn-icon muster-btn-ghost-danger muster-card-action"
                title="Delete Card"
                aria-label={`Delete ${card.key}: ${card.title}`}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>

          {((showBoardName && card.board_name) || (showParentEpic && card.parent_epic_key)) && (
            <div
              className="flex items-center gap-2 min-w-0 mb-2 text-[10px] font-mono muster-text-muted"
              aria-label="Card context"
            >
              {showBoardName && card.board_name && (
                <span className="inline-flex items-center gap-1 min-w-0" title={`Board: ${card.board_name}`}>
                  <Layout className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{card.board_name}</span>
                </span>
              )}
              {showBoardName && card.board_name && showParentEpic && card.parent_epic_key && (
                <span className="muster-divider w-0.5 h-0.5 rounded-full shrink-0" aria-hidden="true" />
              )}
              {showParentEpic && card.parent_epic_key && (
                <span
                  className="inline-flex items-center gap-1 min-w-0 hover:text-brand-400 transition-colors"
                  title={`Parent Epic: ${card.parent_epic_key} - ${card.parent_epic_title}`}
                  onMouseEnter={(e) => {
                    e.stopPropagation();
                    onHoverEpicId?.(card.parent_epic_id || null);
                  }}
                  onMouseLeave={(e) => {
                    e.stopPropagation();
                    onHoverEpicId?.(null);
                  }}
                >
                  <Layers className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                  <span className="font-semibold shrink-0">{card.parent_epic_key}</span>
                  <span className="truncate font-sans">{card.parent_epic_title}</span>
                </span>
              )}
            </div>
          )}

          <h4 className="text-xs font-sans font-semibold line-clamp-2 mb-2">
            <button
              type="button"
              data-card-open
              tabIndex={focusedCardId === card.id ? 0 : -1}
              onFocus={() => onFocusCard(card.id)}
              onClick={() => {
                onFocusCard(card.id);
                onOpenCard(card.id);
              }}
              className="muster-touch-target w-full text-left muster-text-primary group-hover:text-brand-200 rounded"
              aria-label={`Open ${card.key}: ${card.title}`}
            >
              {card.title}
            </button>
          </h4>

          {card.description && (
            <p className="text-[11px] font-sans muster-text-muted line-clamp-2 mb-3">
              {card.description}
            </p>
          )}

          {card.assignees && card.assignees.length > 0 && (
            <div
              className="flex flex-wrap gap-1 mb-2"
              aria-label={`Assigned to ${card.assignees.map((agent) => (agent.status ? `${agent.name} (${agent.status})` : agent.name)).join(', ')}`}
            >
              {card.assignees.map((agent) => (
                <PrincipalChip key={agent.id} name={agent.name} kind={agent.kind} status={agent.status} />
              ))}
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-muster-border/50 text-[10px] font-sans muster-text-muted gap-1">
            <span>Updated {new Date(card.updated_at).toLocaleDateString()}</span>
            <select
              value={column.id}
              onClick={(e) => e.stopPropagation()}
              onChange={async (e) => {
                e.stopPropagation();
                const targetColId = e.target.value;
                if (targetColId && targetColId !== column.id) {
                  await onMoveCard(card.id, targetColId);
                }
              }}
              className="muster-card-move bg-transparent muster-text-muted hover:muster-text-primary text-[10px] cursor-pointer font-sans rounded px-1 py-0.5 border border-transparent hover:border-muster-border"
              title="Quick move to lane"
              aria-label={`Move ${card.title} to another lane`}
            >
              {allColumns.map((col) => (
                <option key={col.id} value={col.id} className="bg-muster-surface muster-text-primary font-sans">
                  → {col.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </Draggable>
  );
};
