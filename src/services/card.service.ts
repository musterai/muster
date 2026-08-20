import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Card, CardAssignee, CardDetails, CardSummary, CreateCard, UpdateCard, MoveCard, Label, Document, CardLinkRelationType, LinkedCardSummary, CardWorkLink, CreateCardWorkLink, ClaimRefusal, CardOperationOptions } from '../shared/types.js';
import { EventService } from './event.service.js';
import { formatCardKey } from '../shared/card-key.js';
import { CardRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import { config } from '../config/index.js';
import { assertMaxLength, CARD_TEXT_MAX_CHARS } from '../shared/content-limits.js';
import { resolveCardId } from './helpers/card-id.helper.js';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import { assertResourceWorkspace, assertResourcesShareWorkspace, assertResourcesWorkspace, workspaceIdFor } from './helpers/workspace-scope.helper.js';
import { CardAccessPolicy } from './card-access.policy.js';
import { CardLanePolicy, type ColumnCapacity } from './card-lane.policy.js';
import { PermissionDeniedError, WORKSPACE_READ } from '../shared/permission-enforcer.js';
import { assertActiveWorkspacePrincipal } from './agent-scope.authorization.js';
import { decodeCursor, encodeCursor, normalizePageLimit, Page, PageOptions, toPage } from '../shared/pagination.js';
import type { CardRecordQueries } from './card-record.queries.js';
import type { CardMoveOperations } from './card-move.operations.js';
import type { CardAssignmentOperations } from './card-assignment.operations.js';
import type { CardRelationOperations } from './card-relation.operations.js';

const DEFAULT_CLAIM_TTL_SECONDS = 600;
export interface CardServiceDependencies {
  accessPolicy: CardAccessPolicy;
  lanePolicy: CardLanePolicy;
  records: CardRecordQueries;
  moveOperations: CardMoveOperations;
  assignmentOperations: CardAssignmentOperations;
  relationOperations: CardRelationOperations;
}

export class CardService {
  constructor(
    private db: DatabaseAdapter,
    private eventService: EventService | undefined,
    dependencies: CardServiceDependencies,
  ) {
    this.accessPolicy = dependencies.accessPolicy;
    this.lanePolicy = dependencies.lanePolicy;
    this.records = dependencies.records;
    this.moveOperations = dependencies.moveOperations;
    this.assignmentOperations = dependencies.assignmentOperations;
    this.relationOperations = dependencies.relationOperations;
  }

  readonly accessPolicy: CardAccessPolicy;
  readonly lanePolicy: CardLanePolicy;
  readonly records: CardRecordQueries;
  readonly moveOperations: CardMoveOperations;
  readonly assignmentOperations: CardAssignmentOperations;
  readonly relationOperations: CardRelationOperations;

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
    return this.accessPolicy.assertCardWorkspaceScope(cardIdOrKey, auth, adapter);
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
    return this.accessPolicy.assertColumnWorkspaceScope(columnId, auth, adapter);
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
    return this.accessPolicy.assertCardMutationScope(cardIdOrKey, auth, adapter);
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
    await assertResourceWorkspace(this.db, options.auth || OPEN_AUTH_CONTEXT, 'column', data.column_id);
    const id = ulid();
    const created_at = new Date().toISOString();
    const updated_at = created_at;

    const projectId = await this.getProjectIdForColumn(data.column_id);
    if (!projectId) throw new Error(`Column ${data.column_id} is not attached to a project`);
    const { card, wipViolation } = await this.db.transaction(async (tx) => {
      let wipViolation: ColumnCapacity | null = null;
      const capacity = await this.lanePolicy.getColumnCapacity(data.column_id, tx);
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
      this.lanePolicy.assertPosition(data.position);

      const priority = data.priority || 'medium';
      const description = data.description || null;
      const due_date = data.due_date || null;
      const is_epic = data.is_epic ? 1 : 0;
      const existingCards = await this.lanePolicy.orderedLaneCards(data.column_id, tx);
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
      const orderedCards = this.lanePolicy.orderWithPosition(existingCards, draftCard, data.position);

      await tx.execute(
        `INSERT INTO card (id, key, column_id, title, description, position, priority, due_date, created_at, updated_at, archived, is_epic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [id, key, data.column_id, data.title, description, 'm', priority, due_date, created_at, updated_at, is_epic]
      );

      const ranks = await this.lanePolicy.rebalanceLane(tx, orderedCards);
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
  async getById(idOrKey: string, db: DatabaseAdapter = this.db, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<CardDetails> {
    const cardRows = await db.query<Card>(
      `SELECT c.*, col.board_id AS board_id, b.name AS board_name, b.slug AS board_slug,
              b.project_id AS project_id, p.slug AS project_slug
       FROM card c
       JOIN "column" col ON col.id = c.column_id
       JOIN board b ON b.id = col.board_id
       JOIN project p ON p.id = b.project_id
       WHERE c.id = ? OR c.key = ?`,
      [idOrKey, idOrKey],
    );
    const card = cardRows[0];
    if (!card) throw new NotFoundError('Resource not found');
    await assertResourceWorkspace(db, auth, 'card', card.id);

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
    const work_links = await this.listWorkLinks(id, db, auth);
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
      `SELECT id FROM "column" WHERE workflow_role = 'terminal' AND id IN (${placeholders})`,
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

  async list(filters: { column_id?: string; board_id?: string; project_id?: string; assignee_id?: string; label?: string; archived?: boolean } = {}, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Card[]> {
    const scopedSelectors: Array<['project' | 'board' | 'column' | 'agent', string]> = [];
    if (filters.project_id) scopedSelectors.push(['project', filters.project_id]);
    if (filters.board_id) scopedSelectors.push(['board', filters.board_id]);
    if (filters.column_id) scopedSelectors.push(['column', filters.column_id]);
    if (filters.assignee_id) scopedSelectors.push(['agent', filters.assignee_id]);
    await assertResourcesWorkspace(this.db, auth, scopedSelectors);
    let sql = 'SELECT DISTINCT c.*, col.board_id AS board_id, b.name AS board_name, b.slug AS board_slug FROM card c JOIN "column" col ON c.column_id = col.id JOIN board b ON col.board_id = b.id JOIN project p ON p.id = b.project_id';
    const joins: string[] = [];
    const conditions: string[] = [];
    const params: unknown[] = [];
    const workspaceId = workspaceIdFor(auth);
    if (workspaceId) {
      conditions.push('p.workspace_id = ?');
      params.push(workspaceId);
    }

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
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<Page<CardSummary>> {
    const scopedSelectors: Array<['project' | 'board' | 'column' | 'agent', string]> = [];
    if (filters.project_id) scopedSelectors.push(['project', filters.project_id]);
    if (filters.board_id) scopedSelectors.push(['board', filters.board_id]);
    if (filters.column_id) scopedSelectors.push(['column', filters.column_id]);
    if (filters.assignee_id) scopedSelectors.push(['agent', filters.assignee_id]);
    await assertResourcesWorkspace(this.db, auth, scopedSelectors);
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
      FROM card c JOIN "column" col ON c.column_id = col.id JOIN board b ON col.board_id = b.id JOIN project p ON p.id=b.project_id`;
    const joins: string[] = [];
    const conditions: string[] = [];
    const params: unknown[] = [];
    const workspaceId = workspaceIdFor(auth);
    if (workspaceId) { conditions.push('p.workspace_id = ?'); params.push(workspaceId); }

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
      const existing = await this.getById(cardId, tx, options.auth || OPEN_AUTH_CONTEXT);
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

      return this.getById(cardId, tx, options.auth || OPEN_AUTH_CONTEXT);
    });
  }

  async move(id: string, data: MoveCard, actorId?: string, options: CardOperationOptions = {}): Promise<CardDetails> {
    const cardId = await this.moveOperations.move(id, data, actorId, options);
    return this.getById(cardId, this.db, options.auth || OPEN_AUTH_CONTEXT);
  }

  async assign(idOrKey: string, agentId: string, actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    return this.assignmentOperations.assign(idOrKey, agentId, actorId, auth);
  }

  async unassign(idOrKey: string, agentId: string, _actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    return this.assignmentOperations.unassign(idOrKey, agentId, auth);
  }

  async claim(
    cardId: string,
    agentId: string,
    ttlSeconds: number = DEFAULT_CLAIM_TTL_SECONDS,
    actorId?: string,
    options: CardOperationOptions = {},
  ): Promise<CardDetails | ClaimRefusal> {
    const result = await this.assignmentOperations.claim(
      cardId,
      agentId,
      ttlSeconds,
      actorId,
      options,
    );
    if (result.success === false) return result;
    const details = await this.getById(result.cardId, this.db, options.auth || OPEN_AUTH_CONTEXT);
    const capacity = await this.lanePolicy.getColumnCapacity(details.column_id, this.db);
    return { ...details, next_active_lane: await this.lanePolicy.nextActiveLane(capacity.board_id, this.db) };
  }

  async renewClaims(agentId: string, ttlSeconds: number = DEFAULT_CLAIM_TTL_SECONDS): Promise<void> {
    return this.assignmentOperations.renewClaims(agentId, ttlSeconds);
  }

  async releaseExpiredLeases(adapter?: DatabaseAdapter): Promise<string[]> {
    return this.assignmentOperations.releaseExpiredLeases(adapter);
  }

  async addLabel(idOrKey: string, labelId: string, actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    const cardId = await resolveCardId(this.db, idOrKey);
    await assertResourcesWorkspace(this.db, auth, [['card', cardId], ['label', labelId]]);
    await assertResourcesShareWorkspace(this.db, [['card', cardId], ['label', labelId]]);
    await this.db.execute(
      `INSERT OR IGNORE INTO card_label (card_id, label_id) VALUES (?, ?)`,
      [cardId, labelId]
    );
  }

  async removeLabel(idOrKey: string, labelId: string, actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    const cardId = await resolveCardId(this.db, idOrKey);
    await assertResourcesWorkspace(this.db, auth, [['card', cardId], ['label', labelId]]);
    await this.db.execute(
      `DELETE FROM card_label WHERE card_id = ? AND label_id = ?`,
      [cardId, labelId]
    );
  }

  async linkDocument(idOrKey: string, documentId: string, actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    return this.relationOperations.linkDocument(idOrKey, documentId, actorId, auth);
  }

  async unlinkDocument(idOrKey: string, documentId: string, _actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    return this.relationOperations.unlinkDocument(idOrKey, documentId, auth);
  }

  async linkCard(idOrKey: string, targetIdOrKey: string, relationType: CardLinkRelationType, actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    return this.relationOperations.linkCard(idOrKey, targetIdOrKey, relationType, actorId, auth);
  }

  async unlinkCard(idOrKey: string, linkId: string, _actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    return this.relationOperations.unlinkCard(idOrKey, linkId, auth);
  }

  async addWorkLink(idOrKey: string, data: CreateCardWorkLink, actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<CardWorkLink> {
    return this.relationOperations.addWorkLink(idOrKey, data, actorId, auth);
  }

  async removeWorkLink(idOrKey: string, linkId: string, actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    return this.relationOperations.removeWorkLink(idOrKey, linkId, actorId, auth);
  }

  async listWorkLinks(idOrKey: string, db: DatabaseAdapter = this.db, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<CardWorkLink[]> {
    return this.relationOperations.listWorkLinks(idOrKey, db, auth);
  }

  async listWorkLinksPage(idOrKey: string, options: PageOptions = {}, db: DatabaseAdapter = this.db, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Page<CardWorkLink>> {
    return this.relationOperations.listWorkLinksPage(idOrKey, options, db, auth);
  }

  async searchByTitle(projectId: string, query: string, opts: { excludeCardId?: string; limit?: number } = {}, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<Card[]> {
    await assertResourceWorkspace(this.db, auth, 'project', projectId);
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
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<Page<CardSummary>> {
    await assertResourceWorkspace(this.db, auth, 'project', projectId);
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

  async archive(idOrKey: string, actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    const cardId = await resolveCardId(this.db, idOrKey);
    await assertResourceWorkspace(this.db, auth, 'card', cardId);
    const updated_at = new Date().toISOString();
    await this.db.execute(`UPDATE card SET archived = 1, updated_at = ? WHERE id = ?`, [updated_at, cardId]);
  }

  async delete(cardId: string, actorId?: string, auth: AuthContext = OPEN_AUTH_CONTEXT): Promise<void> {
    await this.db.transaction(async tx => {
      const existing = await this.getById(cardId, tx, auth);
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
