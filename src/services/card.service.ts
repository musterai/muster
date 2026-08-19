import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Card, CardAssignee, CardDetails, CardSummary, CreateCard, UpdateCard, MoveCard, Label, Document, CardLinkRelationType, LinkedCardSummary, CardWorkLink, CreateCardWorkLink, ClaimRefusal, CardOperationOptions } from '../shared/types.js';
import { EventService } from './event.service.js';
import { isValidRankHint, rebalanceRanks } from '../shared/lexorank.js';
import { formatCardKey } from '../shared/card-key.js';
import { CardRuleError, ConflictError, NotFoundError, ValidationError } from '../shared/errors.js';
import { config } from '../config/index.js';
import { assertMaxLength, CARD_TEXT_MAX_CHARS } from '../shared/content-limits.js';
import { assertHttpUrl } from '../shared/url.js';
import { canonicalizeCardLink } from './helpers/card-links.helper.js';
import { resolveCardId } from './helpers/card-id.helper.js';
import type { AuthContext } from '../shared/auth-context.js';
import { PermissionDeniedError, WORKSPACE_READ } from '../shared/permission-enforcer.js';
import { assertActiveWorkspacePrincipal, assertAgentSelectorScope } from './agent-scope.authorization.js';
import { decodeCursor, encodeCursor, normalizePageLimit, Page, PageOptions, toPage } from '../shared/pagination.js';

const DEFAULT_CLAIM_TTL_SECONDS = 600;
const MAX_MOVE_RETRIES = 3;
const MOVE_RETRY_DELAY_MS = 10;

class MoveRetryError extends Error {
  constructor() {
    super('card changed lanes while its move was being serialized');
    this.name = 'MoveRetryError';
  }
}

function isRetryablePostgresError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === '40P01' || code === '40001';
}

interface ColumnCapacity {
  id: string;
  name: string;
  wip_limit: number | null;
  card_count: number;
  is_terminal: number;
}

interface UnresolvedBlocker {
  id: string;
  key: string;
  title: string;
  column_id: string;
  column_name: string;
}

