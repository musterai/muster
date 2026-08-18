// File: src/db/sqlite-adapter.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseAdapter, ExecutionResult } from './adapter.js';

type SQLiteTransactionScope = {
  root: SQLiteAdapter;
  callbacks: Array<() => void | Promise<void>>;
  active: boolean;
};

/** Adapter bound to the one SQLite connection and one owning transaction. */
class SQLiteTransactionAdapter implements DatabaseAdapter {
  readonly dialect = 'sqlite' as const;

  constructor(
    private readonly root: SQLiteAdapter,
    private readonly scope: SQLiteTransactionScope,
  ) {}

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.assertActive();
    return this.root.queryInTransaction<T>(sql, params);
  }

  execute(sql: string, params: unknown[] = []): Promise<ExecutionResult> {
    this.assertActive();
    return this.root.executeInTransaction(sql, params);
  }

  /** Nested services join this transaction instead of queueing behind it. */
  transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    this.assertActive();
    return fn(this);
  }

  afterCommit(callback: () => void | Promise<void>): void {
    this.assertActive();
    this.scope.callbacks.push(callback);
  }

  migrate(sql: string): Promise<void> {
    this.assertActive();
    return this.root.migrateInTransaction(sql);
  }

  async close(): Promise<void> {
    // The root owns the connection and closes it after queued work drains.
  }

  private assertActive(): void {
    if (!this.scope.active) throw new Error('Transaction-scoped adapter is no longer active');
  }
}

export class SQLiteAdapter implements DatabaseAdapter {
  readonly dialect = 'sqlite' as const;
  private readonly db: Database.Database;
  // All root operations and transactions share one FIFO. A transaction-scoped
  // adapter bypasses this queue, while unrelated root calls wait for the owner
  // to commit instead of being silently absorbed into its rollback boundary.
  private txQueue: Promise<unknown> = Promise.resolve();
  private afterCommitQueue: Promise<unknown> = Promise.resolve();
  private readonly transactionContext = new AsyncLocalStorage<SQLiteTransactionScope>();
  private readonly scopedCall = new AsyncLocalStorage<boolean>();

  constructor(filepath: string) {
    if (filepath !== ':memory:') {
      const dir = path.dirname(filepath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(filepath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Keep SQLite's native lock wait short.  A long synchronous busy_timeout
    // would block the Node event loop and prevent another in-process starter
    // from reaching COMMIT.  transaction() below retries asynchronously.
    this.db.pragma('busy_timeout = 50');
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.transactionContext.getStore()?.root === this && !this.scopedCall.getStore()) {
      this.assertNotRootCallInsideTransaction();
    }
    if (this.transactionContext.getStore()?.root === this) return this.queryRaw<T>(sql, params);
    return this.enqueue(() => this.queryRaw<T>(sql, params));
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecutionResult> {
    if (this.transactionContext.getStore()?.root === this && !this.scopedCall.getStore()) {
      this.assertNotRootCallInsideTransaction();
    }
    if (this.transactionContext.getStore()?.root === this) return this.executeRaw(sql, params);
    return this.enqueue(() => this.executeRaw(sql, params));
  }

  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    this.assertNotRootCallInsideTransaction();
    const run = async (): Promise<{ result: T; callbacks: Array<() => void | Promise<void>> }> => {
      await this.beginImmediate();
      const scope: SQLiteTransactionScope = { root: this, callbacks: [], active: true };
      try {
        const result = await this.transactionContext.run(scope, () => fn(new SQLiteTransactionAdapter(this, scope)));
        this.db.exec('COMMIT');
        scope.active = false;
        return { result, callbacks: scope.callbacks };
      } catch (error) {
        scope.active = false;
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Ignore rollback failure if already rolled back
        }
        throw error;
      }
    };

    // Advance the write FIFO as soon as COMMIT completes. Callbacks run in a
    // separate queue so a callback that performs a root query cannot wait on
    // the transaction whose promise is waiting for that callback.
    const scheduled = this.enqueue(run);
    const completed = scheduled.then(async ({ result, callbacks }) => {
      const callbacksRun = this.afterCommitQueue.then(async () => {
        for (const callback of callbacks) {
          try { await callback(); } catch (error) { console.error('Error in after-commit callback:', error); }
        }
      });
      this.afterCommitQueue = callbacksRun.catch(() => undefined);
      await callbacksRun;
      return result;
    });
    return completed;
  }

  afterCommit(callback: () => void | Promise<void>): void | Promise<void> {
    this.assertNotRootCallInsideTransaction();
    return callback();
  }

  queryInTransaction<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.scopedCall.run(true, () => this.query<T>(sql, params));
  }

  executeInTransaction(sql: string, params: unknown[] = []): Promise<ExecutionResult> {
    return this.scopedCall.run(true, () => this.execute(sql, params));
  }

  migrateInTransaction(sql: string): Promise<void> {
    this.db.exec(sql);
    return Promise.resolve();
  }

  private async beginImmediate(): Promise<void> {
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED') throw error;
        if (Date.now() >= deadline) throw error;
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
    }
  }

  async migrate(sql: string): Promise<void> {
    this.assertNotRootCallInsideTransaction();
    await this.enqueue(() => this.db.exec(sql));
  }

  async close(): Promise<void> {
    await this.txQueue;
    await this.afterCommitQueue;
    this.db.close();
  }

  private queryRaw<T>(sql: string, params: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  private executeRaw(sql: string, params: unknown[]): ExecutionResult {
    const stmt = this.db.prepare(sql);
    const info = stmt.run(...params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const scheduled = this.txQueue.then(work, work);
    this.txQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  private assertNotRootCallInsideTransaction(): void {
    if (this.transactionContext.getStore()?.root === this) {
      throw new Error('SQLite root adapter cannot be used inside a transaction; use the scoped adapter');
    }
  }
}
