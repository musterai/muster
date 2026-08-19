import type { Board, Card, Column, ColumnWorkflowRole } from './types.js';
import { computeReorderedPosition } from './kanban.js';

export interface DisplayColumnModel {
  displayColumns: Column[];
  columnRoleMap: Record<string, ColumnWorkflowRole | null | undefined>;
}

/** Build the real or aggregate-board column model without React state. */
export function buildDisplayColumns(
  columns: Column[],
  selectedBoardId: string | null,
  board: Board | null,
): DisplayColumnModel {
  const columnRoleMap = Object.fromEntries(columns.map((column) => [column.id, column.workflow_role]));
  if (selectedBoardId !== 'all' && board?.id !== 'all') return { displayColumns: columns, columnRoleMap };

  const uniqueMap = new Map<string, Column>();
  for (const column of columns) {
    // Aggregate configured lanes by their persisted semantics, never by
    // presentation text. An unclassified legacy lane remains isolated by its
    // immutable ID until an operator assigns a role.
    const displayKey = column.workflow_role
      ? `role-${column.workflow_role}`
      : `unclassified-${column.id}`;
    if (!uniqueMap.has(displayKey)) {
      uniqueMap.set(displayKey, {
        ...column,
        id: `all-col-${displayKey.replace(/\s+/g, '-')}`,
        board_id: 'all',
      });
    }
  }
  return { displayColumns: [...uniqueMap.values()], columnRoleMap };
}

/** Resolve an aggregate-board lane back to the card's concrete board. */
export function resolveTargetColumnId(
  targetColumnId: string,
  cardId: string,
  displayColumns: Column[],
  columns: Column[],
  cards: Card[],
  _columnRoleMap?: Record<string, ColumnWorkflowRole | null | undefined>,
): string {
  if (!targetColumnId.startsWith('all-col-')) return targetColumnId;
  const targetColumn = displayColumns.find((column) => column.id === targetColumnId);
  const targetCard = cards.find((card) => card.id === cardId);
  if (!targetColumn || !targetCard) return targetColumnId;

  const targetRole = targetColumn.workflow_role;
  if (targetRole) {
    return columns
      .filter((column) => column.board_id === targetCard.board_id && column.workflow_role === targetRole)
      .sort((left, right) => left.position.localeCompare(right.position) || left.id.localeCompare(right.id))[0]?.id
      ?? targetColumnId;
  }

  const unclassifiedPrefix = 'all-col-unclassified-';
  const sourceColumnId = targetColumnId.startsWith(unclassifiedPrefix)
    ? targetColumnId.slice(unclassifiedPrefix.length)
    : null;
  return columns.find((column) =>
    column.id === sourceColumnId && column.board_id === targetCard.board_id && !column.workflow_role
  )?.id ?? targetColumnId;
}

export interface CardDropResolution {
  targetColumnId: string;
  position: string;
}

export function cardMatchesDisplayColumn(
  card: Card,
  displayColumn: Column,
  columnRoleMap: Record<string, ColumnWorkflowRole | null | undefined>,
): boolean {
  if (!displayColumn.id.startsWith('all-col-')) return card.column_id === displayColumn.id;
  if (displayColumn.workflow_role) {
    return (columnRoleMap[card.column_id] ?? null) === displayColumn.workflow_role;
  }
  const unclassifiedPrefix = 'all-col-unclassified-';
  return displayColumn.id.startsWith(unclassifiedPrefix)
    && card.column_id === displayColumn.id.slice(unclassifiedPrefix.length);
}

/** Resolve a rendered card drop into the concrete lane and LexoRank hint. */
export function resolveCardDrop({
  draggableId,
  sourceDroppableId,
  sourceIndex,
  destinationDroppableId,
  destinationIndex,
  cards,
  columns,
  displayColumns,
  columnRoleMap,
}: {
  draggableId: string;
  sourceDroppableId: string;
  sourceIndex: number;
  destinationDroppableId: string;
  destinationIndex: number;
  cards: Card[];
  columns: Column[];
  displayColumns: Column[];
  columnRoleMap?: Record<string, ColumnWorkflowRole | null | undefined>;
}): CardDropResolution {
  const targetDisplayColumnId = destinationDroppableId.split(':::')[0];
  let targetCards = cards.filter((card) => {
    if (card.archived) return false;
    if (targetDisplayColumnId.startsWith('all-col-')) {
      const targetColumn = displayColumns.find((column) => column.id === targetDisplayColumnId);
      if (!targetColumn) return false;
      return cardMatchesDisplayColumn(card, targetColumn, columnRoleMap ?? {});
    }
    return card.column_id === targetDisplayColumnId;
  });

  const [, targetEpicId] = destinationDroppableId.split(':::');
  if (targetEpicId && targetEpicId !== 'unparented') {
    targetCards = targetCards.filter((card) => card.parent_epic_id === targetEpicId || card.id === targetEpicId);
  } else if (targetEpicId === 'unparented') {
    targetCards = targetCards.filter((card) => !card.is_epic && !card.parent_epic_id);
  }

  return {
    targetColumnId: resolveTargetColumnId(
      targetDisplayColumnId,
      draggableId,
      displayColumns,
      columns,
      cards,
      columnRoleMap,
    ),
    position: computeReorderedPosition(
      targetCards,
      sourceDroppableId === destinationDroppableId ? sourceIndex : targetCards.length,
      destinationIndex,
    ),
  };
}
