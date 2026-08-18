// File: src/db/sqlite-adapter.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseAdapter, ExecutionResult } from './adapter.js';

export class SQLiteAdapter implements DatabaseAdapter {
  readonly dialect = 'sqlite' as const;
  private readonly db: Database.Database;
  // better-sqlite3 is one synchronous connection: a second BEGIN IMMEDIATE while
  // a transaction is still open throws immediately instead of waiting. Chain
  // transaction() calls through this queue so concurrent callers serialize
  // instead of crashing on a nested transaction.
  private txQueue: Promise<unknown> = Promise.resolve();
  private activeAfterCommit: Array<() => void | Promise<void>> | null = null;

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
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecutionResult> {
    const stmt = this.db.prepare(sql);
    const info = stmt.run(...params);
    return {
      changes: info.changes,
      lastInsertRowid: info.lastInsertRowid,
    };
  }

  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.beginImmediate();
      const callbacks: Array<() => void | Promise<void>> = [];
      const previousCallbacks = this.activeAfterCommit;
      this.activeAfterCommit = callbacks;
      try {
        const result = await fn(this);
        this.db.exec('COMMIT');
        this.activeAfterCommit = previousCallbacks;
        for (const callback of callbacks) {
          try {
            await callback();
          } catch (error) {
            console.error('Error in after-commit callback:', error);
          }
        }
        return result;
      } catch (error) {
        this.activeAfterCommit = previousCallbacks;
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Ignore rollback failure if already rolled back
        }
        throw error;
      }
    };

    const scheduled = this.txQueue.then(run, run);
    this.txQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  afterCommit(callback: () => void | Promise<void>): void {
    if (this.activeAfterCommit) {
      this.activeAfterCommit.push(callback);
      return;
    }
    void callback();
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
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
