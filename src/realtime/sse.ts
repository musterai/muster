// File: src/realtime/sse.ts
import { Response } from 'express';
import { Event } from '../shared/types.js';

/** Operational limits for one process. They are deliberately finite so a
 * connection flood or a slow browser cannot turn the broadcaster into an
 * unbounded memory queue. */
export const DEFAULT_SSE_LIMITS = {
  maxGlobalClients: 100,
  maxPrincipalClients: 4,
  maxIpClients: 20,
  maxWorkspaceClients: 50,
  maxQueuedEvents: 100,
  maxQueuedBytes: 256 * 1024,
  backpressureTimeoutMs: 30_000,
  keepAliveIntervalMs: 10_000,
} as const;

export interface SSELimits {
  maxGlobalClients: number;
  maxPrincipalClients: number;
  maxIpClients: number;
  maxWorkspaceClients: number;
  maxQueuedEvents: number;
  maxQueuedBytes: number;
  backpressureTimeoutMs: number;
  keepAliveIntervalMs: number;
}

export interface SSEClientIdentity {
  principalId?: string | null;
  ip?: string | null;
  workspaceId?: string | null;
}

export type SSECapacityScope = 'global' | 'principal' | 'ip' | 'workspace';

export type SSEAddClientResult =
  | { accepted: true }
  | { accepted: false; scope: SSECapacityScope; retryAfterSeconds: number };

export interface SSEStats {
  activeClients: number;
  eventsSent: number;
  eventsDropped: number;
  clientsDropped: number;
  backpressureDrops: number;
  capacityRejections: number;
}

interface Client {
  id: string;
  projectId: string;
  principalId: string | null;
  ip: string | null;
  workspaceId: string | null;
  res: Response;
  queue: string[];
  queuedBytes: number;
  backpressured: boolean;
  slowTimer: NodeJS.Timeout | null;
  onDrain: () => void;
  onClose: () => void;
  onError: () => void;
  closed: boolean;
}

const SAFE_PAYLOAD_KEYS = new Set([
  'agent_id',
  'board_id',
  'card_key',
  'card_title',
  'claim_expires_at',
  'client_id',
  'column_id',
  'family_id',
  'from',
  'from_column_id',
  'from_column_name',
  'is_global',
  'key',
  'name',
  'operation',
  'permissions',
  'previously_claimed_by',
  'project_id',
  'reason',
  'to',
  'to_column_id',
  'to_column_name',
  'version',
  'via',
]);

const MAX_SAFE_STRING_LENGTH = 256;

function boundedValue(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, MAX_SAFE_STRING_LENGTH);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return value.slice(0, 32).map(item => item.slice(0, MAX_SAFE_STRING_LENGTH));
  }
  return undefined;
}

/**
 * The database-backed activity API remains the authorized detail surface.
 * SSE receives only an allowlisted, bounded projection so comment/document
 * bodies and arbitrary caller-provided fields never fan out to every client.
 */
export function toSSEEvent(event: Event): Event {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.payload || {})) {
    if (!SAFE_PAYLOAD_KEYS.has(key)) continue;
    const bounded = boundedValue(value);
    if (bounded !== undefined) payload[key] = bounded;
  }

  return {
    ...event,
    actor_name: typeof event.actor_name === 'string'
      ? event.actor_name.slice(0, MAX_SAFE_STRING_LENGTH)
      : event.actor_name,
    payload: Object.keys(payload).length > 0 ? payload : null,
  };
}

