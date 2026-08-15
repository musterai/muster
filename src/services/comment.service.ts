// File: src/services/comment.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Comment, CreateComment } from '../shared/types.js';
import { EventService } from './event.service.js';
import { assertMaxLength, CARD_TEXT_MAX_CHARS } from '../shared/content-limits.js';
import { config } from '../config/index.js';
import { resolveCardId } from './helpers/card-id.helper.js';

export class CommentService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService
  ) {}

  async create(data: CreateComment): Promise<Comment> {
    assertMaxLength(data.content, CARD_TEXT_MAX_CHARS, 'Comment content');
    const cardId = await resolveCardId(this.db, data.card_id);
    const id = ulid();
    const created_at = new Date().toISOString();

    await this.db.execute(
      `INSERT INTO comment (id, card_id, author_id, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, cardId, data.author_id, data.content, created_at]
    );

    const comment: Comment = {
      id,
      card_id: cardId,
      author_id: data.author_id,
      content: data.content,
      created_at,
    };

    await this.recordEvent(cardId, 'commented', data.author_id, { comment_id: id, content: data.content });

    return comment;
  }

  async listByCard(cardId: string): Promise<Comment[]> {
    const canonicalCardId = await resolveCardId(this.db, cardId);
    return this.db.query<Comment>('SELECT * FROM comment WHERE card_id = ? ORDER BY created_at ASC', [canonicalCardId]);
  }

  async getById(id: string): Promise<Comment | null> {
    const rows = await this.db.query<Comment>('SELECT * FROM comment WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async update(id: string, content: string, actorId?: string): Promise<Comment> {
    assertMaxLength(content, CARD_TEXT_MAX_CHARS, 'Comment content');
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Comment ${id} not found`);
    }

    await this.db.execute('UPDATE comment SET content = ? WHERE id = ?', [content, id]);
    const updated: Comment = { ...existing, content };

    await this.recordEvent(existing.card_id, 'comment_updated', actorId, { comment_id: id, content });

    return updated;
  }

  async delete(id: string, actorId?: string): Promise<void> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Comment ${id} not found`);
    }

    await this.db.execute('DELETE FROM comment WHERE id = ?', [id]);

    await this.recordEvent(existing.card_id, 'comment_deleted', actorId, { comment_id: id });
  }

  /**
   * Layer 2 scope check: a principal may only edit/delete their own comments.
   * Under MUSTER_AUTH_MODE=open, always returns true (no scope enforcement) —
   * mirrors CardService.validateCardScope.
   */
  async validateCommentOwnership(commentId: string, principalId: string): Promise<boolean> {
    if (config.auth.mode === 'open') return true;
    const comment = await this.getById(commentId);
    return comment?.author_id === principalId;
  }

  private async recordEvent(
    cardId: string,
    action: string,
    actorId: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.eventService) return;

    const cardRows = await this.db.query<{ column_id: string }>('SELECT column_id FROM card WHERE id = ?', [cardId]);
    if (!cardRows[0]) return;

    const projRows = await this.db.query<{ project_id: string }>(
      'SELECT b.project_id FROM "column" col JOIN board b ON col.board_id = b.id WHERE col.id = ?',
      [cardRows[0].column_id]
    );
    if (!projRows[0]) return;

    await this.eventService.create({
      project_id: projRows[0].project_id,
      entity_type: 'card',
      entity_id: cardId,
      action,
      actor_id: actorId,
      payload,
    });
  }
}
