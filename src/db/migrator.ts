// File: src/db/migrator.ts
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseAdapter } from './adapter.js';
import { deriveKeyPrefix, formatCardKey } from '../shared/card-key.js';
import { deriveSlug } from '../shared/slug.js';
import { rebalanceRanks } from '../shared/lexorank.js';

/**
 * The schema is the clean-slate schema described by the approved multi-user
 * design.  The value is deliberately independent from the numbered migration
 * filenames: a schema revision can contain several ordered migrations.
 */
export const MIGRATION_SCHEMA_VERSION = '1';
export const MIGRATION_TOOL_VERSION = '1.0.0';

const MIGRATION_LOCK_KEY = 69069;

const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id             TEXT PRIMARY KEY,
    checksum       TEXT NOT NULL,
    applied_at     TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    tool_version   TEXT NOT NULL
  );
`;

type MigrationFile = {
  id: string;
  filename: string;
  sql: string;
  checksum: string;
  number: number | null;
};

type AppliedMigration = {
  id: string;
  checksum: string;
  applied_at: string;
  schema_version: string;
  tool_version: string;
};

type ColumnTarget = { table: string; column: string };

// 001 is the approved squash and already contains these columns.  The later
// files remain in the repository so an older pre-squash database can be
// upgraded, but executing their ALTER TABLE against a fresh 001 database
// would be a duplicate-column error (and PostgreSQL aborts the whole tx on
// that error).  Preflighting these known compatibility patches keeps the SQL
// file itself parser-safe while still recording the migration exactly once.
const SATISFIED_BY_SQUASH: Record<string, ColumnTarget[]> = {
  '002-invitation-created-at.sql': [{ table: 'invitation', column: 'created_at' }],
  '005-audit-log.sql': [{ table: 'audit_log', column: 'actor_kind' }],
  '006-terminal-columns.sql': [{ table: 'column', column: 'is_terminal' }],
  '007-project-board-slugs.sql': [
    { table: 'project', column: 'slug' },
    { table: 'board', column: 'slug' },
  ],
};

// These are the tables created by the approved 001 clean-schema squash.  A
// pre-ledger database is only adopted when this recognizable baseline exists;
// arbitrary existing data is never silently treated as migrated.
const INITIAL_SCHEMA_TABLES = [
  'workspace',
  'principal',
  'app_user',
  'identity',
  'role',
  'workspace_member',
  'invitation',
  'oidc_transaction',
  'session',
  'api_token',
  'audit_log',
  'agent',
  'project',
  'board',
  'column',
  'card',
  'card_assignee',
  'card_link',
  'card_work_link',
  'comment',
  'label',
  'card_label',
  'document',
  'document_version',
  'card_document',
  'attachment',
  'event',
  'knowledge_base',
  'project_knowledge_base',
  'kb_entity',
  'kb_fact',
  'kb_relation',
];

const LATER_SCHEMA_TABLES = [
  'device_grant',
  'oauth_client',
  'oauth_authorization_code',
  'oauth_refresh_token',
];

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function migrationNumber(id: string): number | null {
  const match = id.match(/^(\d+)(?:[-_.]|$)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Migration ledger has an invalid ${field}; refusing to continue.`);
  }
  return value;
}

/**
 * The migrations directory is one canonical set of files, not a fork per
 * dialect — everything in it is already portable SQL (see MUS-31's audit)
 * except this one DEFAULT expression, which this function swaps for
 * Postgres's equivalent. `to_char` with these format tokens produces the
 * exact same "2026-01-01T00:00:00.000Z" shape strftime does, which matters
 * because created_at is compared and sorted as TEXT throughout the app.
 */
