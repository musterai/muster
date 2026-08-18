import { Card } from './types.js';
import { RankError, rankBefore, rankBetween } from '../shared/lexorank.js';

export type CardDateSortOrder = 'newest' | 'oldest';

export const DONE_LANE_PAGE_SIZE = 25;

export const isDoneLane = (columnName: string): boolean =>
  columnName.trim().toLocaleLowerCase() === 'done';

export const sortCardsByUpdatedAt = (
  cards: Card[],
  order: CardDateSortOrder
): Card[] => {
  const direction = order === 'newest' ? -1 : 1;

  return [...cards].sort((left, right) => {
    const dateDifference =
      (Date.parse(left.updated_at) - Date.parse(right.updated_at)) * direction;

    if (dateDifference !== 0) return dateDifference;

    const positionDifference = left.position.localeCompare(right.position);
    if (positionDifference !== 0) return positionDifference;

    return left.id.localeCompare(right.id);
  });
};

export const getLaneCards = (
  cards: Card[],
  columnId: string,
  columnName: string,
  order: CardDateSortOrder,
  doneVisibleLimit = DONE_LANE_PAGE_SIZE,
  columnMap?: Record<string, string>
): { all: Card[]; visible: Card[]; hiddenCount: number } => {
  const isAllView = columnId.startsWith('all-col-');
  const targetName = columnName.trim().toLowerCase();
  const all = sortCardsByUpdatedAt(
    cards.filter((card) => {
      if (card.archived) return false;
      if (isAllView && columnMap) {
        const cardColName = (columnMap[card.column_id] || '').trim().toLowerCase();
        return cardColName === targetName;
      }
      return card.column_id === columnId;
    }),
    order
  );
  const visible = isDoneLane(columnName)
    ? all.slice(0, doneVisibleLimit)
    : all;

  return {
    all,
    visible,
    hiddenCount: all.length - visible.length,
  };
};

// Given the current ordering and a drag from sourceIndex to destinationIndex,
// returns the lexorank position that places the moved item between its new
// neighbors (matching the ordering scheme columns and cards already use).
export const computeReorderedPosition = (
  items: { position: string }[],
  sourceIndex: number,
  destinationIndex: number
): string => {
  const reordered = [...items];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(destinationIndex, 0, moved);

  const before = reordered[destinationIndex - 1];
  const after = reordered[destinationIndex + 1];
  try {
    return rankBetween(before?.position ?? null, after?.position ?? null);
  } catch (error) {
    // Adjacent legacy ranks such as `a`/`aa` have no representable
    // fractional rank. Preserve the insertion intent as a server-side hint;
    // CardService will rebalance the affected lane transactionally. This
    // keeps drag/drop usable while the canonical rank is repaired server-side.
    if (!(error instanceof RankError) || error.code !== 'RANK_SPACE_EXHAUSTED') throw error;
    if (before) return before.position;
    if (after) {
      try {
        return rankBefore(after.position);
      } catch (fallbackError) {
        if (!(fallbackError instanceof RankError) || fallbackError.code !== 'RANK_SPACE_EXHAUSTED') throw fallbackError;
        return after.position;
      }
    }
    return 'm';
  }
};
