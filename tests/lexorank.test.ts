import { describe, it, expect } from 'vitest';
import {
  CANONICAL_RANK_WIDTH,
  generateRank,
  isValidRank,
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

  it('reports exhaustion instead of exceeding the declared maximum rank length', () => {
    const maxA = 'a'.repeat(256);
    const maxAdjacent = 'a' + 'z'.repeat(255);
    const maxZ = 'z'.repeat(256);
    expect(() => rankBetween(maxAdjacent, 'b')).toThrow(/No rank exists/);
    expect(() => rankAfter(maxZ)).toThrow(/No rank exists/);
    expect(() => rankBefore(maxA)).toThrow(/No rank exists/);
  });

  it('rejects malformed ranks and reversed neighbours', () => {
    expect(() => rankBetween('A', 'z')).toThrow(/lowercase/);
    expect(() => rankBetween('a!', 'z')).toThrow(/lowercase/);
    expect(() => rankBetween('z', 'a')).toThrow(/sort before/);
  });

  it('satisfies the strict-between property for arbitrary valid neighbours', () => {
    // Keep the generator deterministic so a failing seed is reproducible in
    // CI while still exercising arbitrary lengths, prefixes, and alphabet
    // boundaries rather than a hand-picked fixture set.
    let seed = 0x5eed1234;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const arbitraryRank = (): string => {
      const length = 1 + Math.floor(next() * 32);
      let rank = '';
      for (let index = 0; index < length; index++) {
        rank += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(next() * 26)];
      }
      return rank;
    };

    let checked = 0;
    let exhausted = 0;
    for (let iteration = 0; iteration < 25_000; iteration++) {
      let before = arbitraryRank();
      let after = arbitraryRank();
      if (before === after) continue;
      if (before > after) [before, after] = [after, before];

      try {
        const midpoint = rankBetween(before, after);
        expect(isValidRank(midpoint)).toBe(true);
        expect(before < midpoint && midpoint < after).toBe(true);
        checked += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(RankError);
        expect((error as RankError).code).toBe('RANK_SPACE_EXHAUSTED');
        exhausted += 1;
      }
    }

    expect(checked + exhausted).toBeGreaterThan(10_000);
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