export function translateForPostgres(sql: string): string {
  return sql.replace(
    /strftime\('%Y-%m-%dT%H:%M:%fZ',\s*'now'\)/gi,
    `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  );
}

export class Migrator {
  private db: DatabaseAdapter;
  private migrationsDir: string;

  constructor(db: DatabaseAdapter, migrationsDir: string) {
    this.db = db;
    this.migrationsDir = migrationsDir;
  }

  async run(): Promise<void> {
    const migrations = this.loadMigrations();
    if (migrations.length === 0) return;

    // The first transaction creates the ledger and, when appropriate, adopts
    // the one explicitly supported pre-ledger baseline.  It also validates
    // every existing row while the startup lock is held, so two processes can
    // never make different decisions about the same history.
    await this.db.transaction(async (tx) => {
      await this.acquireMigrationLock(tx);
      await this.ensureLedger(tx, migrations);
    });

    // Each migration has its own transaction.  This preserves already
    // committed versions when a later migration fails while guaranteeing that
    // a migration's DDL and ledger row commit or roll back together.
    for (const migration of migrations) {
      await this.db.transaction(async (tx) => {
        await this.acquireMigrationLock(tx);
        const applied = await this.readLedger(tx);
        this.validateLedger(applied, migrations);

        if (applied.some(row => row.id === migration.id)) return;

        const migrationIndex = migrations.findIndex(item => item.id === migration.id);
        for (const previous of migrations.slice(0, migrationIndex)) {
          if (!applied.some(row => row.id === previous.id)) {
            throw new Error(
              `Migration history is incomplete before "${migration.id}"; refusing to apply out of order. ` +
              'Restore the missing migration ledger entry from a backup.',
            );
          }
        }

        if (!(await this.isSatisfiedByExistingSchema(tx, migration))) {
          const sql = this.db.dialect === 'postgres' ? translateForPostgres(migration.sql) : migration.sql;
          await tx.migrate(sql);
        }

        await tx.execute(
          `INSERT INTO schema_migrations (id, checksum, applied_at, schema_version, tool_version)
           VALUES (?, ?, ?, ?, ?)`,
          [migration.id, migration.checksum, new Date().toISOString(), MIGRATION_SCHEMA_VERSION, MIGRATION_TOOL_VERSION],
        );
      });
    }

    // Backfills are data repair associated with the final schema shape. Keep
    // them behind the same startup lock and in a transaction so an interrupted
    // repair can be retried without leaving half-populated derived fields.
    await this.db.transaction(async (tx) => {
      await this.acquireMigrationLock(tx);
      const applied = await this.readLedger(tx);
      this.validateLedger(applied, migrations);
      if (await this.hasTables(tx, ['project', 'board'])) {
        await this.backfillSlugs(tx);
      }
      if (await this.hasTables(tx, ['project', 'board', 'column', 'card'])) {
        await this.backfillCardKeys(tx);
        await this.repairLegacyRanks(tx);
      }
    });
  }

  private loadMigrations(): MigrationFile[] {
    let targetDir = this.migrationsDir;
    if (!fs.existsSync(targetDir) || fs.readdirSync(targetDir).filter(f => f.endsWith('.sql')).length === 0) {
      const srcDir = path.join(process.cwd(), 'src/db/migrations');
      if (fs.existsSync(srcDir)) targetDir = srcDir;
    }

    if (!fs.existsSync(targetDir)) return [];

    return fs.readdirSync(targetDir)
      .filter(filename => filename.endsWith('.sql'))
      .sort((left, right) => {
        const leftNumber = migrationNumber(left);
        const rightNumber = migrationNumber(right);
        if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
          return leftNumber - rightNumber;
        }
        return left.localeCompare(right);
      })
      .map(filename => {
        const sql = fs.readFileSync(path.join(targetDir, filename), 'utf8');
        return {
          id: filename,
          filename,
          sql,
          checksum: checksum(sql),
          number: migrationNumber(filename),
        };
      });
  }

  private async acquireMigrationLock(tx: DatabaseAdapter): Promise<void> {
    if (tx.dialect === 'postgres') {
      // SQLite's BEGIN IMMEDIATE (inside SQLiteAdapter.transaction) already
      // serializes writers. PostgreSQL has a real pool, so use a transaction
      // advisory lock as the portable boundary for migration startup.
      await tx.execute('SELECT pg_advisory_xact_lock(?)', [MIGRATION_LOCK_KEY]);
    }
  }

  private async ensureLedger(tx: DatabaseAdapter, migrations: MigrationFile[]): Promise<void> {
    const tables = await this.listTables(tx);
    const ledgerExisted = tables.has('schema_migrations');
    const applicationSchemaExists = [...tables].some(name => name !== 'schema_migrations' && name !== 'sqlite_sequence');

    await tx.migrate(LEDGER_SQL);

    let applied: AppliedMigration[];
    try {
      applied = await this.readLedger(tx);
    } catch (error) {
      throw new Error(`Migration ledger is unreadable; refusing to continue: ${(error as Error).message}`);
    }

    if (ledgerExisted) {
      if (applied.length === 0 && applicationSchemaExists) {
        throw new Error(
          'Migration ledger is empty while application tables exist; refusing to reinterpret existing data. ' +
          'Restore schema_migrations from a backup or use the supported pre-release baseline.',
        );
      }
      this.validateLedger(applied, migrations);
      return;
    }

    if (!applicationSchemaExists) return;

    // A database from before MUS-69 has no ledger.  Only the recognizable
    // clean-schema squash is supported; arbitrary legacy schemas fail closed.
    if (!migrations.some(migration => migration.id === '001-initial.sql') || !(await this.hasTables(tx, INITIAL_SCHEMA_TABLES))) {
      throw new Error(
        'Existing database has no migration ledger and is not the supported clean-schema baseline; ' +
        'refusing to reinterpret old production data.',
      );
    }

    const allLaterTablesPresent = await this.hasTables(tx, LATER_SCHEMA_TABLES);
    const allColumnsPresent = await this.hasColumns(tx, Object.values(SATISFIED_BY_SQUASH).flat());
    const baselineMigrations = allLaterTablesPresent && allColumnsPresent ? migrations : migrations.filter(migration => migration.id === '001-initial.sql');

    const now = new Date().toISOString();
    for (const migration of baselineMigrations) {
      await tx.execute(
        `INSERT INTO schema_migrations (id, checksum, applied_at, schema_version, tool_version)
         VALUES (?, ?, ?, ?, ?)`,
        [migration.id, migration.checksum, now, MIGRATION_SCHEMA_VERSION, MIGRATION_TOOL_VERSION],
      );
    }
    this.validateLedger(await this.readLedger(tx), migrations);
  }

  private async readLedger(tx: DatabaseAdapter): Promise<AppliedMigration[]> {
    try {
      const rows = await tx.query<Record<string, unknown>>(
        `SELECT id, checksum, applied_at, schema_version, tool_version
           FROM schema_migrations
          ORDER BY id`,
      );
      return rows.map(row => ({
        id: asString(row.id, 'id'),
        checksum: asString(row.checksum, 'checksum'),
        applied_at: asString(row.applied_at, 'applied_at'),
        schema_version: asString(row.schema_version, 'schema_version'),
        tool_version: asString(row.tool_version, 'tool_version'),
      }));
    } catch (error) {
      throw new Error(`schema_migrations cannot be read: ${(error as Error).message}`);
    }
  }

  private validateLedger(applied: AppliedMigration[], migrations: MigrationFile[]): void {
    const known = new Map(migrations.map(migration => [migration.id, migration]));
    const seen = new Set<string>();
    let highestAppliedNumber: number | null = null;

    for (const row of applied) {
      if (seen.has(row.id)) {
        throw new Error(`Migration ledger contains duplicate id "${row.id}"; refusing to continue.`);
      }
      seen.add(row.id);

      const schemaVersion = Number(row.schema_version);
      if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
        throw new Error(`Migration ledger has invalid schema version "${row.schema_version}" for "${row.id}".`);
      }
      if (schemaVersion > Number(MIGRATION_SCHEMA_VERSION)) {
        throw new Error(
          `Migration ledger references future schema version "${row.schema_version}" in "${row.id}"; ` +
          'upgrade this binary before starting the server.',
        );
      }

      const migration = known.get(row.id);
      if (!migration) {
        throw new Error(
          `Migration ledger contains unknown migration "${row.id}"; refusing to run with a future or edited history.`,
        );
      }
      if (row.checksum !== migration.checksum) {
        throw new Error(
          `Migration checksum mismatch for "${row.id}"; restore the original file or add a new migration instead of editing history.`,
        );
      }

      if (migration.number !== null && (highestAppliedNumber === null || migration.number > highestAppliedNumber)) {
        highestAppliedNumber = migration.number;
      }
    }

    if (highestAppliedNumber !== null) {
      for (const migration of migrations) {
        if (migration.number !== null && migration.number <= highestAppliedNumber && !seen.has(migration.id)) {
          throw new Error(
            `Migration ledger is missing historical migration "${migration.id}"; refusing to continue out of order.`,
          );
        }
      }
    }
  }

  private async listTables(tx: DatabaseAdapter): Promise<Set<string>> {
    const rows = tx.dialect === 'sqlite'
      ? await tx.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      : await tx.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    return new Set(rows.map(row => ('name' in row ? row.name : row.table_name)));
  }

  private async hasTables(tx: DatabaseAdapter, names: string[]): Promise<boolean> {
    const tables = await this.listTables(tx);
    return names.every(name => tables.has(name));
  }

  private async hasColumns(tx: DatabaseAdapter, targets: ColumnTarget[]): Promise<boolean> {
    for (const target of targets) {
      if (!(await this.columnExists(tx, target))) return false;
    }
    return true;
  }

  private async columnExists(tx: DatabaseAdapter, target: ColumnTarget): Promise<boolean> {
    if (tx.dialect === 'sqlite') {
      const rows = await tx.query<{ name: string }>(`PRAGMA table_info("${target.table}")`);
      return rows.some(row => row.name === target.column);
    }
    const rows = await tx.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
      [target.table, target.column],
    );
    return rows.length > 0;
  }

  private async isSatisfiedByExistingSchema(tx: DatabaseAdapter, migration: MigrationFile): Promise<boolean> {
    const targets = SATISFIED_BY_SQUASH[migration.id];
    return !!targets && await this.hasColumns(tx, targets);
  }

  /**
   * Populate URL slugs for rows created before slugs were introduced. The
   * ordered pass makes collision suffixes deterministic across restarts.
   */
  private async backfillSlugs(db: DatabaseAdapter): Promise<void> {
    const projects = await db.query<{ id: string; name: string; slug: string | null }>(
      `SELECT id, name, slug FROM project ORDER BY created_at ASC, id ASC`
    );
    const projectSlugs = new Set(projects.map(project => project.slug).filter((slug): slug is string => !!slug));

    for (const project of projects) {
      if (project.slug) continue;
      const slug = deriveSlug(project.name, projectSlugs);
      projectSlugs.add(slug);
      await db.execute(`UPDATE project SET slug = ? WHERE id = ?`, [slug, project.id]);
    }

    const boards = await db.query<{ id: string; project_id: string; name: string; slug: string | null }>(
      `SELECT id, project_id, name, slug FROM board ORDER BY created_at ASC, id ASC`
    );
    const slugsByProject = new Map<string, Set<string>>();
    for (const board of boards) {
      if (!slugsByProject.has(board.project_id)) slugsByProject.set(board.project_id, new Set());
      if (board.slug) slugsByProject.get(board.project_id)!.add(board.slug);
    }

    for (const board of boards) {
      if (board.slug) continue;
      const taken = slugsByProject.get(board.project_id)!;
      const slug = deriveSlug(board.name, taken);
      taken.add(slug);
      await db.execute(`UPDATE board SET slug = ? WHERE id = ?`, [slug, board.id]);
    }

    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_slug ON project(slug)`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_board_project_slug ON board(project_id, slug)`);
  }

  /**
   * Assigns key_prefix/key to any project/card rows left over from before
   * card keys were introduced. No-op once every row has been backfilled.
   */
  private async backfillCardKeys(db: DatabaseAdapter): Promise<void> {
    const projects = await db.query<{ id: string; name: string; key_prefix: string | null }>(
      `SELECT id, name, key_prefix FROM project ORDER BY created_at ASC`
    );
    if (projects.length === 0) return;

    const taken = new Set(projects.map(p => p.key_prefix).filter((p): p is string => !!p));
    for (const project of projects) {
      if (project.key_prefix) continue;
      const prefix = deriveKeyPrefix(project.name, taken);
      taken.add(prefix);
      await db.execute(`UPDATE project SET key_prefix = ? WHERE id = ?`, [prefix, project.id]);
    }

    const cards = await db.query<{ id: string; project_id: string }>(
      `SELECT c.id, b.project_id FROM card c
       JOIN "column" col ON c.column_id = col.id
       JOIN board b ON col.board_id = b.id
       WHERE c.key IS NULL
       ORDER BY c.created_at ASC`
    );
    if (cards.length === 0) return;

    const seqByProject = new Map<string, number>();
    const prefixRows = await db.query<{ id: string; key_prefix: string; card_seq: number }>(
      `SELECT id, key_prefix, card_seq FROM project`
    );
    const prefixByProject = new Map(prefixRows.map(p => [p.id, p.key_prefix]));
    for (const p of prefixRows) seqByProject.set(p.id, p.card_seq);

    for (const card of cards) {
      const prefix = prefixByProject.get(card.project_id);
      if (!prefix) continue;
      const seq = (seqByProject.get(card.project_id) || 0) + 1;
      seqByProject.set(card.project_id, seq);
      await db.execute(`UPDATE card SET key = ? WHERE id = ?`, [formatCardKey(prefix, seq), card.id]);
    }

    for (const [projectId, seq] of seqByProject) {
      await db.execute(`UPDATE project SET card_seq = ? WHERE id = ?`, [seq, projectId]);
    }
  }

  /**
   * Repair every lane at startup, not only lanes touched by a new move. The
   * ordered id tie-break makes duplicate/legacy values stable and the whole
   * pass runs under the startup transaction/lock, so no reader observes a
   * partially repaired lane.
   */
  private async repairLegacyRanks(db: DatabaseAdapter): Promise<void> {
    const columns = await db.query<{ id: string; board_id: string; position: string }>(
      `SELECT id, board_id, position FROM "column" ORDER BY board_id, position, id`,
    );
    const columnsByBoard = new Map<string, typeof columns>();
    for (const column of columns) {
      const boardColumns = columnsByBoard.get(column.board_id) || [];
      boardColumns.push(column);
      columnsByBoard.set(column.board_id, boardColumns);
    }
    for (const boardColumns of columnsByBoard.values()) {
      const ranks = rebalanceRanks(boardColumns.length);
      for (let index = 0; index < boardColumns.length; index++) {
        await db.execute('UPDATE "column" SET position = ? WHERE id = ?', [ranks[index], boardColumns[index].id]);
      }
    }

    const cards = await db.query<{ id: string; column_id: string; position: string }>(
      `SELECT id, column_id, position FROM card ORDER BY column_id, position, id`,
    );
    const cardsByColumn = new Map<string, typeof cards>();
    for (const card of cards) {
      const laneCards = cardsByColumn.get(card.column_id) || [];
      laneCards.push(card);
      cardsByColumn.set(card.column_id, laneCards);
    }
    for (const laneCards of cardsByColumn.values()) {
      const ranks = rebalanceRanks(laneCards.length);
      for (let index = 0; index < laneCards.length; index++) {
        await db.execute('UPDATE card SET position = ? WHERE id = ?', [ranks[index], laneCards[index].id]);
      }
    }
  }
}
