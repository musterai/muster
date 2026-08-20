import { describe, expect, it } from 'vitest';
import { buildAppPath, parseAppLocation } from '../src/web/navigation.js';
import { cardWebPath, cardWebUrl } from '../src/shared/card-url.js';
import { buildDisplayColumns, cardMatchesDisplayColumn, resolveCardDrop, resolveTargetColumnId } from '../src/web/kanban-view.js';
import type { Board, Card, Column } from '../src/web/types.js';

const board = (id: string): Board => ({ id, project_id: 'project', name: id, slug: id, created_at: '', updated_at: '' });
const column = (id: string, boardId: string, name: string, workflowRole: Column['workflow_role']): Column => ({
  id, board_id: boardId, name, position: id, wip_limit: null,
  workflow_role: workflowRole, is_terminal: workflowRole === 'terminal' ? 1 : 0,
});
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

  it('builds and parses canonical card deep links', () => {
    expect(cardWebPath('MUS-84')).toBe('/cards/MUS-84');
    expect(cardWebUrl('https://muster.example.test/', 'MUS-84')).toBe('https://muster.example.test/cards/MUS-84');
    expect(parseAppLocation('/cards/MUS-84')).toMatchObject({
      projectSlug: null,
      tab: 'board',
      cardReference: 'MUS-84',
    });
  });

  it('deduplicates aggregate lanes and resolves moves to the card-owning board', () => {
    const columns = [
      column('a-todo', 'a', 'To Do', 'ready'),
      column('b-todo', 'b', 'À faire', 'ready'),
      column('b-done', 'b', 'Terminé', 'terminal'),
    ];
    const aggregate = buildDisplayColumns(columns, 'all', board('all'));
    expect(aggregate.displayColumns.map((item) => item.workflow_role)).toEqual(['ready', 'terminal']);
    expect(resolveTargetColumnId('all-col-role-terminal', 'card-b', aggregate.displayColumns, columns, [card('card-b', 'b', 'b-todo')])).toBe('b-done');
  });

  it('resolves an aggregate swimlane drop to a concrete board lane and rank', () => {
    const columns = [
      column('a-todo', 'a', 'To Do', 'ready'),
      column('b-todo', 'b', 'À faire', 'ready'),
      column('b-done', 'b', 'Terminé', 'terminal'),
    ];
    const moving = { ...card('card-b', 'b', 'b-todo'), position: 'a' };
    const existing = { ...card('done-b', 'b', 'b-done'), position: 'z' };
    const aggregate = buildDisplayColumns(columns, 'all', board('all'));
    const resolution = resolveCardDrop({
      draggableId: moving.id,
      sourceDroppableId: 'all-col-role-ready:::unparented',
      sourceIndex: 0,
      destinationDroppableId: 'all-col-role-terminal:::unparented',
      destinationIndex: 1,
      cards: [moving, existing],
      columns,
      displayColumns: aggregate.displayColumns,
      columnRoleMap: aggregate.columnRoleMap,
    });

    expect(resolution.targetColumnId).toBe('b-done');
    expect(resolution.position > existing.position).toBe(true);
  });

  it('never merges or resolves unclassified aggregate lanes by matching names', () => {
    const columns = [
      column('a-legacy', 'a', 'Doing', null),
      column('b-legacy', 'b', 'Doing', null),
    ];
    const aggregate = buildDisplayColumns(columns, 'all', board('all'));
    expect(aggregate.displayColumns.map((item) => item.id)).toEqual([
      'all-col-unclassified-a-legacy',
      'all-col-unclassified-b-legacy',
    ]);
    expect(cardMatchesDisplayColumn(
      card('card-b', 'b', 'b-legacy'),
      aggregate.displayColumns[0],
      aggregate.columnRoleMap,
    )).toBe(false);
    expect(resolveTargetColumnId(
      'all-col-unclassified-a-legacy',
      'card-b',
      aggregate.displayColumns,
      columns,
      [card('card-b', 'b', 'b-legacy')],
    )).toBe('all-col-unclassified-a-legacy');
  });
});
