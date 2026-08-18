// File: src/db/adapter.ts

export interface ExecutionResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

/**
 * Portable SQL Database Adapter interface.
 * Returns Promises so that remote or network-backed drivers (PostgreSQL, MySQL, Cloud SQLite)
 * can be plugged in without changing service signatures.
 */
export interface DatabaseAdapter {
  /**
   * Which real database is behind this adapter. Exists for the small number
   * of call sites where portable SQL genuinely can't express a dialect's
   * concurrency primitive — e.g. row locking (`SELECT ... FOR UPDATE`) in
   * CardService.claim(), which SQLite doesn't support as syntax at all and
   * doesn't need, since better-sqlite3's single connection plus
   * BEGIN IMMEDIATE already serializes every transaction. Postgres's
   * connection pool has no such accidental serialization, so it needs the
   * explicit lock. Everything else in this codebase is dialect-portable SQL
   * that the adapter itself reconciles (placeholders, INSERT OR IGNORE) —
   * reach for this field only when that's genuinely not possible.
   */
  readonly dialect: 'sqlite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<ExecutionResult>;
  transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>;
  /** Register delivery work that must run only after the current transaction commits. */
  afterCommit(callback: () => void | Promise<void>): void;
  migrate(sql: string): Promise<void>;
  close(): Promise<void>;
}
