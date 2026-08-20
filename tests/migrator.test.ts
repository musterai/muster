import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { EventService } from '../src/services/event.service.js';

const builtInMigrations = path.join(process.cwd(), 'src/db/migrations');

type Fixture = { dir: string; db: DatabaseAdapter; dbPath: string };
const fixtures: Fixture[] = [];

function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-migrator-'));
  const dbPath = path.join(dir, 'muster.db');
  const db = createDatabaseAdapter(dbPath);
  const value = { dir, db, dbPath };
  fixtures.push(value);
  return value;
}

function writeMigration(dir: string, filename: string, sql: string): void {
  const migrationsDir = path.join(dir, 'migrations');
  fs.mkdirSync(migrationsDir, { recursive: true });
  fs.writeFileSync(path.join(migrationsDir, filename), sql);
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.db.close();
    fs.rmSync(item.dir, { recursive: true, force: true });
  }
});

describe('migration ledger and atomic execution', () => {
  it('applies fresh migrations once and records checksums and versions', async () => {
    const { db } = fixture();
    const migrator = new Migrator(db, builtInMigrations);

    await migrator.run();
    await migrator.run();

    const rows = await db.query<{ id: string; checksum: string; applied_at: string; schema_version: string; tool_version: string }>(
      'SELECT id, checksum, applied_at, schema_version, tool_version FROM schema_migrations ORDER BY id',
    );
    expect(rows).toHaveLength(12);
    expect(rows.every(row => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
    expect(rows.every(row => row.applied_at && row.schema_version === '1' && row.tool_version)).toBe(true);
  });

  it('executes trigger bodies, comments, and embedded semicolons through the database parser', async () => {
    const { dir, db } = fixture();
    writeMigration(dir, '001-trigger.sql', `
      -- A comment with a semicolon; it is not a statement boundary.
      CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT NOT NULL);
      CREATE TRIGGER audit_after_insert AFTER INSERT ON audit
      BEGIN
        INSERT INTO audit (note) VALUES ('trigger; semicolon');
      END;
      INSERT INTO audit (note) VALUES ('literal; semicolon');
    `);

    await new Migrator(db, path.join(dir, 'migrations')).run();

    const notes = await db.query<{ note: string }>('SELECT note FROM audit ORDER BY id');
    expect(notes.map(row => row.note).sort()).toEqual(['literal; semicolon', 'trigger; semicolon'].sort());
  });

  it('rolls back a failing migration without advancing its ledger', async () => {
    const { dir, db } = fixture();
    writeMigration(dir, '001-good.sql', 'CREATE TABLE good (id INTEGER PRIMARY KEY);');
    writeMigration(dir, '002-failing.sql', `
      CREATE TABLE rolled_back (id INTEGER PRIMARY KEY);
      INSERT INTO rolled_back (id) VALUES (1);
      SELECT * FROM table_that_does_not_exist;
    `);

    await expect(new Migrator(db, path.join(dir, 'migrations')).run()).rejects.toThrow();
    expect(await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'good'")).toHaveLength(1);
    expect(await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back'")).toHaveLength(0);
    expect(await db.query<{ id: string }>('SELECT id FROM schema_migrations')).toEqual([{ id: '001-good.sql' }]);
  });

  it('fails closed when an applied migration is edited', async () => {
    const { dir, db } = fixture();
    writeMigration(dir, '001-editable.sql', 'CREATE TABLE editable (id INTEGER PRIMARY KEY);');
    const migrationsDir = path.join(dir, 'migrations');
    const migrator = new Migrator(db, migrationsDir);
    await migrator.run();

    fs.appendFileSync(path.join(migrationsDir, '001-editable.sql'), '\n-- edited history\n');
    await expect(migrator.run()).rejects.toThrow(/checksum mismatch/i);
  });

  it('serializes concurrent SQLite starters so exactly one ledger row is written', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-migrator-race-'));
    const migrationsDir = path.join(dir, 'migrations');
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, '001-race.sql'), 'CREATE TABLE race (id INTEGER PRIMARY KEY);');
    const dbPath = path.join(dir, 'muster.db');
    const dbA = createDatabaseAdapter(dbPath);
    const dbB = createDatabaseAdapter(dbPath);
    fixtures.push({ dir, db: dbA, dbPath });
    fixtures.push({ dir: `${dir}-second`, db: dbB, dbPath });

    await expect(Promise.all([
      new Migrator(dbA, migrationsDir).run(),
      new Migrator(dbB, migrationsDir).run(),
    ])).resolves.not.toThrow();
    expect(await dbA.query<{ count: number }>('SELECT COUNT(*) AS count FROM schema_migrations')).toEqual([{ count: 1 }]);
  });

  it('adopts a through-007 pre-ledger schema, applies 009, and supports event replay', async () => {
    const { db } = fixture();
    // 002 is already part of the 001 squash. Applying these files leaves a
    // realistic no-ledger schema through 007, deliberately before 008/009.
    for (const filename of [
      '001-initial.sql',
      '003-device-grant.sql',
      '004-mcp-oauth.sql',
      '005-audit-log.sql',
      '006-terminal-columns.sql',
      '007-project-board-slugs.sql',
    ]) {
      await db.migrate(fs.readFileSync(path.join(builtInMigrations, filename), 'utf8'));
    }

    await new Migrator(db, builtInMigrations).run();
    const rows = await db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
    expect(rows.map(row => row.id)).toEqual([
      '001-initial.sql',
      '002-invitation-created-at.sql',
      '003-device-grant.sql',
      '004-mcp-oauth.sql',
      '005-audit-log.sql',
      '006-terminal-columns.sql',
      '007-project-board-slugs.sql',
      '008-credential-indexes.sql',
      '009-event-order.sql',
      '010-pagination-indexes.sql',
      '011-workflow-lane-roles.sql',
      '012-kb-read-indexes.sql',
    ]);

    expect(await db.query<{ name: string }>('PRAGMA table_info("event")'))
      .toContainEqual(expect.objectContaining({ name: 'event_order' }));
    expect(await db.query<{ next_order: number }>('SELECT next_order FROM event_order_sequence WHERE id = 1'))
      .toEqual([{ next_order: 1 }]);

    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['migration-workspace', 'Migration fixture', 'migration-fixture', now, now],
    );
    await db.execute(
      `INSERT INTO project (id, workspace_id, name, description, key_prefix, card_seq, created_at, updated_at, slug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['migration-project', 'migration-workspace', 'Migration project', null, 'MIG', 0, now, now, 'migration-project'],
    );

    const events = new EventService(db);
    const first = await events.create({
      project_id: 'migration-project',
      entity_type: 'project',
      entity_id: 'migration-project',
      action: 'fixture.first',
    });
    const second = await events.create({
      project_id: 'migration-project',
      entity_type: 'project',
      entity_id: 'migration-project',
      action: 'fixture.second',
    });

    expect(await db.query<{ event_order: number }>('SELECT event_order FROM event ORDER BY event_order'))
      .toEqual([{ event_order: 1 }, { event_order: 2 }]);
    await expect(events.listAfterId('migration-project', first.id)).resolves.toMatchObject({
      status: 'available',
      truncated: false,
      events: [expect.objectContaining({ id: second.id, action: 'fixture.second' })],
    });
  });

  it('rejects an empty ledger on a non-empty database and unknown future versions', async () => {
    const { db } = fixture();
    const migrator = new Migrator(db, builtInMigrations);
    await migrator.run();
    await db.execute(
      `INSERT INTO schema_migrations (id, checksum, applied_at, schema_version, tool_version)
       VALUES (?, ?, ?, ?, ?)`,
      ['999-future.sql', 'future', new Date().toISOString(), '2', 'future'],
    );
    await expect(migrator.run()).rejects.toThrow(/future|unknown/i);

    await db.execute('DELETE FROM schema_migrations');
    await expect(migrator.run()).rejects.toThrow(/ledger is empty/i);
  });
});