function frameEvent(event: Event): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(toSSEEvent(event))}\n\n`;
}

export class SSEManager {
  private clients: Client[] = [];
  private pingInterval: NodeJS.Timeout;
  private readonly limits: SSELimits;
  private readonly metrics: SSEStats = {
    activeClients: 0,
    eventsSent: 0,
    eventsDropped: 0,
    clientsDropped: 0,
    backpressureDrops: 0,
    capacityRejections: 0,
  };

  constructor(options: Partial<SSELimits> = {}) {
    this.limits = { ...DEFAULT_SSE_LIMITS, ...options };

    // Keep-alives are intentionally skipped while a client is backpressured;
    // they must not add work to an already bounded event queue.
    this.pingInterval = setInterval(() => {
      for (const client of [...this.clients]) {
        if (client.backpressured || client.queue.length > 0) continue;
        this.write(client, ': keep-alive\n\n', false);
      }
    }, this.limits.keepAliveIntervalMs);
    this.pingInterval.unref?.();
  }

  addClient(
    projectId: string,
    clientId: string,
    res: Response,
    identity: SSEClientIdentity = {},
  ): SSEAddClientResult {
    const principalId = identity.principalId || null;
    const ip = identity.ip || null;
    const workspaceId = identity.workspaceId || null;
    const rejection = this.capacityRejection(principalId, ip, workspaceId);
    if (rejection) {
      this.metrics.capacityRejections += 1;
      return rejection;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const client: Client = {
      id: clientId,
      projectId,
      principalId,
      ip,
      workspaceId,
      res,
      queue: [],
      queuedBytes: 0,
      backpressured: false,
      slowTimer: null,
      onDrain: () => this.flush(client),
      onClose: () => this.disconnect(client, false),
      onError: () => this.disconnect(client, false),
      closed: false,
    };
    this.clients.push(client);
    this.metrics.activeClients = this.clients.length;

    res.once('close', client.onClose);
    res.once('error', client.onError);
    return { accepted: true };
  }

  removeClient(clientId: string): void {
    const client = this.clients.find(candidate => candidate.id === clientId);
    if (client) this.disconnect(client, false);
  }

  broadcast(projectId: string, event: Event): void {
    const data = frameEvent(event);
    for (const client of [...this.clients]) {
      if (client.projectId === projectId) this.enqueue(client, data);
    }
  }

  getStats(): SSEStats {
    return { ...this.metrics, activeClients: this.clients.length };
  }

  close(): void {
    clearInterval(this.pingInterval);
    for (const client of [...this.clients]) {
      this.disconnect(client, true);
    }
    this.clients = [];
    this.metrics.activeClients = 0;
  }

  private capacityRejection(
    principalId: string | null,
    ip: string | null,
    workspaceId: string | null,
  ): Exclude<SSEAddClientResult, { accepted: true }> | null {
    let scope: SSECapacityScope | null = null;
    if (this.clients.length >= this.limits.maxGlobalClients) scope = 'global';
    else if (principalId && this.count(client => client.principalId === principalId) >= this.limits.maxPrincipalClients) scope = 'principal';
    else if (ip && this.count(client => client.ip === ip) >= this.limits.maxIpClients) scope = 'ip';
    else if (workspaceId && this.count(client => client.workspaceId === workspaceId) >= this.limits.maxWorkspaceClients) scope = 'workspace';
    if (!scope) return null;
    return { accepted: false, scope, retryAfterSeconds: Math.max(1, Math.ceil(this.limits.backpressureTimeoutMs / 1000)) };
  }

  private count(predicate: (client: Client) => boolean): number {
    return this.clients.reduce((total, client) => total + (predicate(client) ? 1 : 0), 0);
  }

  private enqueue(client: Client, data: string): void {
    if (client.closed) return;
    if (client.backpressured || client.queue.length > 0) {
      const bytes = Buffer.byteLength(data);
      if (
        client.queue.length >= this.limits.maxQueuedEvents ||
        client.queuedBytes + bytes > this.limits.maxQueuedBytes
      ) {
        this.metrics.eventsDropped += 1;
        this.metrics.backpressureDrops += 1;
        this.disconnect(client, true);
        return;
      }
      client.queue.push(data);
      client.queuedBytes += bytes;
      return;
    }
    this.write(client, data, true);
  }

  private write(client: Client, data: string, countEvent: boolean): void {
    if (client.closed) return;
    try {
      const writable = client.res.write(data);
      if (countEvent) this.metrics.eventsSent += 1;
      if (!writable) this.markBackpressured(client);
    } catch {
      if (countEvent) this.metrics.eventsDropped += 1;
      this.disconnect(client, true);
    }
  }

  private markBackpressured(client: Client): void {
    if (client.closed || client.backpressured) return;
    client.backpressured = true;
    client.res.once('drain', client.onDrain);
    client.slowTimer = setTimeout(() => {
      if (!client.closed && client.backpressured) {
        this.metrics.eventsDropped += client.queue.length;
        this.metrics.backpressureDrops += 1;
        this.disconnect(client, true);
      }
    }, this.limits.backpressureTimeoutMs);
    client.slowTimer.unref?.();
  }

  private flush(client: Client): void {
    if (client.closed) return;
    client.backpressured = false;
    if (client.slowTimer) clearTimeout(client.slowTimer);
    client.slowTimer = null;
    client.res.removeListener('drain', client.onDrain);

    while (client.queue.length > 0) {
      const data = client.queue.shift()!;
      client.queuedBytes -= Buffer.byteLength(data);
      try {
        const writable = client.res.write(data);
        this.metrics.eventsSent += 1;
        if (!writable) {
          this.markBackpressured(client);
          return;
        }
      } catch {
        this.metrics.eventsDropped += client.queue.length + 1;
        this.disconnect(client, true);
        return;
      }
    }
  }

  private disconnect(client: Client, endResponse: boolean): void {
    if (client.closed) return;
    client.closed = true;
    if (client.slowTimer) clearTimeout(client.slowTimer);
    client.slowTimer = null;
    client.res.removeListener('drain', client.onDrain);
    client.res.removeListener('close', client.onClose);
    client.res.removeListener('error', client.onError);
    this.clients = this.clients.filter(candidate => candidate !== client);
    this.metrics.activeClients = this.clients.length;
    if (endResponse) {
      try { client.res.end(); } catch { /* already closed */ }
      this.metrics.clientsDropped += 1;
    }
  }
}
