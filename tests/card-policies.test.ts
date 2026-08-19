import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { CardLanePolicy } from '../src/services/card-lane.policy.js';
import { ValidationError } from '../src/shared/errors.js';
import type { Card } from '../src/shared/types.js';

const unusedDb = { dialect: 'sqlite' } as DatabaseAdapter;

function card(id: string, position: string): Card {
  return {
    id,
    key: `MUS-${id}`,
    column_id: 'todo',
    title: id,
    description: null,
    position,
    priority: 'medium',
    due_date: null,
    created_at: '',
    updated_at: '',
    archived: 0,
    claimed_by: null,
    claimed_at: null,
    claim_expires_at: null,
    is_epic: 0,
  };
}

describe('CardLanePolicy', () => {
  const policy = new CardLanePolicy(unusedDb);

  it('rejects an empty move before any transport or database work', () => {
    expect(() => policy.assertMoveIntent({})).toThrowError(ValidationError);
    expect(() => policy.assertMoveIntent({})).toThrow(/target_column_id or position is required/);
  });

  it('rejects malformed lane and rank selectors consistently', () => {
    expect(() => policy.assertMoveIntent({ target_column_id: '  ' })).toThrow(/non-empty string/);
    expect(() => policy.assertMoveIntent({ position: 'A1' })).toThrow(/lowercase letters/);
  });

  it('orders a requested rank without mutating the caller-owned lane array', () => {
    const lane = [card('1', 'g'), card('2', 't')];
    const inserted = card('3', 'm');
    const ordered = policy.orderWithPosition(lane, inserted, 'm');
    expect(ordered.map((item) => item.id)).toEqual(['1', '3', '2']);
    expect(lane.map((item) => item.id)).toEqual(['1', '2']);
  });
});
