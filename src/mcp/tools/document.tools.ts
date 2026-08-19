import { z } from 'zod';
import { withPermission } from '../../shared/permission-enforcer.js';
import { resolveActor, type McpToolContext } from '../tool-context.js';

export function registerDocumentTools({ server, services, auth }: McpToolContext): void {
  // --- Document Management Tools ---
  server.tool('list_documents', {
    project_id: z.string(),
    status: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('list_documents', auth, async ({ project_id, cursor, limit, ...filters }) => {
    const result = await services.documentService.listPage(project_id, filters, { cursor, limit }, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('create_document', {
    project_id: z.string(),
    title: z.string(),
    content: z.string(),
    parent_id: z.string().optional(),
  }, withPermission('create_document', auth, async (args) => {
    const author_id = resolveActor(auth);
    const result = await services.documentService.create({ ...args, author_id }, undefined, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('get_document', {
    document_id: z.string(),
    version: z.number().int().positive().optional(),
  }, withPermission('get_document', auth, async ({ document_id, version }) => {
    const result = await services.documentService.getById(document_id, version, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('update_document', {
    document_id: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    change_summary: z.string().optional(),
  }, withPermission('update_document', auth, async ({ document_id, ...data }) => {
    const author_id = resolveActor(auth);
    const result = await services.documentService.update(document_id, { ...data, author_id }, undefined, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('set_document_status', {
    document_id: z.string(),
    status: z.enum(['in_review', 'approved']),
    expected_version: z.number().int().positive(),
  }, withPermission('set_document_status', auth, async ({ document_id, status, expected_version }) => {
    const result = await services.documentService.setStatus(document_id, { status, expected_version }, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('get_document_history', {
    document_id: z.string(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('get_document_history', auth, async ({ document_id, cursor, limit }) => {
    const result = await services.documentService.getHistoryPage(document_id, { cursor, limit }, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('delete_document', { document_id: z.string() }, withPermission('delete_document', auth, async ({ document_id }) => {
    await services.documentService.delete(document_id, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Document ${document_id} deleted` }) }] };
  }));

}
