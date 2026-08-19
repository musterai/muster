// File: src/services/document.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Document, DocumentVersion, CreateDocument, UpdateDocument } from '../shared/types.js';
import { EventService } from './event.service.js';
import { assertMaxLength, DOCUMENT_CONTENT_MAX_CHARS } from '../shared/content-limits.js';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import { requirePermission } from '../shared/permission-enforcer.js';
import { DocumentStateError, ValidationError } from '../shared/errors.js';
import { AuditService } from './audit.service.js';

export type DocumentTransitionStatus = 'in_review' | 'approved';

export interface DocumentStatusTransition {
  status: DocumentTransitionStatus;
  /** Content version the caller reviewed; a status transition does not increment it. */
  expected_version: number;
  ip?: string | null;
}

export class DocumentService {
  constructor(
    private db: DatabaseAdapter,
    private eventService?: EventService,
    private auditService: AuditService = new AuditService(db),
  ) {}

  async create(data: CreateDocument, actorId?: string, adapter?: DatabaseAdapter): Promise<Document> {
    if (!adapter) return this.db.transaction(tx => this.create(data, actorId, tx));
    const db = adapter;
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

    await db.execute(
      `INSERT INTO document (id, project_id, parent_id, title, content, status, author_id, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.project_id, parent_id, data.title, data.content, status, author_id, version, created_at, updated_at]
    );

    // Initial version entry
    const versionId = ulid();
    await db.execute(
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
      }, db);
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

  async update(id: string, data: UpdateDocument, actorId?: string, adapter?: DatabaseAdapter): Promise<Document> {
    if (!adapter) return this.db.transaction(tx => this.update(id, data, actorId, tx));
    const db = adapter;
    assertMaxLength(data.content, DOCUMENT_CONTENT_MAX_CHARS, 'Document content');
    const lockClause = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const existingRows = await db.query<Document>(`SELECT * FROM document WHERE id = ?${lockClause}`, [id]);
    const existing = existingRows[0] || null;
    if (!existing) throw new Error(`Document with ID ${id} not found`);
    if (existing.status === 'approved') {
      throw new DocumentStateError(
        'DOCUMENT_APPROVED_IMMUTABLE',
        'Approved documents cannot be edited',
        { document_id: id, status: existing.status, version: existing.version },
      );
    }

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

    await db.execute(
      `UPDATE document SET title = ?, content = ?, author_id = ?, version = ?, updated_at = ? WHERE id = ?`,
      [title, content, author_id, newVersion, updated_at, id]
    );

    const versionId = ulid();
    await db.execute(
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
      }, db);
    }

    return updated;
  }

  async setStatus(
    id: string,
    transition: DocumentStatusTransition,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
    adapter?: DatabaseAdapter,
  ): Promise<Document> {
    if (!adapter) return this.db.transaction(tx => this.setStatus(id, transition, auth, tx));
    const db = adapter;
    if (!transition || (transition.status !== 'in_review' && transition.status !== 'approved')) {
      throw new ValidationError('Invalid document status transition target', {
        status: transition?.status,
        allowed: ['in_review', 'approved'],
      });
    }
    if (!Number.isSafeInteger(transition.expected_version) || transition.expected_version < 1) {
      throw new ValidationError('expected_version must be a positive integer', {
        expected_version: transition.expected_version,
      });
    }

    // Keep permission enforcement at the shared boundary so REST, MCP,
    // scripts, and future transports cannot disagree about who may advance it.
    requirePermission('set_document_status', auth, { status: transition.status });

    const lockClause = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const existingRows = await db.query<Document>(`SELECT * FROM document WHERE id = ?${lockClause}`, [id]);
    const existing = existingRows[0] || null;
    if (!existing) throw new Error(`Document with ID ${id} not found`);

    if (existing.version !== transition.expected_version) {
      throw new DocumentStateError(
        'DOCUMENT_VERSION_CONFLICT',
        `Document version changed from ${transition.expected_version} to ${existing.version}`,
        {
          document_id: id,
          expected_version: transition.expected_version,
          current_version: existing.version,
        },
      );
    }

    const expectedTarget = existing.status === 'draft'
      ? 'in_review'
      : existing.status === 'in_review'
        ? 'approved'
        : null;
    if (transition.status !== expectedTarget) {
      throw new DocumentStateError(
        'DOCUMENT_TRANSITION_INVALID',
        `Cannot transition document from ${existing.status} to ${transition.status}`,
        {
          document_id: id,
          from_status: existing.status,
          to_status: transition.status,
          expected_status: expectedTarget,
          version: existing.version,
        },
      );
    }

    const updated_at = new Date().toISOString();
    const write = await db.execute(
      'UPDATE document SET status = ?, updated_at = ? WHERE id = ? AND status = ? AND version = ?',
      [transition.status, updated_at, id, existing.status, transition.expected_version],
    );
    if (write.changes !== 1) {
      throw new DocumentStateError(
        'DOCUMENT_VERSION_CONFLICT',
        'Document changed while applying the status transition',
        {
          document_id: id,
          expected_version: transition.expected_version,
          expected_status: existing.status,
        },
      );
    }

    const updated: Document = { ...existing, status: transition.status, updated_at };
    const actorId = auth.principal?.id;

    if (this.eventService) {
      await this.eventService.create({
        project_id: existing.project_id,
        entity_type: 'document',
        entity_id: id,
        action: 'status_changed',
        actor_id: actorId,
        payload: { from: existing.status, to: transition.status, version: existing.version },
      }, db);
    }

    await this.auditService.logAs(auth, {
      action: transition.status === 'approved' ? 'document.approve' : 'document.submit_review',
      target_type: 'document',
      target_id: id,
      payload: {
        title: existing.title,
        project_id: existing.project_id,
        from_status: existing.status,
        to_status: transition.status,
        version: existing.version,
      },
      ip: transition.ip,
    }, db);

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

  async delete(id: string, actorId?: string, adapter?: DatabaseAdapter): Promise<void> {
    if (!adapter) return this.db.transaction(tx => this.delete(id, actorId, tx));
    const db = adapter;
    const existingRows = await db.query<Document>('SELECT * FROM document WHERE id = ?', [id]);
    const existing = existingRows[0] || null;
    if (!existing) throw new Error(`Document with ID ${id} not found`);

    await db.execute('DELETE FROM card_document WHERE document_id = ?', [id]);
    await db.execute('DELETE FROM document_version WHERE document_id = ?', [id]);
    await db.execute('DELETE FROM document WHERE id = ?', [id]);

    if (this.eventService) {
      await this.eventService.create({
        project_id: existing.project_id,
        entity_type: 'document',
        entity_id: id,
        action: 'deleted',
        actor_id: actorId,
        payload: { title: existing.title },
      }, db);
    }
  }
}
