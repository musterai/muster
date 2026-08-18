import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Response } from 'express';
import { createEventRouter, getTrustedSSEClientIp, parseLastEventId } from '../src/api/routes/event.routes.js';
import { SSEManager, toSSEEvent } from '../src/realtime/sse.js';
import type { Event } from '../src/shared/types.js';
import type { EventService } from '../src/services/event.service.js';

class FakeResponse extends EventEmitter {
  readonly writes: string[] = [];
  readonly headers = new Map<string, string>();
  writable = true;
  ended = false;

  setHeader(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  flushHeaders(): void {}

  write(data: string): boolean {
    this.writes.push(data);
    return this.writable;
  }

  end(): this {
    this.ended = true;
    this.emit('close');
    return this;
  }
}

const asResponse = (response: FakeResponse) => response as unknown as Response;

function event(payload: Record<string, unknown>, overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-1',
    project_id: 'project-1',
    entity_type: 'card',
    entity_id: 'card-1',
    action: 'updated',
    actor_id: 'agent-1',
    payload,
    created_at: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('MUS-68: bounded SSE delivery', () => {
  const managers: SSEManager[] = [];

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.close();
    vi.useRealTimers();
  });

  function manager(options: ConstructorParameters<typeof SSEManager>[0] = {}): SSEManager {
    const value = new SSEManager({ keepAliveIntervalMs: 60_000, ...options });
    managers.push(value);
    return value;
  }

  it('allowlists and bounds the SSE event projection', () => {
    const projected = toSSEEvent(event({
      card_title: 'Visible title',
      content: 'comment body must not be broadcast',
      description: 'card body must not be broadcast',
      arbitrary: 'not approved',
      to_column_id: 'column-2',
    }));

    expect(projected.payload).toEqual({ card_title: 'Visible title', to_column_id: 'column-2' });
    expect(JSON.stringify(projected)).not.toContain('comment body');
    expect(JSON.stringify(projected)).not.toContain('card body');
    expect(JSON.stringify(projected)).not.toContain('arbitrary');

    const bounded = toSSEEvent(event({ card_title: 'x'.repeat(1000) }));
    expect((bounded.payload?.card_title as string).length).toBe(256);
  });

  it('enforces principal, IP, workspace, and global connection caps', () => {
    const principal = manager({ maxPrincipalClients: 1, maxIpClients: 10, maxWorkspaceClients: 10, maxGlobalClients: 10 });
    expect(principal.addClient('p', 'p-1', asResponse(new FakeResponse()), { principalId: 'u-1', ip: 'ip-1', workspaceId: 'w-1' })).toEqual({ accepted: true });
    expect(principal.addClient('p', 'p-2', asResponse(new FakeResponse()), { principalId: 'u-1', ip: 'ip-2', workspaceId: 'w-1' })).toMatchObject({ accepted: false, scope: 'principal' });

    const ip = manager({ maxPrincipalClients: 10, maxIpClients: 1, maxWorkspaceClients: 10, maxGlobalClients: 10 });
    expect(ip.addClient('p', 'ip-1', asResponse(new FakeResponse()), { principalId: 'u-1', ip: 'ip-1', workspaceId: 'w-1' })).toEqual({ accepted: true });
    expect(ip.addClient('p', 'ip-2', asResponse(new FakeResponse()), { principalId: 'u-2', ip: 'ip-1', workspaceId: 'w-2' })).toMatchObject({ accepted: false, scope: 'ip' });

    const workspace = manager({ maxPrincipalClients: 10, maxIpClients: 10, maxWorkspaceClients: 1, maxGlobalClients: 10 });
    expect(workspace.addClient('p', 'w-1', asResponse(new FakeResponse()), { principalId: 'u-1', ip: 'ip-1', workspaceId: 'w-1' })).toEqual({ accepted: true });
    expect(workspace.addClient('p', 'w-2', asResponse(new FakeResponse()), { principalId: 'u-2', ip: 'ip-2', workspaceId: 'w-1' })).toMatchObject({ accepted: false, scope: 'workspace' });

    const global = manager({ maxGlobalClients: 1, maxPrincipalClients: 10, maxIpClients: 10, maxWorkspaceClients: 10 });
    expect(global.addClient('p', 'g-1', asResponse(new FakeResponse()), { principalId: 'u-1', ip: 'ip-1', workspaceId: 'w-1' })).toEqual({ accepted: true });
    expect(global.addClient('p', 'g-2', asResponse(new FakeResponse()), { principalId: 'u-2', ip: 'ip-2', workspaceId: 'w-2' })).toMatchObject({ accepted: false, scope: 'global' });
    expect(global.getStats().capacityRejections).toBe(1);
  });

  it('bounds a slow consumer queue and disconnects it when it overflows', () => {
    const value = manager({ maxQueuedEvents: 2, maxQueuedBytes: 100_000, backpressureTimeoutMs: 1_000 });
    const response = new FakeResponse();
    response.writable = false;
    expect(value.addClient('project-1', 'slow', asResponse(response), { ip: 'ip-1' })).toEqual({ accepted: true });

    value.broadcast('project-1', event({ card_title: 'one' }));
    value.broadcast('project-1', event({ card_title: 'two' }));
    value.broadcast('project-1', event({ card_title: 'three' }));
    expect(value.getStats().activeClients).toBe(1);
    value.broadcast('project-1', event({ card_title: 'four' }));

    expect(response.ended).toBe(true);
    expect(value.getStats()).toMatchObject({ activeClients: 0, eventsDropped: 3, backpressureDrops: 1 });
  });

  it('replays bounded cursor events before live frames that arrive during the read', () => {
    const value = manager({ maxResumeEvents: 2, maxQueuedEvents: 4, maxQueuedBytes: 100_000 });
    const response = new FakeResponse();
    expect(value.addClient(
      'project-1',
      'resume',
      asResponse(response),
      { ip: 'ip-1' },
      { replaying: true },
    )).toEqual({ accepted: true });

    value.broadcast('project-1', event({ card_title: 'duplicate-live' }, { id: 'evt-old-2' }));
    value.broadcast('project-1', event({ card_title: 'live' }, { id: 'evt-live' }));
    expect(response.writes).toHaveLength(0);

    value.completeReplay('resume', [
      event({ card_title: 'old-1' }, { id: 'evt-old-1' }),
      event({ card_title: 'old-2' }, { id: 'evt-old-2' }),
      event({ card_title: 'old-3' }, { id: 'evt-old-3' }),
    ]);

    expect(response.writes).toHaveLength(3);
    expect(response.writes[0]).toContain('id: evt-old-1');
    expect(response.writes[1]).toContain('id: evt-old-2');
    expect(response.writes[2]).toContain('id: evt-live');
    expect(value.getStats()).toMatchObject({ eventsSent: 3, eventsDropped: 0 });
  });

  it('keeps malformed cursors bounded and uses Express trusted client IP for caps', () => {
    expect(parseLastEventId('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(parseLastEventId('contains whitespace')).toBeNull();
    expect(parseLastEventId('x'.repeat(129))).toBeNull();

    const request = {
      socket: { remoteAddress: '127.0.0.1' },
      ip: '198.51.100.99',
    } as unknown as import('express').Request;
    expect(getTrustedSSEClientIp(request)).toBe('198.51.100.99');
  });

  it('flushes bounded queued events after drain and cleans up on close', () => {
    const value = manager({ maxQueuedEvents: 4, maxQueuedBytes: 100_000, backpressureTimeoutMs: 1_000 });
    const response = new FakeResponse();
    response.writable = false;
    value.addClient('project-1', 'slow', asResponse(response), { ip: 'ip-1' });
    value.broadcast('project-1', event({ card_title: 'one' }));
    value.broadcast('project-1', event({ card_title: 'two' }));

    response.writable = true;
    response.emit('drain');
    expect(response.writes).toHaveLength(2);
    expect(value.getStats().activeClients).toBe(1);

    response.emit('close');
    expect(value.getStats().activeClients).toBe(0);
    value.broadcast('project-1', event({ card_title: 'after-close' }));
    expect(response.writes).toHaveLength(2);
  });

  it('sends keep-alives without queueing them behind a slow client', () => {
    vi.useFakeTimers();
    const value = manager({ keepAliveIntervalMs: 25 });
    const response = new FakeResponse();
    value.addClient('project-1', 'client', asResponse(response), { ip: 'ip-1' });
    vi.advanceTimersByTime(25);
    expect(response.writes).toEqual([': keep-alive\n\n']);
  });

  it('rejects a member trying to stream a project from another workspace', async () => {
    const value = manager();
    const app = express();
    app.use((req, _res, next) => {
      (req as any).authContext = {
        principal: { kind: 'user', id: 'user-1' },
        workspace_id: 'workspace-a',
        is_workspace_member: true,
        permissions: [],
        is_operator_override: false,
        role_name: 'Observer',
      };
      next();
    });
    const eventService = {
      getProjectWorkspaceId: async () => 'workspace-b',
    } as unknown as EventService;
    app.use('/api/v1', createEventRouter(eventService, value));
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/projects/project-1/events/stream`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found', message: 'Project not found.' });
      expect(value.getStats().activeClients).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns a structured capacity refusal before opening the stream', async () => {
    const value = manager({ maxGlobalClients: 0 });
    const app = express();
    app.use((req, _res, next) => {
      (req as any).authContext = { principal: null, workspace_id: null, is_workspace_member: false, permissions: [], is_operator_override: false, role_name: null };
      next();
    });
    const eventService = {
      getProjectWorkspaceId: async () => 'workspace-a',
    } as unknown as EventService;
    app.use('/api/v1', createEventRouter(eventService, value));
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/projects/project-1/events/stream`);
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('30');
      expect(await response.json()).toMatchObject({ error: 'sse_capacity_exceeded', scope: 'global' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('replays an authorized persisted tail through the stream before closing', async () => {
    const value = manager();
    const app = express();
    app.use((req, _res, next) => {
      (req as any).authContext = {
        principal: null,
        workspace_id: null,
        is_workspace_member: false,
        permissions: [],
        is_operator_override: false,
        role_name: null,
      };
      next();
    });
    const eventService = {
      getProjectWorkspaceId: async () => 'workspace-a',
      listAfterId: async () => ({
        status: 'available' as const,
        truncated: false,
        events: [event({ card_title: 'resumed' }, { id: 'evt-resumed' })],
      }),
    } as unknown as EventService;
    app.use('/api/v1', createEventRouter(eventService, value));
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/projects/project-1/events/stream`, {
        headers: { 'Last-Event-ID': 'evt-cursor' },
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toContain('id: evt-resumed');
      value.close();
      await reader.cancel();
    } finally {
      value.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
