import type { Board, Card, Column, ColumnWorkflowRole } from './types.js';
import { computeReorderedPosition } from './kanban.js';

export interface DisplayColumnModel {
  displayColumns: Column[];
  columnMap: Record<string, string>;
  columnRoleMap: Record<string, ColumnWorkflowRole | null | undefined>;
}

/** Build the real or aggregate-board column model without React state. */
export function buildDisplayColumns(
  columns: Column[],
  selectedBoardId: string | null,
  board: Board | null,
): DisplayColumnModel {
  const columnMap = Object.fromEntries(columns.map((column) => [column.id, column.name]));
  const columnRoleMap = Object.fromEntries(columns.map((column) => [column.id, column.workflow_role]));
  if (selectedBoardId !== 'all' && board?.id !== 'all') return { displayColumns: columns, columnMap, columnRoleMap };

  const uniqueMap = new Map<string, Column>();
  for (const column of columns) {
    const nameKey = column.name.trim().toLowerCase();
    const roleKey = column.workflow_role === undefined ? null : (column.workflow_role ?? 'unclassified');
    const displayKey = roleKey === null ? nameKey : `${nameKey}::${roleKey}`;
    if (!uniqueMap.has(displayKey)) {
      uniqueMap.set(displayKey, {
        ...column,
        id: `all-col-${displayKey.replace(/\s+/g, '-')}`,
        board_id: 'all',
      });
    }
  }
  return { displayColumns: [...uniqueMap.values()], columnMap, columnRoleMap };
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

  const targetName = targetColumn.name.trim().toLowerCase();
  const targetRole = targetColumn.workflow_role;
  const roleMatches = targetRole !== undefined
    ? columns.filter((column) => column.workflow_role === targetRole)
    : [];
  return roleMatches.find((column) => column.board_id === targetCard.board_id)?.id
    ?? roleMatches[0]?.id
    ?? columns.find((column) =>
      column.board_id === targetCard.board_id && column.name.trim().toLowerCase() === targetName
    )?.id
    ?? columns.find((column) => column.name.trim().toLowerCase() === targetName)?.id
    ?? targetColumnId;
}

export interface CardDropResolution {
  targetColumnId: string;
  position: string;
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
  columnMap,
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
  columnMap: Record<string, string>;
  columnRoleMap?: Record<string, ColumnWorkflowRole | null | undefined>;
}): CardDropResolution {
  const targetDisplayColumnId = destinationDroppableId.split(':::')[0];
  let targetCards = cards.filter((card) => {
    if (card.archived) return false;
    if (targetDisplayColumnId.startsWith('all-col-')) {
      const targetColumn = displayColumns.find((column) => column.id === targetDisplayColumnId);
      if (!targetColumn) return false;
      if (columnRoleMap && targetColumn.workflow_role !== undefined) {
        return (columnRoleMap[card.column_id] ?? null) === targetColumn.workflow_role;
      }
      return (columnMap[card.column_id] || '').trim().toLowerCase()
        === targetColumn.name.trim().toLowerCase();
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
