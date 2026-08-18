// File: src/shared/lexorank.ts

/** Ranks use ordinary lexicographic ordering over a transport-safe alphabet. */
export const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const END_CHAR = 'z';
export const CANONICAL_RANK_WIDTH = 12;
export const MAX_RANK_LENGTH = 256;

export type RankErrorCode = 'INVALID_RANK' | 'RANK_SPACE_EXHAUSTED';

export class RankError extends Error {
  constructor(public readonly code: RankErrorCode, message: string) {
    super(message);
    this.name = 'RankError';
  }
}

/** Legacy ranks may be variable length, but never contain punctuation or whitespace. */
export function isValidRank(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_RANK_LENGTH
    && /^[a-z]+$/.test(value);
}

/**
 * Validate an external insertion hint. `rankBefore('a')` historically
 * returns `0a`; that value is useful at the transport boundary, but must be
 * replaced with a canonical rank before it is persisted. Keeping this
 * predicate next to the persisted-rank validator makes card and column
 * position APIs agree on the same legacy compatibility contract.
 */
export function isValidRankHint(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_RANK_LENGTH
    && /^(?:[a-z]+|0[a-z]+)$/.test(value);
}

export function isCanonicalRank(value: unknown): value is string {
  return isValidRank(value) && value.length === CANONICAL_RANK_WIDTH;
}

function assertRank(value: string, name: string): void {
  if (!isValidRank(value)) {
    throw new RankError('INVALID_RANK', `${name} must contain only lowercase letters a-z`);
  }
}

export function generateRank(): string {
  return 'm';
}

function getMidChar(c1: string, c2: string): string {
  const i1 = ALPHABET.indexOf(c1);
  const i2 = ALPHABET.indexOf(c2);
  return ALPHABET[Math.floor((i1 + i2) / 2)];
}

/** Return a rank strictly between neighbours, or explicitly report exhausted space. */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null) assertRank(before, 'before');
  if (after !== null) assertRank(after, 'after');
  if (before !== null && after !== null && before >= after) {
    throw new RankError('INVALID_RANK', 'before must sort before after');
  }
  if (!before && !after) return generateRank();
  if (!before && after) {
    const candidate = rankBefore(after);
    // `rankBefore('a')` historically returns `0a`. Keep that transport hint
    // for the drag client; CardService canonicalizes it before persistence.
    if (candidate < after && /^[0-9a-z]+$/.test(candidate)) return candidate;
    throw new RankError('RANK_SPACE_EXHAUSTED', `No rank exists before ${after}`);
  }
  if (before && !after) return rankAfter(before);

  const str1 = before!;
  const str2 = after!;
  let prefix = '';
  let i = 0;
  while (i < str1.length && i < str2.length && str1[i] === str2[i]) {
    prefix += str1[i++];
  }

  // Any extension of the lower prefix is greater than it. There is no space
  // when the upper value immediately extends it with `a` (e.g. a and aa).
  if (i === str1.length) {
    const afterIndex = ALPHABET.indexOf(str2[i]);
    if (afterIndex <= 0) {
      throw new RankError('RANK_SPACE_EXHAUSTED', `No rank exists between ${str1} and ${str2}`);
    }
    return prefix + ALPHABET[Math.floor((afterIndex - 1) / 2)];
  }
  if (i === str2.length) throw new RankError('INVALID_RANK', 'before must sort before after');

  const beforeIndex = ALPHABET.indexOf(str1[i]);
  const afterIndex = ALPHABET.indexOf(str2[i]);
  if (afterIndex - beforeIndex > 1) {
    return prefix + getMidChar(str1[i], str2[i]);
  }

  // Adjacent characters still have room after the lower suffix while staying
  // below the higher character (a, b -> am; az, b -> azzm).
  return prefix + str1[i] + rankAfter(str1.slice(i + 1));
}

export function rankAfter(rank: string): string {
  // Empty lanes use the midpoint as their first rank.
  if (rank === '') return generateRank();
  assertRank(rank, 'rank');
  let newRank = '';
  for (let i = 0; i < rank.length; i++) {
    const char = rank[i];
    if (char === END_CHAR) {
      newRank += char;
    } else {
      const charIndex = ALPHABET.indexOf(char);
      newRank += ALPHABET[charIndex + 1];
      return newRank;
    }
  }
  return newRank + 'm';
}

/** Retain the historical prepend helper; CardService normalizes before persistence. */
export function rankBefore(rank: string): string {
  assertRank(rank, 'rank');
  for (let i = rank.length - 1; i >= 0; i--) {
    const charIndex = ALPHABET.indexOf(rank[i]);
    if (charIndex > 0) return rank.substring(0, i) + ALPHABET[charIndex - 1];
  }
  return '0' + rank;
}

function encodeRank(value: bigint, width: number): string {
  let result = '';
  let remaining = value;
  const base = BigInt(ALPHABET.length);
  for (let i = 0; i < width; i++) {
    result = ALPHABET[Number(remaining % base)] + result;
    remaining /= base;
  }
  return result;
}

/** Produce deterministic, evenly spaced canonical ranks for a lane. */
export function rebalanceRanks(count: number): string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RankError('INVALID_RANK', 'count must be a non-negative integer');
  }
  if (count === 0) return [];
  const base = BigInt(ALPHABET.length);
  const capacity = base ** BigInt(CANONICAL_RANK_WIDTH);
  if (BigInt(count + 1) >= capacity) {
    throw new RankError('RANK_SPACE_EXHAUSTED', 'lane is too large to assign canonical ranks');
  }
  const step = capacity / BigInt(count + 1);
  return Array.from({ length: count }, (_, index) => encodeRank(step * BigInt(index + 1), CANONICAL_RANK_WIDTH));
}
