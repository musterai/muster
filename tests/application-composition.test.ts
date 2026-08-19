import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Router } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createApplicationServices } from '../src/application/composition.js';
import { createTransportRuntime } from '../src/application/transport-runtime.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { Migrator } from '../src/db/migrator.js';
import { SSEManager } from '../src/realtime/sse.js';
import type { Services } from '../src/shared/services.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-application-composition.db');

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

  it('hands REST, MCP and SSE the same root-owned graph and policy identities', async () => {
    db = createDatabaseAdapter(TEST_DB);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['transport-ws', 'Transport', 'transport', now, now],
    );

    const delivered: string[] = [];
    const sseManager = new SSEManager();
    sseManager.broadcast = async (_projectId, event) => {
      delivered.push(`${event.entity_type}:${event.action}`);
    };
    let restServices: Services | undefined;
    let mcpServices: Services | undefined;

    const runtime = createTransportRuntime(db, {
      sseManager,
      restRouterFactory: (services) => {
        restServices = services;
        return Router();
      },
      mcpServerFactory: (services) => {
        mcpServices = services;
        return {} as McpServer;
      },
    });
    runtime.createMcpServer();

    expect(restServices).toBe(runtime.services);
    expect(mcpServices).toBe(runtime.services);
    expect(runtime.services.cardService.accessPolicy).toBe(runtime.services.cardAccessPolicy);
    expect(runtime.services.cardService.lanePolicy).toBe(runtime.services.cardLanePolicy);
    expect(runtime.services.cardService.records).toBe(runtime.services.cardRecordQueries);
    expect(runtime.services.cardService.moveOperations).toBe(runtime.services.cardMoveOperations);
    expect(runtime.services.cardService.assignmentOperations)
      .toBe(runtime.services.cardAssignmentOperations);
    expect(runtime.services.cardService.relationOperations)
      .toBe(runtime.services.cardRelationOperations);

    await runtime.services.projectService.create({ name: 'Shared transport graph' });
    expect(delivered).toContain('project:created');
    expect(delivered).toContain('board:created');
  });
});
