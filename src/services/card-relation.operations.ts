import { ulid } from 'ulid';
import type { DatabaseAdapter } from '../db/adapter.js';
import type { AuthContext } from '../shared/auth-context.js';
import { OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import {
  decodeCursor,
  encodeCursor,
  normalizePageLimit,
  toPage,
  type Page,
  type PageOptions,
} from '../shared/pagination.js';
import type {
  CardLinkRelationType,
  CardWorkLink,
  CreateCardWorkLink,
} from '../shared/types.js';
import { assertHttpUrl } from '../shared/url.js';
import { canonicalizeCardLink } from './helpers/card-links.helper.js';
import { resolveCardId } from './helpers/card-id.helper.js';
import {
  assertResourceWorkspace,
  assertResourcesShareWorkspace,
  assertResourcesWorkspace,
} from './helpers/workspace-scope.helper.js';
import type { CardRecordQueries } from './card-record.queries.js';
import type { EventService } from './event.service.js';

/**
 * Owns card relationship and external work-link transactions. It keeps
 * workspace checks, writes and domain events on one injected adapter graph.
 */
export class CardRelationOperations {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly eventService: EventService | undefined,
    private readonly records: CardRecordQueries,
  ) {}

  async linkDocument(
    idOrKey: string,
    documentId: string,
    actorId?: string,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<void> {
    await this.db.transaction(async tx => {
      const cardId = await resolveCardId(tx, idOrKey);
      await assertResourcesWorkspace(tx, auth, [['card', cardId], ['document', documentId]]);
      await assertResourcesShareWorkspace(tx, [['card', cardId], ['document', documentId]]);
      const linkedAt = new Date().toISOString();
      const result = await tx.execute(
        'INSERT OR IGNORE INTO card_document (card_id, document_id, linked_at) VALUES (?, ?, ?)',
        [cardId, documentId, linkedAt],
      );
      if (this.eventService && result.changes > 0) {
        await this.emitCardEvent(
          tx,
          cardId,
          'document_linked',
          actorId,
          { document_id: documentId },
        );
      }
    });
  }

  async unlinkDocument(
    idOrKey: string,
    documentId: string,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<void> {
    const cardId = await resolveCardId(this.db, idOrKey);
    await assertResourcesWorkspace(this.db, auth, [['card', cardId], ['document', documentId]]);
    await this.db.execute(
      'DELETE FROM card_document WHERE card_id = ? AND document_id = ?',
      [cardId, documentId],
    );
  }

  async linkCard(
    idOrKey: string,
    targetIdOrKey: string,
    relationType: CardLinkRelationType,
    actorId?: string,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<void> {
    await this.db.transaction(async tx => {
      const [cardId, targetCardId] = await Promise.all([
        resolveCardId(tx, idOrKey),
        resolveCardId(tx, targetIdOrKey),
      ]);
      await assertResourcesWorkspace(tx, auth, [['card', cardId], ['card', targetCardId]]);
      await assertResourcesShareWorkspace(tx, [['card', cardId], ['card', targetCardId]]);
      const { sourceCardId, destCardId, storedType } = canonicalizeCardLink(
        cardId,
        targetCardId,
        relationType,
      );
      const result = await tx.execute(
        `INSERT OR IGNORE INTO card_link
           (id, source_card_id, target_card_id, relation_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [ulid(), sourceCardId, destCardId, storedType, new Date().toISOString()],
      );
      if (this.eventService && result.changes > 0) {
        await this.emitCardEvent(
          tx,
          cardId,
          'card_linked',
          actorId,
          { target_card_id: targetCardId, relation_type: relationType },
        );
      }
    });
  }

  async unlinkCard(
    idOrKey: string,
    linkId: string,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<void> {
    const cardId = await resolveCardId(this.db, idOrKey);
    await assertResourceWorkspace(this.db, auth, 'card', cardId);
    await this.db.execute(
      'DELETE FROM card_link WHERE id = ? AND (source_card_id = ? OR target_card_id = ?)',
      [linkId, cardId, cardId],
    );
  }

  async addWorkLink(
    idOrKey: string,
    data: CreateCardWorkLink,
    actorId?: string,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<CardWorkLink> {
    assertHttpUrl(data.url);
    return this.db.transaction(async tx => {
      const cardId = await resolveCardId(tx, idOrKey);
      await assertResourceWorkspace(tx, auth, 'card', cardId);
      const link: CardWorkLink = {
        id: ulid(),
        card_id: cardId,
        kind: data.kind,
        provider: data.provider,
        url: data.url,
        external_ref: data.external_ref ?? null,
        title: data.title ?? null,
        status: data.status ?? null,
        created_at: new Date().toISOString(),
      };
      await tx.execute(
        `INSERT INTO card_work_link
           (id, card_id, kind, provider, url, external_ref, title, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          link.id,
          link.card_id,
          link.kind,
          link.provider,
          link.url,
          link.external_ref,
          link.title,
          link.status,
          link.created_at,
        ],
      );
      if (this.eventService) {
        await this.emitCardEvent(
          tx,
          cardId,
          'work_link_added',
          actorId,
          { kind: data.kind, provider: data.provider, url: data.url },
        );
      }
      return link;
    });
  }

  async removeWorkLink(
    idOrKey: string,
    linkId: string,
    actorId?: string,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<void> {
    await this.db.transaction(async tx => {
      const cardId = await resolveCardId(tx, idOrKey);
      await assertResourceWorkspace(tx, auth, 'card', cardId);
      const result = await tx.execute(
        'DELETE FROM card_work_link WHERE id = ? AND card_id = ?',
        [linkId, cardId],
      );
      if (this.eventService && result.changes > 0) {
        await this.emitCardEvent(
          tx,
          cardId,
          'work_link_removed',
          actorId,
          { link_id: linkId },
        );
      }
    });
  }

  async listWorkLinks(
    idOrKey: string,
    db: DatabaseAdapter = this.db,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<CardWorkLink[]> {
    const cardId = await resolveCardId(db, idOrKey);
    await assertResourceWorkspace(db, auth, 'card', cardId);
    return db.query<CardWorkLink>(
      'SELECT * FROM card_work_link WHERE card_id = ? ORDER BY created_at ASC',
      [cardId],
    );
  }

  async listWorkLinksPage(
    idOrKey: string,
    options: PageOptions = {},
    db: DatabaseAdapter = this.db,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<Page<CardWorkLink>> {
    const cardId = await resolveCardId(db, idOrKey);
    await assertResourceWorkspace(db, auth, 'card', cardId);
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

  private async emitCardEvent(
    db: DatabaseAdapter,
    cardId: string,
    action: string,
    actorId: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.eventService) return;
    const card = await this.records.requireCard(cardId, db);
    const projectId = await this.records.projectIdForColumn(card.column_id, db);
    if (!projectId) return;
    await this.eventService.create({
      project_id: projectId,
      entity_type: 'card',
      entity_id: cardId,
      action,
      actor_id: actorId,
      payload,
    }, db);
  }
}
