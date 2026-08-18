import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CardItem } from '../src/web/components/kanban/CardItem.js';
import { Card, Column } from '../src/web/types.js';

vi.mock('@hello-pangea/dnd', () => ({
  Draggable: ({ children }: { children: (provided: unknown, snapshot: unknown) => React.ReactNode }) =>
    children(
      { innerRef: () => undefined, draggableProps: {}, dragHandleProps: {} },
      { isDragging: false }
    ),
}));

const column: Column = {
  id: 'column-1',
  board_id: 'board-1',
  name: 'To Do',
  position: 'a',
  wip_limit: null,
  is_terminal: 0,
};

const card: Card = {
  id: 'card-1',
  key: 'MUS-79',
  column_id: column.id,
  title: 'Clarify card metadata hierarchy',
  description: null,
  position: 'a',
  priority: 'medium',
  due_date: null,
  created_at: '2026-08-18T00:00:00.000Z',
  updated_at: '2026-08-18T00:00:00.000Z',
  archived: 0,
  is_epic: 0,
  board_id: 'board-1',
  board_name: 'Development',
  parent_epic_id: 'epic-1',
  parent_epic_key: 'MUS-54',
  parent_epic_title: 'Security and release reliability hardening',
};

function renderCard(overrides: { showBoardName?: boolean; showParentEpic?: boolean } = {}) {
  return renderToStaticMarkup(
    <CardItem
      card={card}
      column={column}
      allColumns={[column]}
      focusedCardId={null}
      copiedKeyCardId={null}
      index={0}
      showBoardName={overrides.showBoardName}
      showParentEpic={overrides.showParentEpic}
      onFocusCard={vi.fn()}
      onOpenCard={vi.fn()}
      onCopyKey={vi.fn()}
      onDeleteCard={vi.fn()}
      onMoveCard={vi.fn(async () => undefined)}
    />
  );
}

describe('Kanban card context metadata', () => {
  it('keeps the parent Epic subtle in regular board view and omits the board name', () => {
    const html = renderCard();

    expect(html).toContain('MUS-79');
    expect(html).toContain('Parent Epic: MUS-54');
    expect(html).toContain('Security and release reliability hardening');
    expect(html).not.toContain('Board: Development');
    expect(html).not.toContain('bg-brand-950/50');
  });

  it('shows only relevant context in All Boards and Epic swimlane variants', () => {
    const allBoardsHtml = renderCard({ showBoardName: true });
    expect(allBoardsHtml).toContain('Board: Development');
    expect(allBoardsHtml).toContain('Parent Epic: MUS-54');

    const epicSwimlaneHtml = renderCard({ showBoardName: true, showParentEpic: false });
    expect(epicSwimlaneHtml).toContain('Board: Development');
    expect(epicSwimlaneHtml).not.toContain('Parent Epic: MUS-54');
    expect(epicSwimlaneHtml).not.toContain('Security and release reliability hardening');
  });

  it('keeps key and card actions in the non-wrapping primary row', () => {
    const html = renderCard();

    expect(html).toContain('justify-between gap-2 mb-2');
    expect(html).toContain('flex items-center gap-1.5 shrink-0');
    expect(html).toContain('aria-label="Edit MUS-79"');
    expect(html).toContain('aria-label="Delete MUS-79"');
  });
});
