import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDatabaseAdapter } from '../src/db/factory.js';
import type { DatabaseAdapter, ExecutionResult } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { DocumentService } from '../src/services/document.service.js';
import { EventService } from '../src/services/event.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { createDocumentRouter } from '../src/api/routes/document.routes.js';
import { permissionGuard } from '../src/api/middleware/permission-guard.js';
import { errorHandler } from '../src/api/middleware/error-handler.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { Services } from '../src/shared/services.js';
import type { AuthContext } from '../src/shared/auth-context.js';
import { PermissionDeniedError } from '../src/shared/permission-enforcer.js';
import { config } from '../src/config/index.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-document-state-machine.db');
const WORKSPACE_ID = 'ws-document-state';
const PROJECT_ID = 'project-document-state';

function auth(
  id: string,
  role_name: string,
  permissions: string[],
): AuthContext {
  return {
    principal: { kind: 'user', id },
    workspace_id: WORKSPACE_ID,
    is_workspace_member: true,
    permissions,
    is_operator_override: false,
    role_name,
  };
}

describe('MUS-60 document review state machine', () => {
  let db: DatabaseAdapter;
  let documents: DocumentService;
  let server: ReturnType<typeof express.application.listen> | undefined;
  const originalMode = config.auth.mode;
  const junior = auth('junior-user', 'junior_engineer', ['doc.update', 'doc.submit_review']);
  const senior = auth('senior-user', 'senior_engineer', ['doc.update', 'doc.submit_review']);
  const architect = auth('architect-user', 'architect', ['doc.update', 'doc.submit_review', 'doc.approve']);

  beforeEach(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* clean slate */ }
    }
    db = createDatabaseAdapter(TEST_DB);
    await new Migrator(db, path.join(process.cwd(), 'src/db/migrations')).run();
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [WORKSPACE_ID, 'Document State', 'document-state', now, now],
    );
    await db.execute(
      'INSERT INTO project (id, workspace_id, name, key_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [PROJECT_ID, WORKSPACE_ID, 'Document State', 'DOC', now, now],
    );
    for (const [id, name] of [['junior-user', 'Junior'], ['senior-user', 'Senior'], ['architect-user', 'Architect']]) {
      await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [id, 'user', now]);
      await db.execute(
        'INSERT INTO app_user (id, display_name, status, created_at) VALUES (?, ?, ?, ?)',
        [id, name, 'active', now],
      );
    }
    documents = new DocumentService(db, new EventService(db), new AuditService(db));
    (config.auth as any).mode = 'enforced';
  });

  afterEach(async () => {
    (config.auth as any).mode = originalMode;
    await new Promise<void>(resolve => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    });
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* cleanup */ }
    }
  });

  it('allows only forward transitions, checks role at the service boundary, and permits qualified self-approval', async () => {
    const doc = await documents.create(
      { project_id: PROJECT_ID, title: 'State machine', content: 'draft' },
      architect.principal!.id,
    );

    await expect(documents.setStatus(doc.id, {
      status: 'approved',
      expected_version: 1,
    }, architect)).rejects.toMatchObject({ code: 'DOCUMENT_TRANSITION_INVALID' });

    const submitted = await documents.setStatus(doc.id, {
      status: 'in_review',
      expected_version: 1,
    }, senior);
    expect(submitted.status).toBe('in_review');

    await expect(documents.setStatus(doc.id, {
      status: 'approved',
      expected_version: 1,
    }, senior)).rejects.toBeInstanceOf(PermissionDeniedError);

    const approved = await documents.setStatus(doc.id, {
      status: 'approved',
      expected_version: 1,
    }, architect);
    expect(approved.status).toBe('approved');

    await expect(documents.setStatus(doc.id, {
      status: 'approved',
      expected_version: 1,
    }, architect)).rejects.toMatchObject({ code: 'DOCUMENT_TRANSITION_INVALID' });
    await expect(documents.setStatus(doc.id, {
      status: 'in_review',
      expected_version: 1,
    }, architect)).rejects.toMatchObject({ code: 'DOCUMENT_TRANSITION_INVALID' });
    await expect(documents.setStatus(doc.id, {
      status: 'archived' as any,
      expected_version: 1,
    }, architect)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(documents.update(doc.id, {
      content: 'must not change',
      change_summary: 'post approval edit',
    }, architect.principal!.id)).rejects.toMatchObject({ code: 'DOCUMENT_APPROVED_IMMUTABLE' });

    const history = await documents.getHistory(doc.id);
    expect(history).toHaveLength(1);
    const audits = await db.query<{ actor_id: string; action: string; payload: string }>(
      'SELECT actor_id, action, payload FROM audit_log WHERE target_id = ? ORDER BY created_at, action',
      [doc.id],
    );
    expect(audits).toHaveLength(2);
    expect(audits.map(row => row.action).sort()).toEqual(['document.approve', 'document.submit_review']);
    expect(audits.map(row => row.actor_id).sort()).toEqual(['architect-user', 'senior-user']);
    for (const row of audits) {
      expect(JSON.parse(row.payload)).toMatchObject({
        project_id: PROJECT_ID,
        version: 1,
      });
      expect(JSON.parse(row.payload)).toHaveProperty('from_status');
      expect(JSON.parse(row.payload)).toHaveProperty('to_status');
    }

    const juniorDoc = await documents.create({ project_id: PROJECT_ID, title: 'Junior submit', content: 'draft' });
    await expect(documents.setStatus(juniorDoc.id, {
      status: 'in_review',
      expected_version: 1,
    }, junior)).resolves.toMatchObject({ status: 'in_review' });
    await expect(documents.setStatus(juniorDoc.id, {
      status: 'approved',
      expected_version: 1,
    }, junior)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('rejects stale versions and serializes concurrent approval without phantom history or audit rows', async () => {
    const doc = await documents.create({ project_id: PROJECT_ID, title: 'Concurrent', content: 'v1' });
    await documents.setStatus(doc.id, { status: 'in_review', expected_version: 1 }, senior);
    const edited = await documents.update(doc.id, { content: 'v2', change_summary: 'review fix' }, 'senior-user');

    await expect(documents.setStatus(doc.id, {
      status: 'approved',
      expected_version: 1,
    }, architect)).rejects.toMatchObject({ code: 'DOCUMENT_VERSION_CONFLICT' });

    const attempts = await Promise.allSettled([
      documents.setStatus(doc.id, { status: 'approved', expected_version: edited.version }, architect),
      documents.setStatus(doc.id, { status: 'approved', expected_version: edited.version }, architect),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await documents.getById(doc.id))?.status).toBe('approved');
    expect(await documents.getHistory(doc.id)).toHaveLength(2);
    expect(await db.query(
      "SELECT id FROM audit_log WHERE target_id = ? AND action = 'document.approve'",
      [doc.id],
    )).toHaveLength(1);
  });

  it('rolls back status, event, and audit together when canonical audit insertion fails', async () => {
    const doc = await documents.create({ project_id: PROJECT_ID, title: 'Atomic', content: 'draft' });
    const failingAudit = {
      logAs: vi.fn(async () => { throw new Error('audit unavailable'); }),
    } as unknown as AuditService;
    const failingService = new DocumentService(db, new EventService(db), failingAudit);

    await expect(failingService.setStatus(doc.id, {
      status: 'in_review',
      expected_version: 1,
    }, senior)).rejects.toThrow('audit unavailable');
    expect((await documents.getById(doc.id))?.status).toBe('draft');
    expect(await db.query(
      "SELECT id FROM event WHERE entity_id = ? AND action = 'status_changed'",
      [doc.id],
    )).toHaveLength(0);
  });

  it('keeps REST and MCP permission refusals and successful transitions in parity', async () => {
    const doc = await documents.create({ project_id: PROJECT_ID, title: 'Transport parity', content: 'draft' });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const role = req.headers['x-test-role'];
      (req as any).authContext = role === 'architect' ? architect : role === 'junior' ? junior : senior;
      next();
    });
    const v1 = express.Router();
    v1.use(permissionGuard);
    v1.use(createDocumentRouter(db, documents, new AuditService(db)));
    app.use('/api/v1', v1);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const submitResponse = await fetch(`${baseUrl}/api/v1/documents/${doc.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-role': 'senior' },
      body: JSON.stringify({ status: 'in_review', expected_version: 1 }),
    });
    expect(submitResponse.status).toBe(200);

    const restRefusalResponse = await fetch(`${baseUrl}/api/v1/documents/${doc.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-role': 'senior' },
      body: JSON.stringify({ status: 'approved', expected_version: 1 }),
    });
    expect(restRefusalResponse.status).toBe(403);
    const restRefusal = await restRefusalResponse.json();

    const juniorRestDoc = await documents.create({ project_id: PROJECT_ID, title: 'Junior REST', content: 'draft' });
    const juniorSubmit = await fetch(`${baseUrl}/api/v1/documents/${juniorRestDoc.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-role': 'junior' },
      body: JSON.stringify({ status: 'in_review', expected_version: 1 }),
    });
    expect(juniorSubmit.status).toBe(200);
    const juniorApprove = await fetch(`${baseUrl}/api/v1/documents/${juniorRestDoc.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-role': 'junior' },
      body: JSON.stringify({ status: 'approved', expected_version: 1 }),
    });
    expect(juniorApprove.status).toBe(403);

    const mcpServices = {
      db,
      documentService: documents,
      auditService: new AuditService(db),
    } as Services;
    const seniorMcp = createMcpServer(mcpServices, undefined, senior) as any;
    await expect(seniorMcp._registeredTools.set_document_status.handler({
      document_id: doc.id,
      status: 'approved',
      expected_version: 1,
    }, {})).rejects.toMatchObject({ refusal: restRefusal });

    const juniorMcpDoc = await documents.create({ project_id: PROJECT_ID, title: 'Junior MCP', content: 'draft' });
    const juniorMcp = createMcpServer(mcpServices, undefined, junior) as any;
    await expect(juniorMcp._registeredTools.set_document_status.handler({
      document_id: juniorMcpDoc.id,
      status: 'in_review',
      expected_version: 1,
    }, {})).resolves.toBeDefined();
    await expect(juniorMcp._registeredTools.set_document_status.handler({
      document_id: juniorMcpDoc.id,
      status: 'approved',
      expected_version: 1,
    }, {})).rejects.toMatchObject({ refusal: await juniorApprove.json() });

    const architectMcp = createMcpServer(mcpServices, undefined, architect) as any;
    const approvalResult = await architectMcp._registeredTools.set_document_status.handler({
      document_id: doc.id,
      status: 'approved',
      expected_version: 1,
    }, {});
    expect(JSON.parse(approvalResult.content[0].text).status).toBe('approved');

    const missingVersion = await fetch(`${baseUrl}/api/v1/documents/${doc.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-role': 'architect' },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(missingVersion.status).toBe(400);
    await expect(architectMcp._registeredTools.set_document_status.handler({
      document_id: doc.id,
      status: 'draft',
      expected_version: 1,
    }, {})).rejects.toThrow();
  });

  it('uses a PostgreSQL row lock and compare-and-set predicate before accepting a transition', async () => {
    const queries: string[] = [];
    const writes: string[] = [];
    const row = {
      id: 'pg-document',
      project_id: PROJECT_ID,
      parent_id: null,
      title: 'PG',
      content: 'draft',
      status: 'draft' as const,
      author_id: null,
      version: 3,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const adapter: DatabaseAdapter = {
      dialect: 'postgres',
      query: async <T>(sql: string) => {
        queries.push(sql);
        return [row] as T[];
      },
      execute: async (sql: string): Promise<ExecutionResult> => {
        writes.push(sql);
        return { changes: 1 };
      },
      transaction: async <T>(fn: (tx: DatabaseAdapter) => Promise<T>) => fn(adapter),
      migrate: async () => undefined,
      close: async () => undefined,
    };
    const audit = { logAs: vi.fn(async () => undefined) } as unknown as AuditService;
    const service = new DocumentService(adapter, undefined, audit);

    const transitioned = await service.setStatus('pg-document', {
      status: 'in_review',
      expected_version: 3,
    }, senior);
    expect(transitioned.status).toBe('in_review');
    expect(queries[0]).toMatch(/SELECT \* FROM document WHERE id = \? FOR UPDATE$/);
    expect(writes[0]).toMatch(/WHERE id = \? AND status = \? AND version = \?$/);
    expect(audit.logAs).toHaveBeenCalledOnce();
  });
});
