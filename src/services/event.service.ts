// File: src/services/event.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Event, CreateEvent } from '../shared/types.js';

export type EventCallback = (event: Event) => void | Promise<void>;

export interface EventResumeResult {
  /** `unavailable` covers malformed/stale/foreign cursors without disclosure. */
  status: 'available' | 'unavailable';
  events: Event[];
  truncated: boolean;
}

export class EventService {
  private listeners: EventCallback[] = [];

  constructor(
    private db: DatabaseAdapter,
    onEvent?: EventCallback
  ) {
    if (onEvent) {
      this.listeners.push(onEvent);
    }
  }

  on(callback: EventCallback): void {
    this.listeners.push(callback);
  }

  async getProjectWorkspaceId(projectId: string): Promise<string | null> {
    const rows = await this.db.query<{ workspace_id: string | null }>(
      'SELECT workspace_id FROM project WHERE id = ?',
      [projectId],
    );
    return rows[0]?.workspace_id || null;
  }

  /**
   * Return a bounded, project-scoped event tail after an existing event ID.
   * `event_order` is allocated by the database and defines the stable
   * Last-Event-ID successor relation. A cursor from another project, a
   * deleted event, or an otherwise stale cursor is intentionally
   * indistinguishable: callers receive an empty live-tail resume rather than
   * event metadata or an unbounded replay.
   */
  async listAfterId(projectId: string, eventId: string, limit = 100): Promise<EventResumeResult> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(100, Math.max(1, Math.floor(limit)))
      : 100;
    const cursor = await this.db.query<{ event_order: number | string | null }>(
      'SELECT event_order FROM event WHERE project_id = ? AND id = ? LIMIT 1',
      [projectId, eventId],
    );
    if (cursor.length === 0 || cursor[0].event_order === null || cursor[0].event_order === undefined) {
      return { status: 'unavailable', events: [], truncated: false };
    }
    const cursorOrder = Number(cursor[0].event_order);

    const rows = await this.db.query<any>(
      `SELECT e.*, COALESCE(a.name, u.display_name) as actor_name, p.kind as actor_kind
         FROM event e
         LEFT JOIN principal p ON e.actor_id = p.id
         LEFT JOIN agent a ON e.actor_id = a.id
         LEFT JOIN app_user u ON e.actor_id = u.id
        WHERE e.project_id = ? AND e.event_order > ?
        ORDER BY e.event_order ASC
        LIMIT ?`,
      [projectId, cursorOrder, boundedLimit + 1],
    );
    const truncated = rows.length > boundedLimit;
    return {
      status: 'available',
      truncated,
      events: rows.slice(0, boundedLimit).map(({ event_order: _eventOrder, ...r }) => ({
        ...r,
        payload: r.payload ? JSON.parse(r.payload) : null,
      })),
    };
  }

  /**
   * Persist through a transaction-scoped adapter when a domain mutation owns
   * one. The durable event and its sequence allocation share that boundary;
   * listener delivery is registered on the same adapter and therefore runs
   * only after the outer transaction commits.
   */
  async create(data: CreateEvent, transactionDb?: DatabaseAdapter): Promise<Event> {
    const id = ulid();
    const created_at = new Date().toISOString();
    const payload = data.payload ? JSON.stringify(data.payload) : null;

    const persist = async (tx: DatabaseAdapter): Promise<Event> => {
      const sequence = await tx.query<{ next_order: number | string }>(
        `SELECT next_order FROM event_order_sequence WHERE id = 1${tx.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
      );
      if (sequence.length === 0) throw new Error('Event order sequence is not initialized');
      const eventOrder = Number(sequence[0].next_order);
      await tx.execute(
        'UPDATE event_order_sequence SET next_order = next_order + 1 WHERE id = 1',
      );
      await tx.execute(
        `INSERT INTO event (id, project_id, entity_type, entity_id, action, actor_id, payload, created_at, event_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, data.project_id, data.entity_type, data.entity_id, data.action, data.actor_id || null, payload, created_at, eventOrder]
      );

      const event: Event = {
        id,
        project_id: data.project_id,
        entity_type: data.entity_type,
        entity_id: data.entity_id,
        action: data.action,
        actor_id: data.actor_id || null,
        payload: data.payload || null,
        created_at,
      };

      const notify = async (): Promise<void> => {
        for (const listener of this.listeners) {
          try {
            await listener(event);
          } catch (err) {
            console.error('Error in event listener:', err);
          }
        }
      };
      if (tx.afterCommit) await tx.afterCommit(notify);
      else await notify();
      return event;
    };

    // Root writes need one transaction for sequence allocation and insert;
    // nested callers already hold a scoped adapter and must join it rather
    // than queueing a second SQLite transaction or publishing early.
    return transactionDb ? persist(transactionDb) : this.db.transaction(persist);
  }

  async list(projectId: string, options: { entity_type?: string; entity_id?: string; since?: string; limit?: number } = {}): Promise<Event[]> {
    // LEFT JOINs both concrete principal tables so the activity feed can name
    // a human actor, not just an agent — see MUS-32.
    let sql = `SELECT e.*, COALESCE(a.name, u.display_name) as actor_name, p.kind as actor_kind
               FROM event e
               LEFT JOIN principal p ON e.actor_id = p.id
               LEFT JOIN agent a ON e.actor_id = a.id
               LEFT JOIN app_user u ON e.actor_id = u.id
               WHERE e.project_id = ?`;
    const params: unknown[] = [projectId];

    if (options.entity_type) {
      sql += ' AND e.entity_type = ?';
      params.push(options.entity_type);
    }

    if (options.entity_id) {
      sql += ' AND e.entity_id = ?';
      params.push(options.entity_id);
    }

    if (options.since) {
      sql += ' AND e.created_at >= ?';
      params.push(options.since);
    }

    sql += ' ORDER BY e.created_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const rows = await this.db.query<any>(sql, params);
    return rows.map(r => ({
      ...r,
      payload: r.payload ? JSON.parse(r.payload) : null,
    }));
  }
}
