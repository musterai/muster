import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplicationServices } from '../src/application/composition.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { Migrator } from '../src/db/migrator.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-application-composition.db');

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : entry.name.endsWith('.ts') ? [target] : [];
  });
}

describe('transport-neutral application composition', () => {
  let db: DatabaseAdapter | undefined;

  afterEach(async () => {
    await db?.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${TEST_DB}${suffix}`;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });

  it('wires one shared service graph and injects committed events outward', async () => {
    db = createDatabaseAdapter(TEST_DB);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['composition-ws', 'Composition', 'composition', now, now],
    );

    const delivered: string[] = [];
    const services = createApplicationServices(db, {
      publishEvent: (event) => delivered.push(`${event.entity_type}:${event.action}`),
    });

    expect(services.db).toBe(db);
    expect(services.projectService).toBeDefined();
    expect(services.cardService).toBeDefined();
    expect(services.auditService).toBeDefined();

    await services.projectService.create({ name: 'Transport neutral' });
    expect(delivered).toContain('project:created');
    expect(delivered).toContain('board:created');
    expect(delivered).toContain('document:created');
  });

  it('prevents REST from importing MCP and keeps application composition transport-free', () => {
    const apiFiles = sourceFiles(path.join(process.cwd(), 'src/api'));
    for (const file of apiFiles) {
      expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(/from\s+['"][^'"]*\/mcp(?:\/|['"])/);
    }

    const composition = fs.readFileSync(
      path.join(process.cwd(), 'src/application/composition.ts'),
      'utf8',
    );
    expect(composition).not.toMatch(/from\s+['"][^'"]*\/(?:api|mcp|realtime|connect)(?:\/|['"])/);
  });
});
