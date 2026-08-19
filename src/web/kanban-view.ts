import type { Board, Card, Column } from './types.js';

export interface DisplayColumnModel {
  displayColumns: Column[];
  columnMap: Record<string, string>;
}

/** Build the real or aggregate-board column model without React state. */
export function buildDisplayColumns(
  columns: Column[],
  selectedBoardId: string | null,
  board: Board | null,
): DisplayColumnModel {
  const columnMap = Object.fromEntries(columns.map((column) => [column.id, column.name]));
  if (selectedBoardId !== 'all' && board?.id !== 'all') return { displayColumns: columns, columnMap };

  const uniqueMap = new Map<string, Column>();
  for (const column of columns) {
    const nameKey = column.name.trim().toLowerCase();
    if (!uniqueMap.has(nameKey)) {
      uniqueMap.set(nameKey, {
        ...column,
        id: `all-col-${nameKey.replace(/\s+/g, '-')}`,
        board_id: 'all',
      });
    }
  }
  return { displayColumns: [...uniqueMap.values()], columnMap };
}

/** Resolve an aggregate-board lane back to the card's concrete board. */
export function resolveTargetColumnId(
  targetColumnId: string,
  cardId: string,
  displayColumns: Column[],
  columns: Column[],
  cards: Card[],
): string {
  if (!targetColumnId.startsWith('all-col-')) return targetColumnId;
  const targetColumn = displayColumns.find((column) => column.id === targetColumnId);
  const targetCard = cards.find((card) => card.id === cardId);
  if (!targetColumn || !targetCard) return targetColumnId;

  const targetName = targetColumn.name.trim().toLowerCase();
  return columns.find((column) =>
    column.board_id === targetCard.board_id && column.name.trim().toLowerCase() === targetName
  )?.id ?? columns.find((column) => column.name.trim().toLowerCase() === targetName)?.id ?? targetColumnId;
}
