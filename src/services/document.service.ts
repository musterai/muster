// File: src/services/document.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Document, DocumentVersion, CreateDocument, UpdateDocument } from '../shared/types.js';
import { EventService } from './event.service.js';
import { assertMaxLength, DOCUMENT_CONTENT_MAX_CHARS } from '../shared/content-limits.js';

export class DocumentService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService
  ) {}

  async create(data: CreateDocument, actorId?: string): Promise<Document> {
    assertMaxLength(data.content, DOCUMENT_CONTENT_MAX_CHARS, 'Document content');
    const id = ulid();
    const created_at = new Date().toISOString();
    const updated_at = created_at;

    const parent_id = data.parent_id || null;
    // Transport boundaries pass the credential-derived actor separately. It
    // must win over any legacy payload field so an authenticated caller can
    // never forge document authorship or the initial version attribution.
    const author_id = actorId || data.author_id || null;
    const status = 'draft';
    const version = 1;

    await this.db.execute(
      `INSERT INTO document (id, project_id, parent_id, title, content, status, author_id, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.project_id, parent_id, data.title, data.content, status, author_id, version, created_at, updated_at]
    );

    // Initial version entry
    const versionId = ulid();
    await this.db.execute(
      `INSERT INTO document_version (id, document_id, version, title, content, author_id, change_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [versionId, id, 1, data.title, data.content, author_id, 'Initial document creation', created_at]
    );

    const doc: Document = {
      id,
      project_id: data.project_id,
      parent_id,
      title: data.title,
      content: data.content,
      status,
      author_id,
      version: 1,
      created_at,
      updated_at,
    };

    if (this.eventService) {
      await this.eventService.create({
        project_id: data.project_id,
        entity_type: 'document',
        entity_id: id,
        action: 'created',
        actor_id: author_id || undefined,
        payload: { title: doc.title, version: 1 },
      });
    }

    return doc;
  }

  async getById(id: string, versionNumber?: number): Promise<Document | null> {
    if (versionNumber) {
      const verRows = await this.db.query<DocumentVersion>(
        'SELECT * FROM document_version WHERE document_id = ? AND version = ?',
        [id, versionNumber]
      );
      if (!verRows[0]) return null;

      const docRows = await this.db.query<Document>('SELECT * FROM document WHERE id = ?', [id]);
      if (!docRows[0]) return null;

      return {
        ...docRows[0],
        title: verRows[0].title,
        content: verRows[0].content,
        version: verRows[0].version,
        updated_at: verRows[0].created_at,
      };
    }

    const rows = await this.db.query<Document>('SELECT * FROM document WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async list(projectId: string, filters: { status?: string; parent_id?: string | null } = {}): Promise<Document[]> {
    let sql = 'SELECT * FROM document WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (filters.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }

    if (filters.parent_id !== undefined) {
      if (filters.parent_id === null) {
        sql += ' AND parent_id IS NULL';
      } else {
        sql += ' AND parent_id = ?';
        params.push(filters.parent_id);
      }
    }

    sql += ' ORDER BY title ASC';
    return this.db.query<Document>(sql, params);
  }

  async update(id: string, data: UpdateDocument, actorId?: string): Promise<Document> {
    assertMaxLength(data.content, DOCUMENT_CONTENT_MAX_CHARS, 'Document content');
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Document with ID ${id} not found`);

    const title = data.title !== undefined ? data.title : existing.title;
    const content = data.content !== undefined ? data.content : existing.content;
    // Who actually made this edit. Null when the caller is unidentified — the
    // version row must not inherit the previous author, or history credits the
    // wrong person.
    const editor_id = actorId || data.author_id || null;
    // The document row keeps its last known author rather than going null.
    const author_id = editor_id || existing.author_id;
    const change_summary = data.change_summary || 'Updated content';
    const newVersion = existing.version + 1;
    const updated_at = new Date().toISOString();

    await this.db.execute(
      `UPDATE document SET title = ?, content = ?, author_id = ?, version = ?, updated_at = ? WHERE id = ?`,
      [title, content, author_id, newVersion, updated_at, id]
    );

    const versionId = ulid();
    await this.db.execute(
      `INSERT INTO document_version (id, document_id, version, title, content, author_id, change_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [versionId, id, newVersion, title, content, editor_id, change_summary, updated_at]
    );

    const updated: Document = {
      ...existing,
      title,
      content,
      author_id,
      version: newVersion,
      updated_at,
    };

    if (this.eventService) {
      await this.eventService.create({
        project_id: existing.project_id,
        entity_type: 'document',
        entity_id: id,
        action: 'updated',
        actor_id: editor_id || undefined,
        payload: { title, version: newVersion, change_summary },
      });
    }

    return updated;
  }

  async setStatus(id: string, status: 'draft' | 'in_review' | 'approved' | 'archived', actorId?: string): Promise<Document> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Document with ID ${id} not found`);

    const updated_at = new Date().toISOString();
    await this.db.execute('UPDATE document SET status = ?, updated_at = ? WHERE id = ?', [status, updated_at, id]);

    const updated: Document = { ...existing, status, updated_at };

    if (this.eventService) {
      await this.eventService.create({
        project_id: existing.project_id,
        entity_type: 'document',
        entity_id: id,
        action: 'status_changed',
        actor_id: actorId,
        payload: { from: existing.status, to: status },
      });
    }

    return updated;
  }

  async getHistory(id: string): Promise<DocumentVersion[]> {
    return this.db.query<DocumentVersion>(
      `SELECT v.*, COALESCE(a.name, u.display_name) as author_name FROM document_version v
       LEFT JOIN agent a ON v.author_id = a.id
       LEFT JOIN app_user u ON v.author_id = u.id
       WHERE v.document_id = ? ORDER BY v.version DESC`,
      [id]
    );
  }

  async delete(id: string, actorId?: string): Promise<void> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Document with ID ${id} not found`);

    await this.db.execute('DELETE FROM card_document WHERE document_id = ?', [id]);
    await this.db.execute('DELETE FROM document_version WHERE document_id = ?', [id]);
    await this.db.execute('DELETE FROM document WHERE id = ?', [id]);

    if (this.eventService) {
      await this.eventService.create({
        project_id: existing.project_id,
        entity_type: 'document',
        entity_id: id,
        action: 'deleted',
        actor_id: actorId,
        payload: { title: existing.title },
      });
    }
  }
}
