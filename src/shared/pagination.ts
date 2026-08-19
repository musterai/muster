import { ValidationError } from './errors.js';
import { createHash } from 'node:crypto';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const MAX_CURSOR_LENGTH = 2048;

export interface PageOptions {
  cursor?: string;
  limit?: number;
}

export interface PageInfo {
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface Page<T> {
  items: T[];
  page: PageInfo;
}

interface CursorEnvelope {
  v: 1;
  scope: string;
  values: string[];
}

export function normalizePageLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_PAGE_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`, {
      field: 'limit',
      minimum: 1,
      maximum: MAX_PAGE_LIMIT,
    });
  }
  return resolved;
}

export function encodeCursor(scope: string, values: Array<string | number>): string {
  const envelope: CursorEnvelope = { v: 1, scope: scopeTag(scope), values: values.map(String) };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined, scope: string, valueCount: number): string[] | null {
  if (cursor === undefined) return null;
  if (cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw invalidCursor();
  }

  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    // Reject non-canonical encodings so alternative spellings cannot become
    // cache keys for the same cursor.
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) throw invalidCursor();
    const value = JSON.parse(decoded) as Partial<CursorEnvelope>;
    if (
      value.v !== 1
      || value.scope !== scopeTag(scope)
      || !Array.isArray(value.values)
      || value.values.length !== valueCount
      || value.values.some(item => typeof item !== 'string' || item.length > 512)
    ) {
      throw invalidCursor();
    }
    return value.values;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw invalidCursor();
  }
}

function scopeTag(scope: string): string {
  return createHash('sha256').update(`muster-pagination-v1\0${scope}`).digest('base64url');
}

export function toPage<T>(rows: T[], limit: number, cursorFor: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return {
    items,
    page: {
      limit,
      has_more: hasMore,
      next_cursor: hasMore && items.length > 0 ? cursorFor(items[items.length - 1]) : null,
    },
  };
}

function invalidCursor(): ValidationError {
  return new ValidationError('cursor is invalid, stale, or belongs to a different collection', {
    field: 'cursor',
    code: 'INVALID_CURSOR',
  });
}
