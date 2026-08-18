import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { Migrator } from '../src/db/migrator.js';
import { SSEManager } from '../src/realtime/sse.js';
import { EventService } from '../src/services/event.service.js';

const builtInMigrations = path.join(process.cwd(), 'src/db/migrations');
const workspaceId = 'tx-delivery-workspace';
const projectId = 'tx-delivery-project';

class FakeResponse extends EventEmitter {
  readonly writes: string[] = [];

  setHeader(): this {
    return this;
  }

  flushHeaders(): void {}

  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }

  end(): this {
    this.emit('close');
    return this;
  }
}

const asResponse = (response: FakeResponse) => response as unknown as Response;

describe('MUS-68: transaction-safe SSE event delivery', () => {
  let dir: string;
  let writer: DatabaseAdapter;
  let reader: DatabaseAdapter;
  let manager: SSEManager;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-event-delivery-'));
    const dbPath = path.join(dir, 'muster.db');
    writer = createDatabaseAdapter(dbPath);
    await new Migrator(writer, builtInMigrations).run();
    reader = createDatabaseAdapter(dbPath);
    manager = new SSEManager({ keepAliveIntervalMs: 60_000 });

    const now = new Date().toISOString();
    await writer.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Transaction delivery', 'transaction-delivery', now, now],
    );
    await writer.execute(
      `INSERT INTO project (id, workspace_id, name, description, key_prefix, card_seq, created_at, updated_at, slug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [projectId, workspaceId, 'Transaction delivery', null, 'TXD', 0, now, now, 'transaction-delivery'],
    );
  });

  afterEach(async () => {
    manager?.close();
    await reader?.close();
    await writer?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hands a separate reader to live delivery only after commit and suppresses rollback', async () => {
    const writerEvents = new EventService(writer, event => manager.broadcast(event.project_id, event));
    const readerEvents = new EventService(reader);
    const cursor = await writerEvents.create({
      project_id: projectId,
      entity_type: 'project',
      entity_id: projectId,
      action: 'cursor',
    });
    const response = new FakeResponse();
    expect(manager.addClient(
      projectId,
      'handoff-client',
      asResponse(response),
      { ip: '127.0.0.1', workspaceId },
      { replaying: true },
    )).toEqual({ accepted: true });

    let committedId = '';
    await writer.transaction(async tx => {
      const committed = await writerEvents.create({
        project_id: projectId,
        entity_type: 'project',
        entity_id: projectId,
        action: 'committed',
      }, tx);
      committedId = committed.id;

      // A second connection sees only durable rows while the writer is open.
      await expect(readerEvents.listAfterId(projectId, cursor.id)).resolves.toEqual({
        status: 'available',
        events: [],
        truncated: false,
      });
      manager.completeReplay('handoff-client', []);
      expect(response.writes).toEqual([]);
    });

    expect(response.writes).toHaveLength(1);
    expect(response.writes[0]).toContain(`id: ${committedId}`);
    await expect(readerEvents.listAfterId(projectId, cursor.id)).resolves.toMatchObject({
      status: 'available',
      events: [expect.objectContaining({ id: committedId, action: 'committed' })],
      truncated: false,
    });

    const deliveredBeforeRollback = [...response.writes];
    await expect(writer.transaction(async tx => {
      await writerEvents.create({
        project_id: projectId,
        entity_type: 'project',
        entity_id: projectId,
        action: 'rolled-back',
      }, tx);
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    expect(response.writes).toEqual(deliveredBeforeRollback);
    await expect(readerEvents.listAfterId(projectId, cursor.id)).resolves.toMatchObject({
      status: 'available',
      events: [expect.objectContaining({ id: committedId, action: 'committed' })],
      truncated: false,
    });
  });
});
