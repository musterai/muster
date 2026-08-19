import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { EventService } from '../src/services/event.service.js';

describe('MUS-68: persisted SSE resume cursors', () => {
  let tempDir: string;
  let db: DatabaseAdapter;
  let eventService: EventService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-event-resume-'));
    db = createDatabaseAdapter(path.join(tempDir, 'muster.db'));
    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    const now = '2026-08-18T00:00:00.000Z';
    await db.execute(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['resume-ws', 'Resume Workspace', 'resume', now, now],
    );
    for (const projectId of ['resume-project', 'other-project']) {
      await db.execute(
        `INSERT INTO project (id, workspace_id, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [projectId, 'resume-ws', projectId, null, now, now],
      );
    }

    const eventIds = [
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      '01ARZ3NDEKTSV4RRFFQ69G5FAX',
      '01ARZ3NDEKTSV4RRFFQ69G5FAY',
    ];
    for (const [index, id] of eventIds.entries()) {
      await db.execute(
        `INSERT INTO event (id, project_id, entity_type, entity_id, action, payload, created_at, event_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, 'resume-project', 'card', `card-${index}`, 'updated', JSON.stringify({ card_key: `MUS-${index}` }), now, index + 1],
      );
    }
    await db.execute(
      `INSERT INTO event (id, project_id, entity_type, entity_id, action, payload, created_at, event_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['01ARZ3NDEKTSV4RRFFQ69G5FAZ', 'other-project', 'card', 'other-card', 'updated', '{}', now, 5],
    );
    await db.execute('UPDATE event_order_sequence SET next_order = 6 WHERE id = 1');

    eventService = new EventService(db);
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns only same-project successors oldest-first and reports truncation', async () => {
    const result = await eventService.listAfterId(
      'resume-project',
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      2,
    );

    expect(result.status).toBe('available');
    expect(result.truncated).toBe(true);
    expect(result.events.map(event => event.id)).toEqual([
      '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      '01ARZ3NDEKTSV4RRFFQ69G5FAX',
    ]);
    expect(result.events[0].payload).toEqual({ card_key: 'MUS-1' });
  });

  it('replays same-timestamp events even when their ULIDs regress lexically', async () => {
    const cursor = '01ARZ3NDEKTSV4RRFFQ69G5FAY';
    const regressingSuccessor = '01ARZ3NDEKTSV4RRFFQ69G5FAT';
    const laterSuccessor = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
    const sameTimestamp = '2026-08-18T00:00:00.000Z';
    await db.execute(
      `INSERT INTO event (id, project_id, entity_type, entity_id, action, payload, created_at, event_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [regressingSuccessor, 'resume-project', 'card', 'regressing-card', 'updated', '{}', sameTimestamp, 6],
    );
    await db.execute(
      `INSERT INTO event (id, project_id, entity_type, entity_id, action, payload, created_at, event_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [laterSuccessor, 'resume-project', 'card', 'later-card', 'updated', '{}', sameTimestamp, 7],
    );
    await db.execute('UPDATE event_order_sequence SET next_order = 8 WHERE id = 1');

    const result = await eventService.listAfterId('resume-project', cursor, 10);
    expect(result.events.map(event => event.id)).toEqual([regressingSuccessor, laterSuccessor]);
  });

  it('treats stale and foreign cursors as an empty, non-disclosing live-tail reset', async () => {
    const stale = await eventService.listAfterId('resume-project', 'missing-cursor', 100);
    const foreign = await eventService.listAfterId(
      'resume-project',
      '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      100,
    );

    expect(stale).toEqual({ status: 'unavailable', events: [], truncated: false });
    expect(foreign).toEqual({ status: 'unavailable', events: [], truncated: false });
  });
});
