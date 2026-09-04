// File: src/db/postgres-adapter.ts
//
// PostgreSQL adapter (MUS-31) — a real connection pool with genuine
// concurrent transactions, for a team past the point where
// better-sqlite3's single synchronous connection is the capacity ceiling.
// Implements the same DatabaseAdapter interface SQLiteAdapter does; every
// service is written against that interface and portable SQL, so this file
// is dialect reconciliation, not new architecture — see the two small
// translation helpers below.

import pg from 'pg';
import { DatabaseAdapter, ExecutionResult } from './adapter.js';

type PostgresPoolLike = Pick<pg.Pool, 'connect' | 'query' | 'end'> & Partial<Pick<pg.Pool, 'on'>>;

/**
 * SQLite-style positional `?` placeholders → Postgres's `$1, $2, ...`.
 * Every service is written with `?`, so this runs on every query rather
 * than rewriting call sites across a dozen files. Skips `?` inside a
 * single-quoted string literal so a literal question mark in stored text
 * is never mistaken for a placeholder; `''` (an escaped quote) is handled
 * by toggling twice, which lands back in the same state, matching SQL's
 * own escaping rule.
 */
export function convertPlaceholders(sql: string): string {
  let out = '';
  let paramIndex = 0;
  let inString = false;
  for (const element of sql) {
    const ch = element;
    if (ch === "'") {
      inString = !inString;
      out += ch;
    } else if (ch === '?' && !inString) {
      paramIndex += 1;
      out += '$' + paramIndex;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * SQLite's `INSERT OR IGNORE` has no Postgres keyword — Postgres expresses
 * "ignore on conflict" as `ON CONFLICT DO NOTHING`, which (used bare, with
 * no explicit conflict target) matches SQLite's semantics closely enough
 * for the junction-table upserts this codebase uses it for: ignore on any
 * unique/PK violation, not just one named constraint.
 */
export function translateDialect(sql: string): string {
  if (!/INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql)) return sql;
  const rewritten = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO').trimEnd();
  return /ON\s+CONFLICT/i.test(rewritten) ? rewritten : `${rewritten} ON CONFLICT DO NOTHING`;
}

function prepare(sql: string): string {
  return convertPlaceholders(translateDialect(sql));
}

/** Shared by PostgresAdapter (pool-backed) and PostgresTransactionAdapter (single-client-backed) — everything but how the query actually gets issued is identical. */
abstract class BasePostgresAdapter implements DatabaseAdapter {
  readonly dialect = 'postgres' as const;

  protected abstract runQuery(sql: string, params: unknown[]): Promise<pg.QueryResult>;

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.runQuery(prepare(sql), params);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecutionResult> {
    const result = await this.runQuery(prepare(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  abstract transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>;
  abstract migrate(sql: string): Promise<void>;
  abstract close(): Promise<void>;
}

/** Bound to one already-checked-out client for the lifetime of an open transaction — every call inside must run on this same connection to see uncommitted writes and hold the same locks. */
class PostgresTransactionAdapter extends BasePostgresAdapter {
  private commitCallbacks: Array<() => void | Promise<void>> = [];

  constructor(private readonly client: pg.PoolClient) {
    super();
  }

  protected runQuery(sql: string, params: unknown[]): Promise<pg.QueryResult> {
    return this.client.query(sql, params);
  }

  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    // No SAVEPOINT support needed: nothing in this codebase nests
    // transaction() calls within the same logical operation — running the
    // callback against the already-open transaction is the correct
    // "join, don't nest" behaviour here.
    return fn(this);
  }

  afterCommit(callback: () => void | Promise<void>): void {
    this.commitCallbacks.push(callback);
  }

  async runAfterCommit(): Promise<void> {
    const callbacks = this.commitCallbacks;
    this.commitCallbacks = [];
    for (const callback of callbacks) {
      try { await callback(); } catch (error) { console.error('Error in after-commit callback:', error); }
    }
  }

  async migrate(sql: string): Promise<void> {
    // node-postgres sends a parameter-free script through PostgreSQL's native
    // multi-statement parser.  Keep this on the checked-out transaction
    // client so every DDL statement and the ledger row share one boundary.
    await this.client.query(sql);
  }

  async close(): Promise<void> {
    // The pool owns this client's lifecycle — released by transaction(), not here.
  }
}

export class PostgresAdapter extends BasePostgresAdapter {
  private readonly pool: PostgresPoolLike;
  // After-commit listeners are serialized in commit order, but run after the
  // transaction client is returned to the pool. A slow SSE subscriber must
  // never consume a checked-out database connection.
  private afterCommitQueue: Promise<unknown> = Promise.resolve();

  constructor(connectionString: string, pool: PostgresPoolLike = new pg.Pool({ connectionString })) {
    super();
    this.pool = pool;
    // Idle connections emit errors outside any request's try/catch when the
    // database restarts. pg removes those clients itself; handle the event so
    // readiness can report the outage and later requests can reconnect.
    this.pool.on?.('error', () => {
      console.error('PostgreSQL idle connection lost; the pool will reconnect on the next request.');
    });
  }

  protected runQuery(sql: string, params: unknown[]): Promise<pg.QueryResult> {
    return this.pool.query(sql, params);
  }

  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let released = false;
    let broken = false;
    let connectionError: Error | undefined;
    const onError = (error: Error) => { broken = true; connectionError = error; };
    // The pool's idle error listener is detached while a transaction owns
    // this client. Cover gaps between queries as well as active query errors.
    client.on?.('error', onError);
    const releaseClient = () => {
      // This listener belongs only to the checked-out transaction. Remove it
      // before the pool can reuse the client, even if callbacks remain queued.
      client.removeListener?.('error', onError);
      client.release(broken);
      released = true;
    };
    try {
      await client.query('BEGIN');
      const txAdapter = new PostgresTransactionAdapter(client);
      const result = await fn(txAdapter);
      if (connectionError) throw connectionError;
      await client.query('COMMIT');
      // COMMIT is durable before any listener runs. Release immediately so a
      // listener that awaits network/SSE backpressure cannot saturate the
      // pool. The queue preserves callback ordering across transactions and
      // each transaction adapter contains listener failures best-effort.
      releaseClient();
      const callbacksRun = this.afterCommitQueue.then(() => txAdapter.runAfterCommit());
      this.afterCommitQueue = callbacksRun.catch(error => {
        console.error('Error in after-commit callbacks:', error);
      });
      await callbacksRun;
      return result;
    } catch (err) {
      if (!released) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // An uncertain connection must never go back into the reusable pool.
          broken = true;
        }
      }
      throw err;
    } finally {
      if (!released) releaseClient();
    }
  }

  async migrate(sql: string): Promise<void> {
    // Migration files are already portable SQL except for one dialect-
    // specific DEFAULT expression — see Migrator.translateForPostgres().
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
