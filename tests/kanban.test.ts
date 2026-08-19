import { describe, expect, it } from 'vitest';
import {
  DONE_LANE_PAGE_SIZE,
  computeReorderedPosition,
  getLaneCards,
  isTerminalLane,
  sortCardsByUpdatedAt,
} from '../src/web/kanban.js';
import { Card } from '../src/web/types.js';

const makeCard = (
  id: string,
  updatedAt: string,
  columnId = 'column-1'
): Card => ({
  id,
  column_id: columnId,
  title: id,
  description: null,
  position: id,
  priority: 'medium',
  due_date: null,
  created_at: updatedAt,
  updated_at: updatedAt,
  archived: 0,
});

describe('kanban card arrangement', () => {
  const cards = [
    makeCard('middle', '2026-02-02T12:00:00.000Z'),
    makeCard('oldest', '2026-01-01T12:00:00.000Z'),
    makeCard('newest', '2026-03-03T12:00:00.000Z'),
  ];

  it('sorts cards by their latest update in either direction', () => {
    expect(sortCardsByUpdatedAt(cards, 'newest').map((card) => card.id)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
    expect(sortCardsByUpdatedAt(cards, 'oldest').map((card) => card.id)).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
  });

  it('uses the persisted terminal role rather than presentation names', () => {
    expect(isTerminalLane('terminal')).toBe(true);
    expect(isTerminalLane('active')).toBe(false);
    expect(isTerminalLane(null)).toBe(false);
  });

  it('limits Done while leaving other lanes and archived cards out of the count', () => {
    const doneCards = Array.from(
      { length: DONE_LANE_PAGE_SIZE + 3 },
      (_, index) =>
        makeCard(
          `card-${index.toString().padStart(2, '0')}`,
          `2026-01-${(index + 1).toString().padStart(2, '0')}T12:00:00.000Z`
        )
    );
    const archived = { ...makeCard('archived', '2026-02-01T12:00:00.000Z'), archived: 1 };
    const anotherLane = makeCard('elsewhere', '2026-02-02T12:00:00.000Z', 'column-2');

    const done = getLaneCards(
      [...doneCards, archived, anotherLane],
      'column-1',
      'newest',
      DONE_LANE_PAGE_SIZE,
      'terminal',
    );
    const inProgress = getLaneCards(
      doneCards,
      'column-1',
      'newest',
      DONE_LANE_PAGE_SIZE,
      'active',
    );

    expect(done.all).toHaveLength(DONE_LANE_PAGE_SIZE + 3);
    expect(done.visible).toHaveLength(DONE_LANE_PAGE_SIZE);
    expect(done.hiddenCount).toBe(3);
    expect(inProgress.visible).toHaveLength(DONE_LANE_PAGE_SIZE + 3);
    expect(inProgress.hiddenCount).toBe(0);
  });

  it('can reveal additional Done cards in bounded batches', () => {
    const cards = Array.from(
      { length: DONE_LANE_PAGE_SIZE * 2 + 1 },
      (_, index) =>
        makeCard(
          `card-${index}`,
          new Date(Date.UTC(2026, 0, index + 1)).toISOString()
        )
    );

    const result = getLaneCards(
      cards,
      'column-1',
      'oldest',
      DONE_LANE_PAGE_SIZE * 2,
      'terminal',
    );

    expect(result.visible).toHaveLength(DONE_LANE_PAGE_SIZE * 2);
    expect(result.hiddenCount).toBe(1);
    expect(result.visible[0].id).toBe('card-0');
  });
});

describe('computeReorderedPosition (column drag-and-drop reordering)', () => {
  const columns = [
    { position: 'a' },
    { position: 'm' },
    { position: 'z' },
  ];

  it('places a column moved to the front before the new first neighbor', () => {
    const position = computeReorderedPosition(columns, 2, 0);
    expect(position < columns[0].position).toBe(true);
  });

  it('places a column moved to the end after the new last neighbor', () => {
    const position = computeReorderedPosition(columns, 0, 2);
    expect(position > columns[2].position).toBe(true);
  });

  it('places a column moved into the middle between its new neighbors', () => {
    const position = computeReorderedPosition(columns, 0, 1);
    expect(position > columns[1].position).toBe(true);
    expect(position < columns[2].position).toBe(true);
  });

  it('returns a server repair hint when adjacent legacy ranks exhaust client space', () => {
    expect(computeReorderedPosition([{ position: 'a' }, { position: 'aa' }, { position: 'z' }], 2, 1)).toBe('a');
  });
});
