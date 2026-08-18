import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDocumentRouter } from '../src/api/routes/document.routes.js';
import { createKBRouter } from '../src/api/routes/kb.routes.js';
import { errorHandler } from '../src/api/middleware/error-handler.js';
import { config } from '../src/config/index.js';

describe('MUS-59 REST credential-derived attribution', () => {
  let server: ReturnType<typeof express.application.listen> | undefined;
  const originalMode = config.auth.mode;

  afterEach(async () => {
    (config.auth as any).mode = originalMode;
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    });
  });

  async function start(build: (app: express.Express) => void): Promise<string> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Deliberately differ from every caller-supplied ID used in the probes.
      (req as any).authContext = {
        principal: { kind: 'user', id: 'real-principal' },
        workspace_id: 'workspace-1',
        is_workspace_member: true,
        permissions: ['doc.create', 'doc.update', 'kb.write'],
        is_operator_override: false,
        role_name: 'senior_engineer',
      };
      next();
    });
    build(app);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve);
      server?.once('error', reject);
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('uses AuthContext rather than author_id for document creation and version edits', async () => {
    (config.auth as any).mode = 'enforced';
    const create = vi.fn(async (data: any, actorId: string | undefined) => ({
      id: 'document-1',
      project_id: data.project_id,
      parent_id: null,
      title: data.title,
      content: data.content,
      status: 'draft',
      author_id: actorId || null,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    const update = vi.fn(async (_id: string, data: any, actorId: string | undefined) => ({
      id: 'document-1',
      project_id: 'project-1',
      parent_id: null,
      title: data.title || 'original',
      content: data.content || 'original',
      status: 'draft',
      author_id: actorId || null,
      version: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    const baseUrl = await start(app => {
      app.use(createDocumentRouter({ create, update } as any, { logAs: vi.fn() } as any));
    });

    const createResponse = await fetch(`${baseUrl}/projects/project-1/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Credential-derived document',
        content: 'content',
        author_id: 'victim-principal',
      }),
    });
    expect(createResponse.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.not.objectContaining({ author_id: expect.anything() }),
      'real-principal',
    );

    const updateResponse = await fetch(`${baseUrl}/documents/document-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'edited content',
        author_id: 'second-victim-principal',
      }),
    });
    expect(updateResponse.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      'document-1',
      expect.not.objectContaining({ author_id: expect.anything() }),
      'real-principal',
    );
  });

  it('uses AuthContext for KB event actor and fact source instead of caller claims', async () => {
    (config.auth as any).mode = 'enforced';
    const create = vi.fn(async (data: any, actorId: string | undefined) => ({
      id: 'kb-1',
      ...data,
      is_global: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      actor_id: actorId,
    }));
    const upsertEntity = vi.fn(async (data: any, actorId: string | undefined) => ({
      id: 'entity-1',
      ...data,
      type: data.type || 'generic',
      identifier: data.identifier || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      actor_id: actorId,
    }));
    const addFact = vi.fn(async (data: any, actorId: string | undefined) => ({
      id: 'fact-1',
      ...data,
      entity_id: data.entity_id || null,
      category: data.category || 'general',
      confidence: data.confidence ?? 1,
      source_principal_id: actorId || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    const addRelation = vi.fn(async (data: any, actorId: string | undefined) => ({
      id: 'relation-1',
      ...data,
      description: data.description || null,
      created_at: new Date().toISOString(),
      actor_id: actorId,
    }));

    const baseUrl = await start(app => {
      app.use(createKBRouter({ create, upsertEntity, addFact, addRelation } as any));
    });

    const calls = [
      fetch(`${baseUrl}/kbs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Boundary KB', actor_id: 'event-victim' }),
      }),
      fetch(`${baseUrl}/kbs/entities`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kb_id: 'kb-1', name: 'Boundary entity', actor_id: 'event-victim' }),
      }),
      fetch(`${baseUrl}/kbs/facts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kb_id: 'kb-1', title: 'Boundary fact', content: 'content',
          actor_id: 'event-victim', source_principal_id: 'source-victim',
        }),
      }),
      fetch(`${baseUrl}/kbs/relations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kb_id: 'kb-1', source_entity_id: 'entity-1', target_entity_id: 'entity-2',
          relation_type: 'depends_on', actor_id: 'event-victim',
        }),
      }),
    ];
    for (const response of await Promise.all(calls)) expect(response.status).toBe(201);

    for (const spy of [create, upsertEntity, addFact, addRelation]) {
      const [data, actorId] = spy.mock.calls[0];
      expect(actorId).toBe('real-principal');
      expect(data).not.toHaveProperty('actor_id');
    }
    expect(addFact.mock.calls[0][0]).not.toHaveProperty('source_principal_id');
  });
});
