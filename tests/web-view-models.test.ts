import { describe, expect, it } from 'vitest';
import { buildAppPath, parseAppLocation } from '../src/web/navigation.js';
import { buildDisplayColumns, resolveCardDrop, resolveTargetColumnId } from '../src/web/kanban-view.js';
import type { Board, Card, Column } from '../src/web/types.js';

const board = (id: string): Board => ({ id, project_id: 'project', name: id, slug: id, created_at: '', updated_at: '' });
const column = (id: string, boardId: string, name: string): Column => ({ id, board_id: boardId, name, position: id, wip_limit: null, is_terminal: 0 });
const card = (id: string, boardId: string, columnId: string): Card => ({
  id, key: id, board_id: boardId, column_id: columnId, title: id, description: null,
  position: 'm', priority: 'medium', due_date: null, created_at: '', updated_at: '',
  archived: 0, claimed_by: null, claimed_at: null, claim_expires_at: null, is_epic: 0,
});

describe('browser view models', () => {
  it('parses and builds board/document/knowledge routes without browser state', () => {
    expect(parseAppLocation('/projects/muster/board/development')).toMatchObject({ projectSlug: 'muster', tab: 'board', boardSlug: 'development' });
    expect(parseAppLocation('/projects/muster/docs/doc-1').docId).toBe('doc-1');
    expect(parseAppLocation('/projects/muster/kb/entity-1').entityId).toBe('entity-1');
    expect(buildAppPath('muster', 'board', { boardSlug: 'development' })).toBe('/projects/muster/board/development');
  });

  it('deduplicates aggregate lanes and resolves moves to the card-owning board', () => {
    const columns = [column('a-todo', 'a', 'To Do'), column('b-todo', 'b', 'To Do'), column('b-done', 'b', 'Done')];
    const aggregate = buildDisplayColumns(columns, 'all', board('all'));
    expect(aggregate.displayColumns.map((item) => item.name)).toEqual(['To Do', 'Done']);
    expect(resolveTargetColumnId('all-col-done', 'card-b', aggregate.displayColumns, columns, [card('card-b', 'b', 'b-todo')])).toBe('b-done');
  });

  it('resolves an aggregate swimlane drop to a concrete board lane and rank', () => {
    const columns = [column('a-todo', 'a', 'To Do'), column('b-todo', 'b', 'To Do'), column('b-done', 'b', 'Done')];
    const moving = { ...card('card-b', 'b', 'b-todo'), position: 'a' };
    const existing = { ...card('done-b', 'b', 'b-done'), position: 'z' };
    const aggregate = buildDisplayColumns(columns, 'all', board('all'));
    const resolution = resolveCardDrop({
      draggableId: moving.id,
      sourceDroppableId: 'all-col-to-do:::unparented',
      sourceIndex: 0,
      destinationDroppableId: 'all-col-done:::unparented',
      destinationIndex: 1,
      cards: [moving, existing],
      columns,
      displayColumns: aggregate.displayColumns,
      columnMap: aggregate.columnMap,
    });

    expect(resolution.targetColumnId).toBe('b-done');
    expect(resolution.position > existing.position).toBe(true);
  });
});
