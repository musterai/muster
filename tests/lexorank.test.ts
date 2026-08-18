import { describe, it, expect } from 'vitest';
import {
  CANONICAL_RANK_WIDTH,
  generateRank,
  isCanonicalRank,
  rankBetween,
  rankBefore,
  rankAfter,
  rebalanceRanks,
  RankError,
} from '../src/shared/lexorank.js';

describe('LexoRank Algorithm', () => {
  it('generateRank returns default midpoint rank', () => {
    expect(generateRank()).toBe('m');
  });

  it('rankBefore generates rank lexicographically smaller than input', () => {
    expect(rankBefore('m')).toBe('l');
    expect(rankBefore('b')).toBe('a');
    const beforeA = rankBefore('a');
    expect(beforeA < 'a').toBe(true);
    expect(beforeA).toBe('0a');
  });

  it('rankAfter generates rank lexicographically larger than input', () => {
    expect(rankAfter('m')).toBe('n');
    expect(rankAfter('z')).toBe('zm');
  });

  it('rankBetween generates rank between two values', () => {
    const mid = rankBetween('a', 'c');
    expect(mid > 'a').toBe(true);
    expect(mid < 'c').toBe(true);
    expect(mid).toBe('b');
  });
  it('reports exhausted adjacent prefix space instead of returning an out-of-range rank', () => {
    expect(() => rankBetween('a', 'aa')).toThrowError(RankError);
    expect(() => rankBetween('a', 'aa')).toThrow(/No rank exists/);
  });

  it('rejects malformed ranks and reversed neighbours', () => {
    expect(() => rankBetween('A', 'z')).toThrow(/lowercase/);
    expect(() => rankBetween('a!', 'z')).toThrow(/lowercase/);
    expect(() => rankBetween('z', 'a')).toThrow(/sort before/);
  });

  it('rebalanceRanks creates a deterministic, strictly ordered canonical lane', () => {
    const first = rebalanceRanks(5_000);
    const second = rebalanceRanks(5_000);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
    expect(first.every(rank => isCanonicalRank(rank) && rank.length === CANONICAL_RANK_WIDTH)).toBe(true);
    expect(first.every((rank, index) => index === 0 || first[index - 1] < rank)).toBe(true);
  });

  it('supports long midpoint insertion sequences with periodic rebalancing', () => {
    let ranks = ['a', 'z'];
    for (let i = 0; i < 1_000; i++) {
      if (i > 0 && i % 5 === 0) {
        ranks = rebalanceRanks(ranks.length);
        expect(ranks.every(isCanonicalRank)).toBe(true);
      }
      const midpoint = rankBetween(ranks[0], ranks[1]);
      expect(ranks[0] < midpoint && midpoint < ranks[1]).toBe(true);
      ranks = [ranks[0], midpoint, ranks[1]];
    }
  });
});