export class CardService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService
  ) {}

  /**
   * Positions are a small, untrusted ordering hint. Digits are accepted only
   * for the historical `0a` prepend value; every persisted value is replaced
   * by a canonical lowercase rank during the lane rebalance below.
   */
  private assertPosition(position: string | undefined): void {
    if (position !== undefined && !isValidRankHint(position)) {
      throw new ValidationError('position must contain only lowercase letters a-z', {
        field: 'position',
        code: 'INVALID_RANK',
      });
    }
  }

  /**
   * A move must carry an explicit lane or rank intent. Without this guard an
   * omitted target defaults to the current lane and an omitted rank defaults
   * to append, silently turning an empty request into a reorder.
   *
   * REST and MCP reject invalid shapes at their boundaries. Keeping the
   * invariant here is deliberate: direct service callers and future
   * transports must not be able to mutate a card with `{}` either.
   */
  private assertMoveIntent(data: MoveCard): void {
    if (data.target_column_id === undefined && data.position === undefined) {
      throw new ValidationError('target_column_id or position is required', {
        fields: ['target_column_id', 'position'],
        code: 'MOVE_INTENT_REQUIRED',
      });
    }
    if (data.target_column_id !== undefined && (typeof data.target_column_id !== 'string' || data.target_column_id.trim().length === 0)) {
      throw new ValidationError('target_column_id must be a non-empty string', {
        field: 'target_column_id',
        code: 'INVALID_TARGET_COLUMN',
      });
    }
    if (data.position !== undefined && typeof data.position !== 'string') {
      throw new ValidationError('position must be a string', {
        field: 'position',
        code: 'INVALID_RANK',
      });
    }
    this.assertPosition(data.position);
  }

  private denyCardScope(auth: AuthContext): never {
    throw new PermissionDeniedError('card.assign_others', auth.role_name);
  }

  /**
   * Resolve a card only when it belongs to the credential-selected workspace.
   * Missing and cross-workspace references intentionally share one refusal so
   * callers cannot enumerate cards outside their workspace.
   */
  async assertCardWorkspaceScope(
    cardIdOrKey: string,
    auth: AuthContext | undefined,
    adapter: DatabaseAdapter = this.db,
  ): Promise<string> {
    if (config.auth.mode === 'open') {
      return resolveCardId(adapter, cardIdOrKey);
    }
    auth = await assertActiveWorkspacePrincipal(adapter, auth);

    const rows = await adapter.query<{ id: string; workspace_id: string }>(
      `SELECT c.id, p.workspace_id
       FROM card c
       JOIN "column" col ON col.id = c.column_id
       JOIN board b ON b.id = col.board_id
       JOIN project p ON p.id = b.project_id
       WHERE c.id = ? OR c.key = ?
       LIMIT 1`,
      [cardIdOrKey, cardIdOrKey],
    );
    if (rows.length === 0 || rows[0].workspace_id !== auth.workspace_id) {
      return this.denyCardScope(auth);
    }
    return rows[0].id;
  }

  /**
   * Resolve a move target only when its board belongs to the credential's
   * workspace. Missing and foreign column IDs deliberately produce the same
   * refusal so target selectors cannot be used for workspace enumeration.
   */
  async assertColumnWorkspaceScope(
    columnId: string,
    auth: AuthContext | undefined,
    adapter: DatabaseAdapter = this.db,
  ): Promise<string> {
    if (config.auth.mode === 'open') return columnId;
    auth = await assertActiveWorkspacePrincipal(adapter, auth);

    const rows = await adapter.query<{ id: string; workspace_id: string }>(
      `SELECT col.id, p.workspace_id
       FROM "column" col
       JOIN board b ON b.id = col.board_id
       JOIN project p ON p.id = b.project_id
       WHERE col.id = ?
       LIMIT 1`,
      [columnId],
    );
    if (rows.length === 0 || rows[0].workspace_id !== auth.workspace_id) {
      return this.denyCardScope(auth);
    }
    return rows[0].id;
  }

  /**
   * Enforce the assignment rule for update/move at the service boundary.
   * A user is in scope when assigned directly or through an agent they
   * operate; an agent is in scope only through its own live registration.
   */
  async assertCardMutationScope(
    cardIdOrKey: string,
    auth: AuthContext | undefined,
    adapter: DatabaseAdapter = this.db,
  ): Promise<string> {
    const cardId = await this.assertCardWorkspaceScope(cardIdOrKey, auth, adapter);
    if (config.auth.mode === 'open') return cardId;
    if (!auth?.principal) throw new PermissionDeniedError(WORKSPACE_READ, auth?.role_name || null);
    if (auth.permissions.includes('card.assign_others')) return cardId;

    let scopedPrincipalIds: string[] = [];
    if (auth.principal.kind === 'user') {
      const operated = await adapter.query<{ id: string }>(
        `SELECT id FROM agent
         WHERE operator_user_id = ? AND workspace_id = ?`,
        [auth.principal.id, auth.workspace_id],
      );
      scopedPrincipalIds = [auth.principal.id, ...operated.map(row => row.id)];
    } else {
      scopedPrincipalIds = [auth.principal.id];
    }

    if (scopedPrincipalIds.length === 0) return this.denyCardScope(auth);
    const placeholders = scopedPrincipalIds.map(() => '?').join(',');
    const assignments = await adapter.query<{ card_id: string }>(
      `SELECT card_id FROM card_assignee
       WHERE card_id = ? AND principal_id IN (${placeholders})
       LIMIT 1`,
      [cardId, ...scopedPrincipalIds],
    );
    if (assignments.length === 0) return this.denyCardScope(auth);
    return cardId;
  }

  /** Apply deterministic canonical ranks to an already ordered lane. */
  private async rebalanceLane(db: DatabaseAdapter, cards: Card[]): Promise<string[]> {
    const ranks = rebalanceRanks(cards.length);
    for (let index = 0; index < cards.length; index++) {
      await db.execute('UPDATE card SET position = ? WHERE id = ?', [ranks[index], cards[index].id]);
    }
    return ranks;
  }

  private async orderedLaneCards(columnId: string, db: DatabaseAdapter, excludeId?: string): Promise<Card[]> {
    const cards = await db.query<Card>(
      'SELECT * FROM card WHERE column_id = ? AND archived = 0 ORDER BY position ASC, id ASC',
      [columnId]
    );
    return excludeId ? cards.filter(card => card.id !== excludeId) : cards;
  }

  /** Insert a card according to its requested hint, repairing duplicate/legacy ranks at the same time. */
  private orderWithPosition(cards: Card[], card: Card, position?: string): Card[] {
    const ordered = [...cards];
    let insertAt = ordered.length;
    if (position !== undefined) {
      const index = ordered.findIndex(existing => existing.position > position);
      insertAt = index === -1 ? ordered.length : index;
    }
    ordered.splice(insertAt, 0, card);
    return ordered;
  }

  private async getColumnCapacity(columnId: string, db: DatabaseAdapter = this.db): Promise<ColumnCapacity> {
    // WIP checks run inside the create/move transaction. Lock the target
    // column row on Postgres so concurrent writers to the same lane cannot
    // both observe spare capacity and exceed the limit.
    if (db.dialect === 'postgres') {
      await db.query<{ id: string }>('SELECT id FROM "column" WHERE id = ? FOR UPDATE', [columnId]);
    }
    const rows = await db.query<{ id: string; name: string; wip_limit: number | null; card_count: number | string; is_terminal: number | string }>(
      `SELECT col.id, col.name, col.wip_limit, col.is_terminal, COUNT(c.id) AS card_count
       FROM "column" col
       LEFT JOIN card c ON c.column_id = col.id AND c.archived = 0
       WHERE col.id = ?
       GROUP BY col.id, col.name, col.wip_limit, col.is_terminal`,
      [columnId]
    );
    const row = rows[0];
    if (!row) throw new NotFoundError(`Column with ID ${columnId} not found`);
    return { ...row, card_count: Number(row.card_count), is_terminal: Number(row.is_terminal) };
  }

  private async getUnresolvedBlockers(cardId: string, db: DatabaseAdapter = this.db): Promise<UnresolvedBlocker[]> {
    return db.query<UnresolvedBlocker>(
      `SELECT blocker.id, blocker.key, blocker.title, blocker.column_id, blocker_column.name AS column_name
       FROM card_link link
       JOIN card blocker ON blocker.id = link.source_card_id
       JOIN "column" blocker_column ON blocker_column.id = blocker.column_id
       WHERE link.target_card_id = ?
         AND link.relation_type = 'blocks'
         AND blocker.archived = 0
         AND blocker_column.is_terminal = 0
       ORDER BY blocker.position ASC`,
      [cardId]
    );
  }

  private async recordOverride(
    projectId: string,
    cardId: string,
    actorId: string | undefined,
    operation: string,
    details: Record<string, unknown>,
    adapter: DatabaseAdapter = this.db,
  ): Promise<void> {
    if (!this.eventService) return;
    await this.eventService.create({
      project_id: projectId,
      entity_type: 'card',
      entity_id: cardId,
      action: 'override',
      actor_id: actorId,
      payload: { operation, ...details },
    }, adapter);
  }

  async create(data: CreateCard, actorId?: string, options: CardOperationOptions = {}): Promise<Card> {
    assertMaxLength(data.description, CARD_TEXT_MAX_CHARS, 'Card description');
    const id = ulid();
    const created_at = new Date().toISOString();
    const updated_at = created_at;

    const projectId = await this.getProjectIdForColumn(data.column_id);
    if (!projectId) throw new Error(`Column ${data.column_id} is not attached to a project`);
    const { card, wipViolation } = await this.db.transaction(async (tx) => {
      let wipViolation: ColumnCapacity | null = null;
      const capacity = await this.getColumnCapacity(data.column_id, tx);
      if (capacity.wip_limit !== null && capacity.card_count >= capacity.wip_limit) {
        wipViolation = capacity;
        if (!options.operatorOverride) {
          throw new CardRuleError(
            'CARD_WIP_LIMIT',
            `Column "${capacity.name}" is at its WIP limit (${capacity.card_count}/${capacity.wip_limit}); cannot create a card there without operator override.`,
            {
              rule: 'wip_limit',
              operation: 'create',
              column_id: capacity.id,
              column_name: capacity.name,
              current_count: capacity.card_count,
              wip_limit: capacity.wip_limit,
            },
          );
        }
      }

      const key = await this.nextCardKey(projectId, tx);
      this.assertPosition(data.position);

      const priority = data.priority || 'medium';
      const description = data.description || null;
      const due_date = data.due_date || null;
      const is_epic = data.is_epic ? 1 : 0;
      const existingCards = await this.orderedLaneCards(data.column_id, tx);
      const draftCard: Card = {
        id,
        key,
        column_id: data.column_id,
        title: data.title,
        description,
        position: 'm',
        priority,
        due_date,
        created_at,
        updated_at,
        archived: 0,
        claimed_by: null,
        claimed_at: null,
        claim_expires_at: null,
        is_epic,
      };
      const orderedCards = this.orderWithPosition(existingCards, draftCard, data.position);

      await tx.execute(
        `INSERT INTO card (id, key, column_id, title, description, position, priority, due_date, created_at, updated_at, archived, is_epic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [id, key, data.column_id, data.title, description, 'm', priority, due_date, created_at, updated_at, is_epic]
      );

      const ranks = await this.rebalanceLane(tx, orderedCards);
      const position = ranks[orderedCards.findIndex(card => card.id === id)];

      // Card associations and its domain event are part of the same commit
      // as the card row. A failure in a label/assignee insert must not leave a
      // partially-created card behind.
      for (const labelId of data.labels || []) {
        await tx.execute('INSERT OR IGNORE INTO card_label (card_id, label_id) VALUES (?, ?)', [id, labelId]);
      }
      for (const agentId of data.assignees || []) {
        await tx.execute('INSERT OR IGNORE INTO card_assignee (card_id, principal_id) VALUES (?, ?)', [id, agentId]);
      }
      if (this.eventService) {
        await this.eventService.create({
          project_id: projectId,
          entity_type: 'card',
          entity_id: id,
          action: 'created',
          actor_id: actorId,
          payload: { title: data.title, column_id: data.column_id },
        }, tx);
      }

      if (wipViolation && options.operatorOverride) {
        await this.recordOverride(projectId, id, actorId, 'create', {
          rule: 'wip_limit',
          column_id: wipViolation.id,
          column_name: wipViolation.name,
          current_count: wipViolation.card_count,
          wip_limit: wipViolation.wip_limit,
        }, tx);
      }

      return {
        card: {
          id,
          key,
          column_id: data.column_id,
          title: data.title,
          description,
          position,
          priority,
          due_date,
          created_at,
          updated_at,
          archived: 0,
          claimed_by: null,
          claimed_at: null,
          claim_expires_at: null,
          is_epic,
        } satisfies Card,
        wipViolation,
      };
    });

    return card;
  }

  /** Atomically claims the next per-project sequence number and formats it as e.g. "MUS-42". */
  private async nextCardKey(projectId: string, db: DatabaseAdapter = this.db): Promise<string> {
    const rows = await db.query<{ card_seq: number | string; key_prefix: string }>(
      `UPDATE project SET card_seq = card_seq + 1 WHERE id = ? RETURNING card_seq, key_prefix`,
      [projectId]
    );
    const row = rows[0];
    if (!row) throw new Error(`Project ${projectId} not found`);
    return formatCardKey(row.key_prefix, Number(row.card_seq));
  }

  /**
   * `db` defaults to the pool-backed `this.db` for ordinary callers, but
   * every caller inside an open `this.db.transaction(tx => ...)` callback
   * (e.g. claim()) must pass `tx` explicitly. On SQLite there's only ever
   * one physical connection, so reaching back into `this.db` from inside a
   * transaction works by accident; on Postgres it asks the pool for another
   * connection while the transaction's own connection is still checked out,
   * and if every pool connection is meanwhile blocked on this same row's
   * lock (as under concurrent claim() calls), that request queues forever —
   * a self-inflicted deadlock. Found via MUS-31's concurrent-claim test.
   *
   * `idOrKey` may be either the card ULID or its human-readable key (e.g.
   * "MUS-49"). Keys are how humans reference cards, and agents are routinely
   * handed them ("pick up MUS-49") without the ULID. Resolving both here means
   * every caller — the MCP `get_card` tool, the REST `GET /cards/:id` route,
   * and the frontend — accepts either form without duplicating the lookup.
   */
  async getById(idOrKey: string, db: DatabaseAdapter = this.db): Promise<CardDetails> {
    const cardRows = await db.query<Card>('SELECT * FROM card WHERE id = ? OR key = ?', [idOrKey, idOrKey]);
    const card = cardRows[0];
    if (!card) throw new Error(`Card with ID ${idOrKey} not found`);

    const id = card.id;

    // LEFT JOINs both concrete principal tables — an assignee may be an agent
    // or a human app_user, and only one of the two joins will match per row.
    // A human's status is never surfaced (liveness is agent-only telemetry).
    const assignees = await db.query<CardAssignee>(
      `SELECT p.id, COALESCE(a.name, u.display_name) as name, p.kind, a.status FROM card_assignee ca
       JOIN principal p ON p.id = ca.principal_id
       LEFT JOIN agent a ON a.id = p.id
       LEFT JOIN app_user u ON u.id = p.id
       WHERE ca.card_id = ?`,
      [id]
    );

    const labels = await db.query<Label>(
      `SELECT l.* FROM label l
       JOIN card_label cl ON l.id = cl.label_id
       WHERE cl.card_id = ?`,
      [id]
    );

    const comments = await db.query<any>(
      `SELECT c.*, COALESCE(a.name, u.display_name) as author_name, p.kind as author_kind FROM comment c
       LEFT JOIN principal p ON c.author_id = p.id
       LEFT JOIN agent a ON c.author_id = a.id
       LEFT JOIN app_user u ON c.author_id = u.id
       WHERE c.card_id = ? ORDER BY c.created_at ASC`,
      [id]
    );

    // Deliberately excludes d.content — a design doc body can run tens of KB,
    // and every card mutation (create/move/link/assign/...) round-trips this
    // list via getById(). Full content is one getDocument call away.
    const linked_documents = await db.query<Omit<Document, 'content'>>(
      `SELECT d.id, d.project_id, d.parent_id, d.title, d.status, d.author_id, d.version, d.created_at, d.updated_at
       FROM document d
       JOIN card_document cd ON d.id = cd.document_id
       WHERE cd.card_id = ?
       ORDER BY cd.linked_at ASC`,
      [id]
    );

    const linked_cards = await this.getLinkedCards(id, db);
    const work_links = await this.listWorkLinks(id, db);
    const epic_progress = card.is_epic
      ? await this.getEpicProgress(linked_cards, db)
      : null;

    return {
      ...card,
      assignees: assignees.map(a => ({
        id: a.id,
        name: a.name,
        kind: (a.kind || 'agent') as 'user' | 'agent',
        status: a.kind === 'agent' ? (a.status || 'offline') : null,
      })),
      labels,
      comments,
      linked_documents,
      linked_cards,
      work_links,
      epic_progress,
    };
  }

  /**
   * "6 of 13 done" for an Epic. Deliberately scoped to the single-card
   * detail path (getById), not the board list — computing this per card on
   * a board fetch would be an N+1 query for every board with an Epic on it.
   * Children come from `linked_cards` (already fetched for this call), not
   * a fresh query. Zero children returns null rather than "0/0" — an empty
   * Epic hasn't been broken down yet, which reads differently from "not
   * started".
   */
  private async getEpicProgress(
    linkedCards: LinkedCardSummary[],
    db: DatabaseAdapter
  ): Promise<{ total: number; done: number } | null> {
    const children = linkedCards.filter(l => l.relation_type === 'parent_of');
    if (children.length === 0) return null;

    const columnIds = [...new Set(children.map(c => c.card.column_id))];
    const placeholders = columnIds.map(() => '?').join(', ');
    const terminalRows = await db.query<{ id: string }>(
      `SELECT id FROM "column" WHERE is_terminal = 1 AND id IN (${placeholders})`,
      columnIds
    );
    const terminalColumnIds = new Set(terminalRows.map(r => r.id));
    const done = children.filter(c => terminalColumnIds.has(c.card.column_id)).length;

    return { total: children.length, done };
  }

  private async getLinkedCards(cardId: string, db: DatabaseAdapter = this.db): Promise<LinkedCardSummary[]> {
    type LinkRow = { id: string; relation_type: string; other_id: string; other_key: string; other_title: string; other_column_id: string; other_column_name: string; other_priority: string; other_archived: number };

    const outgoing = await db.query<LinkRow>(
      `SELECT cl.id, cl.relation_type, c.id as other_id, c.key as other_key, c.title as other_title, c.column_id as other_column_id, col.name as other_column_name, c.priority as other_priority, c.archived as other_archived
       FROM card_link cl JOIN card c ON c.id = cl.target_card_id
       JOIN "column" col ON col.id = c.column_id
       WHERE cl.source_card_id = ?`,
      [cardId]
    );

    const incoming = await db.query<LinkRow>(
      `SELECT cl.id, cl.relation_type, c.id as other_id, c.key as other_key, c.title as other_title, c.column_id as other_column_id, col.name as other_column_name, c.priority as other_priority, c.archived as other_archived
       FROM card_link cl JOIN card c ON c.id = cl.source_card_id
       JOIN "column" col ON col.id = c.column_id
       WHERE cl.target_card_id = ?`,
      [cardId]
    );

    const toSummary = (row: LinkRow, relation_type: CardLinkRelationType): LinkedCardSummary => ({
      id: row.id,
      relation_type,
      card: {
        id: row.other_id,
        key: row.other_key,
        title: row.other_title,
        column_id: row.other_column_id,
        column_name: row.other_column_name,
        priority: row.other_priority as LinkedCardSummary['card']['priority'],
        archived: row.other_archived,
      },
    });

    const incomingLabel = (stored: string): CardLinkRelationType => {
      if (stored === 'blocks') return 'blocked_by';
      if (stored === 'parent_of') return 'child_of';
      return stored as CardLinkRelationType;
    };

    return [
      ...outgoing.map(r => toSummary(r, r.relation_type as CardLinkRelationType)),
      ...incoming.map(r => toSummary(r, incomingLabel(r.relation_type))),
    ];
  }

  async list(filters: { column_id?: string; board_id?: string; project_id?: string; assignee_id?: string; label?: string; archived?: boolean } = {}): Promise<Card[]> {
    let sql = 'SELECT DISTINCT c.*, col.board_id AS board_id, b.name AS board_name, b.slug AS board_slug FROM card c JOIN "column" col ON c.column_id = col.id JOIN board b ON col.board_id = b.id';
    const joins: string[] = [];
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.board_id) {
      conditions.push('col.board_id = ?');
      params.push(filters.board_id);
    }

    if (filters.project_id) {
      conditions.push('b.project_id = ?');
      params.push(filters.project_id);
    }

    if (filters.column_id) {
      conditions.push('c.column_id = ?');
      params.push(filters.column_id);
    }

    if (filters.assignee_id) {
      joins.push('JOIN card_assignee ca ON c.id = ca.card_id');
      conditions.push('ca.principal_id = ?');
      params.push(filters.assignee_id);
    }

    if (filters.label) {
      joins.push('JOIN card_label cl ON c.id = cl.card_id JOIN label l ON cl.label_id = l.id');
      conditions.push('(l.id = ? OR l.name = ?)');
      params.push(filters.label, filters.label);
    }

    if (filters.archived !== undefined) {
      conditions.push('c.archived = ?');
      params.push(filters.archived ? 1 : 0);
    } else {
      conditions.push('c.archived = 0');
    }

    if (joins.length > 0) {
      sql += ' ' + joins.join(' ');
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY c.position ASC';

    const cards = await this.db.query<Card>(sql, params);
    if (cards.length === 0) return cards;

    const placeholders = cards.map(() => '?').join(', ');
    const assigneeRows = await this.db.query<CardAssignee & { card_id: string }>(
      `SELECT ca.card_id, p.id, COALESCE(a.name, u.display_name) as name, p.kind, a.status
       FROM card_assignee ca
       JOIN principal p ON ca.principal_id = p.id
       LEFT JOIN agent a ON a.id = p.id
       LEFT JOIN app_user u ON u.id = p.id
       WHERE ca.card_id IN (${placeholders})
       ORDER BY name ASC`,
      cards.map(card => card.id)
    );

    const assigneesByCard = new Map<string, CardAssignee[]>();
    for (const assignee of assigneeRows) {
      const cardAssignees = assigneesByCard.get(assignee.card_id) || [];
      cardAssignees.push({
        id: assignee.id,
        name: assignee.name,
        kind: (assignee.kind || 'agent') as 'user' | 'agent',
        status: assignee.kind === 'agent' ? assignee.status : null,
      });
      assigneesByCard.set(assignee.card_id, cardAssignees);
    }

    const parentLinkRows = await this.db.query<{
      child_id: string;
      parent_id: string;
      parent_key: string;
      parent_title: string;
    }>(
      `SELECT cl.target_card_id AS child_id, parent.id AS parent_id, parent.key AS parent_key, parent.title AS parent_title
       FROM card_link cl
       JOIN card parent ON parent.id = cl.source_card_id
       WHERE cl.relation_type = 'parent_of' AND cl.target_card_id IN (${placeholders})`,
      cards.map(card => card.id)
    );

    const parentEpicByChild = new Map<string, { id: string; key: string; title: string }>();
    for (const row of parentLinkRows) {
      parentEpicByChild.set(row.child_id, { id: row.parent_id, key: row.parent_key, title: row.parent_title });
    }

    return cards.map(card => {
      const parentEpic = parentEpicByChild.get(card.id);
      return {
        ...card,
        assignees: assigneesByCard.get(card.id) || [],
        parent_epic_id: parentEpic ? parentEpic.id : null,
        parent_epic_key: parentEpic ? parentEpic.key : null,
        parent_epic_title: parentEpic ? parentEpic.title : null,
      };
    });
  }

  /**
   * Bounded collection read used by REST/MCP. Card descriptions are never
   * copied into a board/list response; callers fetch one card's detail when
   * they open it. Ordering is a strict `(position, id)` keyset.
   */
  async listPage(
    filters: { column_id?: string; board_id?: string; project_id?: string; assignee_id?: string; label?: string; archived?: boolean } = {},
    options: PageOptions = {},
  ): Promise<Page<CardSummary>> {
    const limit = normalizePageLimit(options.limit);
    const scope = `cards:${JSON.stringify({
      column_id: filters.column_id || null,
      board_id: filters.board_id || null,
      project_id: filters.project_id || null,
      assignee_id: filters.assignee_id || null,
      label: filters.label || null,
      archived: filters.archived ?? false,
    })}`;
    const cursor = decodeCursor(options.cursor, scope, 2);
    let sql = `SELECT DISTINCT c.id, c.key, c.column_id, c.title, c.position,
      c.priority, c.due_date, c.created_at, c.updated_at, c.archived,
      c.claimed_by, c.claimed_at, c.claim_expires_at, c.is_epic,
      col.board_id AS board_id, b.name AS board_name, b.slug AS board_slug
      FROM card c JOIN "column" col ON c.column_id = col.id JOIN board b ON col.board_id = b.id`;
    const joins: string[] = [];
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.board_id) { conditions.push('col.board_id = ?'); params.push(filters.board_id); }
    if (filters.project_id) { conditions.push('b.project_id = ?'); params.push(filters.project_id); }
    if (filters.column_id) { conditions.push('c.column_id = ?'); params.push(filters.column_id); }
    if (filters.assignee_id) {
      joins.push('JOIN card_assignee ca ON c.id = ca.card_id');
      conditions.push('ca.principal_id = ?');
      params.push(filters.assignee_id);
    }
    if (filters.label) {
      joins.push('JOIN card_label cl ON c.id = cl.card_id JOIN label l ON cl.label_id = l.id');
      conditions.push('(l.id = ? OR l.name = ?)');
      params.push(filters.label, filters.label);
    }
    conditions.push('c.archived = ?');
    params.push(filters.archived ? 1 : 0);
    if (cursor) {
      conditions.push('(c.position > ? OR (c.position = ? AND c.id > ?))');
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    if (joins.length) sql += ` ${joins.join(' ')}`;
    sql += ` WHERE ${conditions.join(' AND ')} ORDER BY c.position ASC, c.id ASC LIMIT ?`;
    params.push(limit + 1);

    const rows = await this.db.query<CardSummary>(sql, params);
    const visibleRows = rows.slice(0, limit);
    if (visibleRows.length > 0) await this.hydrateCardSummaries(visibleRows);
    return toPage(rows.map((row, index) => index < visibleRows.length ? visibleRows[index] : row), limit,
      row => encodeCursor(scope, [row.position, row.id]));
  }

  private async hydrateCardSummaries(cards: CardSummary[]): Promise<void> {
    const placeholders = cards.map(() => '?').join(', ');
    const ids = cards.map(card => card.id);
    const assigneeRows = await this.db.query<CardAssignee & { card_id: string }>(
      `SELECT ca.card_id, p.id, COALESCE(a.name, u.display_name) as name, p.kind, a.status
       FROM card_assignee ca
       JOIN principal p ON ca.principal_id = p.id
       LEFT JOIN agent a ON a.id = p.id
       LEFT JOIN app_user u ON u.id = p.id
       WHERE ca.card_id IN (${placeholders}) ORDER BY name ASC`, ids,
    );
    const assigneesByCard = new Map<string, CardAssignee[]>();
    for (const row of assigneeRows) {
      const values = assigneesByCard.get(row.card_id) || [];
      values.push({ id: row.id, name: row.name, kind: (row.kind || 'agent') as 'user' | 'agent', status: row.kind === 'agent' ? row.status : null });
      assigneesByCard.set(row.card_id, values);
    }
    const parentRows = await this.db.query<{ child_id: string; parent_id: string; parent_key: string; parent_title: string }>(
      `SELECT cl.target_card_id AS child_id, parent.id AS parent_id, parent.key AS parent_key, parent.title AS parent_title
       FROM card_link cl JOIN card parent ON parent.id = cl.source_card_id
       WHERE cl.relation_type = 'parent_of' AND cl.target_card_id IN (${placeholders})`, ids,
    );
    const parentByChild = new Map(parentRows.map(row => [row.child_id, row]));
    for (const card of cards) {
      card.assignees = assigneesByCard.get(card.id) || [];
      const parent = parentByChild.get(card.id);
      card.parent_epic_id = parent?.parent_id || null;
      card.parent_epic_key = parent?.parent_key || null;
      card.parent_epic_title = parent?.parent_title || null;
    }
  }

  async update(id: string, data: UpdateCard, actorId?: string, options: CardOperationOptions = {}): Promise<CardDetails> {
    assertMaxLength(data.description, CARD_TEXT_MAX_CHARS, 'Card description');
    return this.db.transaction(async tx => {
      const cardId = await this.assertCardMutationScope(id, options.auth, tx);
      const existing = await this.getById(cardId, tx);
      const title = data.title !== undefined ? data.title : existing.title;
      const description = data.description !== undefined ? data.description : existing.description;
      const priority = data.priority !== undefined ? data.priority : existing.priority;
      const due_date = data.due_date !== undefined ? data.due_date : existing.due_date;
      const is_epic = data.is_epic !== undefined ? (data.is_epic ? 1 : 0) : existing.is_epic;
      const updated_at = new Date().toISOString();

      await tx.execute(
        `UPDATE card SET title = ?, description = ?, priority = ?, due_date = ?, is_epic = ?, updated_at = ? WHERE id = ?`,
        [title, description, priority, due_date, is_epic, updated_at, cardId]
      );

      if (this.eventService) {
        const projectId = await this.getProjectIdForColumn(existing.column_id, tx);
        if (projectId) {
          await this.eventService.create({
            project_id: projectId,
            entity_type: 'card',
            entity_id: cardId,
            action: 'updated',
            actor_id: actorId,
            payload: data as Record<string, unknown>,
          }, tx);
        }
      }

      return this.getById(cardId, tx);
    });
  }

  async move(id: string, data: MoveCard, actorId?: string, options: CardOperationOptions = {}): Promise<CardDetails> {
    // Validate before resolving the card or opening a transaction so an empty
    // move is observably a no-op across every caller.
    this.assertMoveIntent(data);
    const cardId = config.auth.mode === 'enforced'
      ? await this.assertCardMutationScope(id, options.auth)
      : await resolveCardId(this.db, id);
    let completed = false;
    for (let attempt = 0; attempt < MAX_MOVE_RETRIES; attempt++) {
      try {
        await this.db.transaction(async (tx) => {
      const overrideRules: Array<Record<string, unknown>> = [];
      let moveEvent: {
        projectId: string;
        fromColumnId: string;
        toColumnId: string;
        position: string;
        isColumnChange: boolean;
        toTerminal: boolean;
        toColumnName: string;
        cardKey: string;
        cardTitle: string;
      } | null = null;
      // Read the source without locking, acquire every lane lock in canonical
      // order, then lock the card. Every writer that rewrites lane peers uses
      // this lane-before-card protocol; it prevents card/column wait cycles.
      const initialRows = await tx.query<{ column_id: string }>('SELECT column_id FROM card WHERE id = ?', [cardId]);
      const initial = initialRows[0];
      if (!initial) throw new NotFoundError(`Card with ID ${cardId} not found`);
      await this.assertCardMutationScope(cardId, options.auth, tx);
      const initialTarget = data.target_column_id ?? initial.column_id;
      // The target selector is independently scoped on every serialization
      // attempt. Do this before lane locks, capacity reads, rank rewrites, or
      // events so a missing/foreign target is an observable no-op.
      await this.assertColumnWorkspaceScope(initialTarget, options.auth, tx);
      if (tx.dialect === 'postgres') {
        const laneIds = [...new Set([initial.column_id, initialTarget])].sort();
        for (const laneId of laneIds) {
          await tx.query<{ id: string }>('SELECT id FROM "column" WHERE id = ? FOR UPDATE', [laneId]);
        }
      }

      const lockClause = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
      const rows = await tx.query<Card>(`SELECT * FROM card WHERE id = ?${lockClause}`, [cardId]);
      const existing = rows[0];
      if (!existing) throw new NotFoundError(`Card with ID ${cardId} not found`);
      if (tx.dialect === 'postgres' && existing.column_id !== initial.column_id) throw new MoveRetryError();

      const target_column_id = data.target_column_id ?? existing.column_id;

      const capacity = await this.getColumnCapacity(target_column_id, tx);
      const isColumnChange = target_column_id !== existing.column_id;

      if (isColumnChange && capacity.wip_limit !== null && capacity.card_count >= capacity.wip_limit) {
        const details = {
          rule: 'wip_limit',
          operation: 'move',
          column_id: capacity.id,
          column_name: capacity.name,
          current_count: capacity.card_count,
          wip_limit: capacity.wip_limit,
        };
        if (!options.operatorOverride) {
          throw new CardRuleError(
            'CARD_WIP_LIMIT',
            `Column "${capacity.name}" is at its WIP limit (${capacity.card_count}/${capacity.wip_limit}); cannot move this card there without operator override.`,
            details,
          );
        }
        overrideRules.push(details);
      }

      if (isColumnChange && capacity.name.trim().toLowerCase() === 'in progress') {
        const blockers = await this.getUnresolvedBlockers(cardId, tx);
        if (blockers.length > 0) {
          const details = {
            rule: 'blocked_by',
            operation: 'move',
            blockers: blockers.map(blocker => ({ ...blocker })),
          };
          if (!options.operatorOverride) {
            const blockerSummary = blockers.map(blocker => `${blocker.key} "${blocker.title}"`).join(', ');
            throw new CardRuleError(
              'CARD_BLOCKED',
              `Cannot move this card into "${capacity.name}" while it is blocked by ${blockerSummary}. Resolve the blocking cards or use operator override.`,
              details,
            );
          }
          overrideRules.push(details);
        }
      }

      const targetCards = await this.orderedLaneCards(target_column_id, tx, cardId);
      const movedCard: Card = { ...existing, column_id: target_column_id, position: 'm' };
      const orderedTargetCards = this.orderWithPosition(targetCards, movedCard, data.position);
      const targetRanks = await this.rebalanceLane(tx, orderedTargetCards);
      const movedIndex = orderedTargetCards.findIndex(card => card.id === cardId);
      const position = targetRanks[movedIndex];

      // A cross-lane move repairs the source lane in the same transaction.
      // The moved card is excluded above, so no association or card row is
      // lost while both lanes receive deterministic, unique ranks.
      if (isColumnChange) {
        const sourceCards = await this.orderedLaneCards(existing.column_id, tx, cardId);
        await this.rebalanceLane(tx, sourceCards);
      }

      const updated_at = new Date().toISOString();
      await tx.execute(
        `UPDATE card SET column_id = ?, position = ?, updated_at = ? WHERE id = ?`,
        [target_column_id, position, updated_at, cardId]
      );

      const projectId = await this.getProjectIdForColumn(target_column_id, tx);
      if (!projectId) throw new Error(`Column ${target_column_id} is not attached to a project`);
      moveEvent = {
        projectId,
        fromColumnId: existing.column_id,
        toColumnId: target_column_id,
        position,
        isColumnChange,
        toTerminal: capacity.is_terminal === 1,
        toColumnName: capacity.name,
        cardKey: existing.key,
        cardTitle: existing.title,
      };

      if (this.eventService) {
        await this.eventService.create({
          project_id: projectId,
          entity_type: 'card',
          entity_id: cardId,
          action: 'moved',
          actor_id: actorId,
          payload: {
            from_column_id: moveEvent.fromColumnId,
            to_column_id: moveEvent.toColumnId,
            position: moveEvent.position,
          },
        }, tx);

        // MUS-45: a card landing in a terminal (Done) lane is a completion.
        // Keep this event in the same transaction as the card move so a
        // failed completion insert cannot leave a durable move without its
        // corresponding audit trail.
        if (moveEvent.isColumnChange && moveEvent.toTerminal) {
          await this.eventService.create({
            project_id: moveEvent.projectId,
            entity_type: 'card',
            entity_id: cardId,
            action: 'completed',
            actor_id: actorId,
            payload: {
              card_key: moveEvent.cardKey,
              card_title: moveEvent.cardTitle,
              from_column_id: moveEvent.fromColumnId,
              to_column_id: moveEvent.toColumnId,
              to_column_name: moveEvent.toColumnName,
            },
          }, tx);
        }
      }

      if (overrideRules.length > 0) {
        await this.recordOverride(moveEvent.projectId, cardId, actorId, 'move', { rules: overrideRules }, tx);
      }

        });
        completed = true;
        break;
      } catch (error) {
        const retryable = this.db.dialect === 'postgres' && (error instanceof MoveRetryError || isRetryablePostgresError(error));
        if (!retryable || attempt === MAX_MOVE_RETRIES - 1) {
          if (retryable) {
            throw new ConflictError('Card move conflicted with concurrent lane changes; retry the move.', {
              operation: 'move',
              retryable: true,
            });
          }
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, MOVE_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
    if (!completed) throw new ConflictError('Card move could not be serialized; retry the move.', { retryable: true });

    return this.getById(cardId);
  }

  async assign(idOrKey: string, agentId: string, actorId?: string, auth?: AuthContext): Promise<void> {
    await this.db.transaction(async tx => {
      const cardId = config.auth.mode === 'enforced'
        ? await this.assertCardWorkspaceScope(idOrKey, auth, tx)
        : await resolveCardId(tx, idOrKey);
      await assertAgentSelectorScope(tx, agentId, auth, 'card.assign_others');
      const result = await tx.execute(
        `INSERT OR IGNORE INTO card_assignee (card_id, principal_id) VALUES (?, ?)`,
        [cardId, agentId]
      );

      if (this.eventService && result.changes > 0) {
        const card = await this.getById(cardId, tx);
        const projectId = await this.getProjectIdForColumn(card.column_id, tx);
        if (projectId) {
          await this.eventService.create({
            project_id: projectId,
            entity_type: 'card',
            entity_id: cardId,
            action: 'assigned',
            actor_id: actorId,
            payload: { agent_id: agentId },
          }, tx);
        }
      }
    });
  }

  async unassign(idOrKey: string, agentId: string, actorId?: string, auth?: AuthContext): Promise<void> {
    await this.db.transaction(async tx => {
      const cardId = config.auth.mode === 'enforced'
        ? await this.assertCardWorkspaceScope(idOrKey, auth, tx)
        : await resolveCardId(tx, idOrKey);
      await assertAgentSelectorScope(tx, agentId, auth, 'card.assign_others');
      await tx.execute(
        `DELETE FROM card_assignee WHERE card_id = ? AND principal_id = ?`,
        [cardId, agentId]
      );
    });
  }

  /**
   * Atomically claim a card: succeeds only if unclaimed, held by the same agent,
   * or the existing lease has expired. Runs as a compare-and-swap inside a
   * transaction so two concurrent claims can never both succeed.
   */
  async claim(
    cardId: string,
    agentId: string,
    ttlSeconds: number = DEFAULT_CLAIM_TTL_SECONDS,
    actorId?: string,
    options: CardOperationOptions = {},
  ): Promise<CardDetails | ClaimRefusal> {
    const canonicalCardId = config.auth.mode === 'enforced'
      ? await this.assertCardWorkspaceScope(cardId, options.auth)
      : await resolveCardId(this.db, cardId);
    let overrideBlockers: UnresolvedBlocker[] = [];

    const result = await this.db.transaction(async (tx) => {
      // Read-check-write is only atomic if nothing else can write the row
      // between the read and the write. On SQLite that's true by accident —
      // better-sqlite3 is one connection and BEGIN IMMEDIATE serializes every
      // transaction globally. Postgres's connection pool has no such
      // accident: two concurrent claim() calls can both SELECT the same
      // unclaimed card before either UPDATEs it. FOR UPDATE closes that
      // window by blocking a second transaction's SELECT until the first
      // commits or rolls back. SQLite doesn't recognize FOR UPDATE as syntax
      // at all, so this must stay conditional rather than portable SQL —
      // see DatabaseAdapter.dialect's doc comment for why that's the
      // deliberate exception rather than the norm.
      const lockClause = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
      const rows = await tx.query<Card>(`SELECT * FROM card WHERE id = ?${lockClause}`, [canonicalCardId]);
      const card = rows[0];
      if (!card) throw new NotFoundError(`Card with ID ${canonicalCardId} not found`);
      await this.assertCardWorkspaceScope(canonicalCardId, options.auth, tx);
      await assertAgentSelectorScope(tx, agentId, options.auth, 'card.assign_others');

      const now = new Date();
      const nowIso = now.toISOString();
      const heldByOther = card.claimed_by && card.claimed_by !== agentId
        && card.claim_expires_at && card.claim_expires_at > nowIso;

      if (heldByOther) {
        const holderRows = await tx.query<{ name: string }>(
          'SELECT a.name FROM agent a JOIN principal p ON a.id = p.id WHERE p.id = ?',
          [card.claimed_by]
        );
        const refusal: ClaimRefusal = {
          success: false,
          reason: 'already_claimed',
          card_id: canonicalCardId,
          held_by: { id: card.claimed_by as string, name: holderRows[0]?.name ?? null },
          claim_expires_at: card.claim_expires_at as string,
        };
        return refusal;
      }

      const blockers = await this.getUnresolvedBlockers(canonicalCardId, tx);
      if (blockers.length > 0) {
        if (!options.operatorOverride) {
          const blockerSummary = blockers.map(blocker => `${blocker.key} "${blocker.title}"`).join(', ');
          throw new CardRuleError(
            'CARD_BLOCKED',
            `Cannot claim this card while it is blocked by ${blockerSummary}. Resolve the blocking cards or use operator override.`,
            {
              rule: 'blocked_by',
              operation: 'claim',
              blockers: blockers.map(blocker => ({ ...blocker })),
            },
          );
        }
        overrideBlockers = blockers;
      }

      const expiresIso = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      await tx.execute(
        `UPDATE card SET claimed_by = ?, claimed_at = ?, claim_expires_at = ?, updated_at = ? WHERE id = ?`,
        [agentId, nowIso, expiresIso, nowIso, canonicalCardId]
      );
      await tx.execute(
        `INSERT OR IGNORE INTO card_assignee (card_id, principal_id) VALUES (?, ?)`,
        [canonicalCardId, agentId]
      );

      if (this.eventService) {
        const projectId = await this.getProjectIdForColumn(card.column_id, tx);
        if (projectId) {
          await this.eventService.create({
            project_id: projectId,
            entity_type: 'card',
            entity_id: canonicalCardId,
            action: 'claimed',
            actor_id: agentId,
            payload: { claim_expires_at: expiresIso },
          }, tx);
          if (overrideBlockers.length > 0) {
            await this.recordOverride(projectId, canonicalCardId, actorId || agentId, 'claim', {
              rule: 'blocked_by',
              blockers: overrideBlockers.map(blocker => ({ ...blocker })),
            }, tx);
          }
        }
      }

      return this.getById(canonicalCardId, tx);
    });

    return result;
  }

  /** Extend the claim lease on every card currently held by this agent — called on heartbeat. */
  async renewClaims(agentId: string, ttlSeconds: number = DEFAULT_CLAIM_TTL_SECONDS): Promise<void> {
    const expiresIso = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await this.db.execute(
      `UPDATE card SET claim_expires_at = ? WHERE claimed_by = ?`,
      [expiresIso, agentId]
    );
  }

  /** Release leases past their expiry so the board doesn't hold a card forever for a dead agent. */
  async releaseExpiredLeases(adapter?: DatabaseAdapter): Promise<string[]> {
    if (!adapter) return this.db.transaction(tx => this.releaseExpiredLeases(tx));

    const nowIso = new Date().toISOString();
    // The transaction boundary serializes SQLite sweepers (BEGIN IMMEDIATE).
    // PostgreSQL needs row locks because independent pool clients can sweep
    // concurrently; the expiry predicate is re-evaluated after any waiter is
    // released, so a second sweeper sees the first one's conditional update.
    const lockClause = adapter.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const expired = await adapter.query<Card>(
      `SELECT * FROM card WHERE claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?${lockClause}`,
      [nowIso]
    );
    const released: string[] = [];

    for (const card of expired) {
      const updated_at = new Date().toISOString();
      const result = await adapter.execute(
        `UPDATE card SET claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = ?
         WHERE id = ? AND claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`,
        [updated_at, card.id, nowIso]
      );
      // Keep the event and the state transition in this transaction. A
      // concurrent sweeper that lost the conditional update emits nothing.
      if (result.changes !== 1) continue;
      released.push(card.id);

      if (this.eventService) {
        const projectId = await this.getProjectIdForColumn(card.column_id, adapter);
        if (projectId) {
          await this.eventService.create({
            project_id: projectId,
            entity_type: 'card',
            entity_id: card.id,
            action: 'claim_expired',
            payload: { previously_claimed_by: card.claimed_by },
          }, adapter);
        }
      }
    }

    return released;
  }

  async addLabel(idOrKey: string, labelId: string, actorId?: string): Promise<void> {
    const cardId = await resolveCardId(this.db, idOrKey);
    await this.db.execute(
      `INSERT OR IGNORE INTO card_label (card_id, label_id) VALUES (?, ?)`,
      [cardId, labelId]
    );
  }

  async removeLabel(idOrKey: string, labelId: string, actorId?: string): Promise<void> {
    const cardId = await resolveCardId(this.db, idOrKey);
    await this.db.execute(
      `DELETE FROM card_label WHERE card_id = ? AND label_id = ?`,
      [cardId, labelId]
    );
  }

  async linkDocument(idOrKey: string, documentId: string, actorId?: string): Promise<void> {
    await this.db.transaction(async tx => {
      const cardId = await resolveCardId(tx, idOrKey);
      const linked_at = new Date().toISOString();
      const result = await tx.execute(
        `INSERT OR IGNORE INTO card_document (card_id, document_id, linked_at) VALUES (?, ?, ?)`,
        [cardId, documentId, linked_at]
      );

      if (this.eventService && result.changes > 0) {
        const card = await this.getById(cardId, tx);
        const projectId = await this.getProjectIdForColumn(card.column_id, tx);
        if (projectId) {
          await this.eventService.create({
            project_id: projectId,
            entity_type: 'card',
            entity_id: cardId,
            action: 'document_linked',
            actor_id: actorId,
            payload: { document_id: documentId },
          }, tx);
        }
      }
    });
  }

  async unlinkDocument(idOrKey: string, documentId: string, actorId?: string): Promise<void> {
    const cardId = await resolveCardId(this.db, idOrKey);
    await this.db.execute(
      `DELETE FROM card_document WHERE card_id = ? AND document_id = ?`,
      [cardId, documentId]
    );
  }

  async linkCard(idOrKey: string, targetIdOrKey: string, relationType: CardLinkRelationType, actorId?: string): Promise<void> {
    await this.db.transaction(async tx => {
      const [cardId, targetCardId] = await Promise.all([
        resolveCardId(tx, idOrKey),
        resolveCardId(tx, targetIdOrKey),
      ]);
      const { sourceCardId, destCardId, storedType } = canonicalizeCardLink(cardId, targetCardId, relationType);

      const id = ulid();
      const created_at = new Date().toISOString();
      const result = await tx.execute(
        `INSERT OR IGNORE INTO card_link (id, source_card_id, target_card_id, relation_type, created_at) VALUES (?, ?, ?, ?, ?)`,
        [id, sourceCardId, destCardId, storedType, created_at]
      );

      if (this.eventService && result.changes > 0) {
        const card = await this.getById(cardId, tx);
        const projectId = await this.getProjectIdForColumn(card.column_id, tx);
        if (projectId) {
          await this.eventService.create({
            project_id: projectId,
            entity_type: 'card',
            entity_id: cardId,
            action: 'card_linked',
            actor_id: actorId,
            payload: { target_card_id: targetCardId, relation_type: relationType },
          }, tx);
        }
      }
    });
  }

  async unlinkCard(idOrKey: string, linkId: string, actorId?: string): Promise<void> {
    const cardId = await resolveCardId(this.db, idOrKey);
    await this.db.execute(
      `DELETE FROM card_link WHERE id = ? AND (source_card_id = ? OR target_card_id = ?)`,
      [linkId, cardId, cardId]
    );
  }

  async addWorkLink(idOrKey: string, data: CreateCardWorkLink, actorId?: string): Promise<CardWorkLink> {
    assertHttpUrl(data.url);
    return this.db.transaction(async tx => {
      const cardId = await resolveCardId(tx, idOrKey);
      const id = ulid();
      const created_at = new Date().toISOString();
      const external_ref = data.external_ref ?? null;
      const title = data.title ?? null;
      const status = data.status ?? null;

      await tx.execute(
        `INSERT INTO card_work_link (id, card_id, kind, provider, url, external_ref, title, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, cardId, data.kind, data.provider, data.url, external_ref, title, status, created_at]
      );

      if (this.eventService) {
        const card = await this.getById(cardId, tx);
        const projectId = await this.getProjectIdForColumn(card.column_id, tx);
        if (projectId) {
          await this.eventService.create({
            project_id: projectId,
            entity_type: 'card',
            entity_id: cardId,
            action: 'work_link_added',
            actor_id: actorId,
            payload: { kind: data.kind, provider: data.provider, url: data.url },
          }, tx);
        }
      }

      return { id, card_id: cardId, kind: data.kind, provider: data.provider, url: data.url, external_ref, title, status, created_at };
    });
  }

  async removeWorkLink(idOrKey: string, linkId: string, actorId?: string): Promise<void> {
    await this.db.transaction(async tx => {
      const cardId = await resolveCardId(tx, idOrKey);
      const result = await tx.execute(
        `DELETE FROM card_work_link WHERE id = ? AND card_id = ?`,
        [linkId, cardId]
      );

      if (this.eventService && result.changes > 0) {
        const card = await this.getById(cardId, tx);
        const projectId = await this.getProjectIdForColumn(card.column_id, tx);
        if (projectId) {
          await this.eventService.create({
            project_id: projectId,
            entity_type: 'card',
            entity_id: cardId,
            action: 'work_link_removed',
            actor_id: actorId,
            payload: { link_id: linkId },
          }, tx);
        }
      }
    });
  }

  async listWorkLinks(idOrKey: string, db: DatabaseAdapter = this.db): Promise<CardWorkLink[]> {
    const cardId = await resolveCardId(db, idOrKey);
    return db.query<CardWorkLink>(
      `SELECT * FROM card_work_link WHERE card_id = ? ORDER BY created_at ASC`,
      [cardId]
    );
  }

  async listWorkLinksPage(idOrKey: string, options: PageOptions = {}, db: DatabaseAdapter = this.db): Promise<Page<CardWorkLink>> {
    const cardId = await resolveCardId(db, idOrKey);
    const limit = normalizePageLimit(options.limit);
    const scope = `card-work-links:${cardId}`;
    const cursor = decodeCursor(options.cursor, scope, 2);
    const params: unknown[] = [cardId];
    let sql = 'SELECT * FROM card_work_link WHERE card_id = ?';
    if (cursor) {
      sql += ' AND (created_at > ? OR (created_at = ? AND id > ?))';
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    sql += ' ORDER BY created_at ASC, id ASC LIMIT ?';
    params.push(limit + 1);
    const rows = await db.query<CardWorkLink>(sql, params);
    return toPage(rows, limit, row => encodeCursor(scope, [row.created_at, row.id]));
  }

  async searchByTitle(projectId: string, query: string, opts: { excludeCardId?: string; limit?: number } = {}): Promise<Card[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const params: unknown[] = [projectId];
    const excludeCardId = opts.excludeCardId
      ? await resolveCardId(this.db, opts.excludeCardId)
      : undefined;

    let sql = `SELECT c.* FROM card c
      JOIN "column" col ON c.column_id = col.id
      JOIN board b ON col.board_id = b.id
      WHERE b.project_id = ? AND c.archived = 0`;

    if (query.trim()) {
      const literalQuery = query.trim().replace(/[\\%_]/g, '\\$&');
      sql += " AND LOWER(c.title) LIKE LOWER(?) ESCAPE '\\'";
      params.push(`%${literalQuery}%`);
    }

    if (excludeCardId) {
      sql += ' AND c.id != ?';
      params.push(excludeCardId);
    }

    sql += ' ORDER BY c.updated_at DESC LIMIT ?';
    params.push(limit);

    return this.db.query<Card>(sql, params);
  }

  async searchByTitlePage(
    projectId: string,
    query: string,
    opts: { excludeCardId?: string; cursor?: string; limit?: number } = {},
  ): Promise<Page<CardSummary>> {
    const limit = normalizePageLimit(opts.limit ?? 20);
    const normalizedQuery = query.trim();
    const excludeCardId = opts.excludeCardId ? await resolveCardId(this.db, opts.excludeCardId) : undefined;
    const scope = `card-search:${JSON.stringify({ projectId, query: normalizedQuery.toLowerCase(), excludeCardId: excludeCardId || null })}`;
    const cursor = decodeCursor(opts.cursor, scope, 2);
    const params: unknown[] = [projectId];
    let sql = `SELECT c.id, c.key, c.column_id, c.title, c.position, c.priority,
      c.due_date, c.created_at, c.updated_at, c.archived, c.claimed_by,
      c.claimed_at, c.claim_expires_at, c.is_epic, col.board_id AS board_id,
      b.name AS board_name, b.slug AS board_slug
      FROM card c JOIN "column" col ON c.column_id = col.id JOIN board b ON col.board_id = b.id
      WHERE b.project_id = ? AND c.archived = 0`;
    if (normalizedQuery) {
      const literal = normalizedQuery.replace(/[\\%_]/g, '\\$&');
      sql += " AND LOWER(c.title) LIKE LOWER(?) ESCAPE '\\'";
      params.push(`%${literal}%`);
    }
    if (excludeCardId) { sql += ' AND c.id != ?'; params.push(excludeCardId); }
    if (cursor) {
      sql += ' AND (c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))';
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    sql += ' ORDER BY c.updated_at DESC, c.id DESC LIMIT ?';
    params.push(limit + 1);
    const rows = await this.db.query<CardSummary>(sql, params);
    const visible = rows.slice(0, limit);
    if (visible.length) await this.hydrateCardSummaries(visible);
    return toPage(rows.map((row, index) => index < visible.length ? visible[index] : row), limit,
      row => encodeCursor(scope, [row.updated_at, row.id]));
  }

  async archive(idOrKey: string, actorId?: string): Promise<void> {
    const cardId = await resolveCardId(this.db, idOrKey);
    const updated_at = new Date().toISOString();
    await this.db.execute(`UPDATE card SET archived = 1, updated_at = ? WHERE id = ?`, [updated_at, cardId]);
  }

  async delete(cardId: string, actorId?: string): Promise<void> {
    await this.db.transaction(async tx => {
      const existing = await this.getById(cardId, tx);
      const canonicalCardId = existing.id;
      const projectId = await this.getProjectIdForColumn(existing.column_id, tx);

      await tx.execute('DELETE FROM card_assignee WHERE card_id = ?', [canonicalCardId]);
      await tx.execute('DELETE FROM card_label WHERE card_id = ?', [canonicalCardId]);
      await tx.execute('DELETE FROM card_document WHERE card_id = ?', [canonicalCardId]);
      await tx.execute('DELETE FROM card_link WHERE source_card_id = ? OR target_card_id = ?', [canonicalCardId, canonicalCardId]);
      await tx.execute('DELETE FROM card_work_link WHERE card_id = ?', [canonicalCardId]);
      await tx.execute('DELETE FROM comment WHERE card_id = ?', [canonicalCardId]);
      await tx.execute('DELETE FROM card WHERE id = ?', [canonicalCardId]);

      if (this.eventService && projectId) {
        await this.eventService.create({
          project_id: projectId,
          entity_type: 'card',
          entity_id: canonicalCardId,
          action: 'deleted',
          actor_id: actorId,
          payload: { title: existing.title },
        }, tx);
      }
    });
  }

  private async getProjectIdForColumn(columnId: string, db: DatabaseAdapter = this.db): Promise<string | null> {
    const rows = await db.query<{ project_id: string }>(
      `SELECT b.project_id FROM "column" col JOIN board b ON col.board_id = b.id WHERE col.id = ?`,
      [columnId]
    );
    return rows[0]?.project_id || null;
  }

  /**
   * Layer 2 scope check: validate that a principal has scope over a card.
   * Returns true if the principal (or an agent they operate) is an assignee
   * on the card, or if the principal has unrestricted card access.
   * Under MUSTER_AUTH_MODE=open, always returns true (no scope enforcement).
   */
  async validateCardScope(cardId: string, agentIds: string[]): Promise<boolean> {
    if (config.auth.mode === 'open') return true;

    if (agentIds.length === 0) return false;

    const canonicalCardId = await resolveCardId(this.db, cardId);
    const placeholders = agentIds.map(() => '?').join(',');
    const rows = await this.db.query<{ card_id: string }>(
      `SELECT card_id FROM card_assignee WHERE card_id = ? AND principal_id IN (${placeholders}) LIMIT 1`,
      [canonicalCardId, ...agentIds]
    );
    return rows.length > 0;
  }
}
