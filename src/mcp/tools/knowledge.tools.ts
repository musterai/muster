import { z } from 'zod';
import { withPermission } from '../../shared/permission-enforcer.js';
import { resolveActor, type McpToolContext } from '../tool-context.js';

export function registerKnowledgeTools({ server, services, auth }: McpToolContext): void {
  const pageCursor = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional();
  const scope = {
    kb_id: z.string().min(1).optional(),
    project_id: z.string().min(1).optional(),
  };
  const scopeInput = (value: { kb_id?: string; project_id?: string }) => {
    if ((value.kb_id ? 1 : 0) + (value.project_id ? 1 : 0) !== 1) {
      throw new Error('Exactly one of kb_id or project_id is required');
    }
    return value;
  };
  const mcpJson = (value: unknown) => ({
    structuredContent: value as Record<string, unknown>,
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });
  // --- Event & Activity Tools ---
  server.tool('get_activity', {
    project_id: z.string(),
    entity_type: z.string().optional(),
    entity_id: z.string().optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('get_activity', auth, async ({ project_id, cursor, limit, ...filters }) => {
    const result = await services.eventService.listPage(project_id, filters, { cursor, limit }, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  // --- Knowledge Base Tools ---
  server.tool('list_knowledge_bases', {
    project_id: z.string().optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('list_knowledge_bases', auth, async ({ project_id, cursor, limit }) => {
    const kbs = await services.kbService.listPage(project_id, { cursor, limit }, auth);
    return { content: [{ type: 'text', text: JSON.stringify(kbs, null, 2) }] };
  }));

  server.tool('get_knowledge_overview', {
    ...scope,
    facet_limit: z.number().int().min(1).max(50).optional(),
  }, withPermission('get_knowledge_overview', auth, async (args) => {
    const selected = scopeInput(args);
    return mcpJson(await services.kbService.getKnowledgeOverview(selected, { facet_limit: args.facet_limit }, auth));
  }));

  server.tool('list_knowledge', {
    ...scope,
    cursor: pageCursor,
    limit: z.number().int().min(1).max(100).optional(),
    q: z.string().trim().min(1).max(512).optional(),
    category: z.string().optional(),
    entity_id: z.string().optional(),
    entity_type: z.string().optional(),
    attached: z.boolean().optional(),
    has_source: z.boolean().optional(),
  }, withPermission('list_knowledge', auth, async (args) => {
    scopeInput(args);
    const { kb_id, project_id, cursor, limit, q, category, entity_id, entity_type, attached, has_source } = args;
    return mcpJson(await services.kbService.listKnowledgePage(
      { kb_id, project_id },
      { q, category, entity_id, entity_type, attached, has_source },
      { cursor, limit },
      auth,
    ));
  }));

  server.tool('list_kb_entities', {
    ...scope,
    cursor: pageCursor,
    limit: z.number().int().min(1).max(100).optional(),
    type: z.string().optional(),
  }, withPermission('list_kb_entities', auth, async (args) => {
    scopeInput(args);
    const { kb_id, project_id, cursor, limit, type } = args;
    return mcpJson(await services.kbService.listScopedEntitiesPage(
      { kb_id, project_id }, { type }, { cursor, limit }, auth,
    ));
  }));

  server.tool('get_entity_context', {
    ...scope,
    entity_id: z.string().optional(),
    query: z.string().optional(),
    depth: z.number().int().min(0).max(2).optional(),
    max_nodes: z.number().int().min(1).max(100).optional(),
    max_edges: z.number().int().min(1).max(500).optional(),
    fact_cursor: pageCursor,
    fact_limit: z.number().int().min(1).max(100).optional(),
    relation_types: z.array(z.string()).max(50).optional(),
    entity_types: z.array(z.string()).max(50).optional(),
  }, withPermission('get_entity_context', auth, async (args) => {
    scopeInput(args);
    if (!args.entity_id && !args.query) throw new Error('Exactly one entity_id or query is required');
    if (args.entity_id && args.query) throw new Error('Exactly one entity_id or query is required');
    const { kb_id, project_id, entity_id, query, depth, max_nodes, max_edges, fact_cursor, fact_limit, relation_types, entity_types } = args;
    return mcpJson(await services.kbService.getEntityContext(
      { kb_id, project_id }, { entity_id, query },
      { depth, max_nodes, max_edges, fact_cursor, fact_limit, relation_types, entity_types }, auth,
    ));
  }));

  server.tool('list_kb_relations', {
    ...scope,
    entity_id: z.string().optional(),
    query: z.string().optional(),
    depth: z.number().int().min(1).max(2).optional(),
    max_edges: z.number().int().min(1).max(500).optional(),
  }, withPermission('list_kb_relations', auth, async (args) => {
    scopeInput(args);
    if (!args.entity_id && !args.query) throw new Error('Exactly one entity_id or query is required');
    if (args.entity_id && args.query) throw new Error('Exactly one entity_id or query is required');
    const { kb_id, project_id, entity_id, query, depth, max_edges } = args;
    const context = await services.kbService.getEntityContext(
      { kb_id, project_id }, { entity_id, query },
      { depth, max_edges, max_nodes: 100, fact_limit: 1 }, auth,
    );
    return mcpJson({ scope: context.scope, root: context.root, edges: context.edges, truncation: context.truncation });
  }));

  server.tool('create_knowledge_base', {
    name: z.string(),
    description: z.string().optional(),
    is_global: z.boolean().optional(),
    project_ids: z.array(z.string()).optional(),
    agent_id: z.string().optional(),
  }, withPermission('create_knowledge_base', auth, async (args) => {
    const kb = await services.kbService.create(args, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(kb, null, 2) }] };
  }));

  server.tool('link_knowledge_base', {
    kb_id: z.string(),
    project_id: z.string(),
    agent_id: z.string().optional(),
  }, withPermission('link_knowledge_base', auth, async (args) => {
    await services.kbService.linkProject(args.kb_id, args.project_id, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `KB ${args.kb_id} linked to project ${args.project_id}` }) }] };
  }));

  server.tool('search_knowledge', {
    query: z.string().trim().min(1).max(512).describe('Meaningful search terms or a natural-language question; stop-word-only queries are rejected'),
    kb_id: z.string().optional(),
    project_id: z.string().optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('search_knowledge', auth, async ({ query, kb_id, project_id, cursor, limit }) => {
    const results = await services.kbService.searchKnowledgePage(query, kb_id ? [kb_id] : undefined, { cursor, limit }, project_id, auth);
    return mcpJson(results);
  }));

  server.tool('get_entity_knowledge', {
    query: z.string().describe('Entity ID, canonical identifier (IP, email, hostname), or entity name'),
    kb_id: z.string().optional(),
    cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, withPermission('get_entity_knowledge', auth, async ({ query, kb_id, cursor, limit }) => {
    const result = await services.kbService.getEntityKnowledge(query, kb_id ? [kb_id] : undefined, { cursor, limit }, auth);
    if (!result) return { content: [{ type: 'text', text: `No entity knowledge found for \"${query}\"` }] };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  server.tool('get_gained_knowledge', {
    fact_id: z.string().min(1).describe('Knowledge fact ID returned by list or search summaries'),
  }, withPermission('get_gained_knowledge', auth, async ({ fact_id }) => {
    const fact = await services.kbService.getFactById(fact_id, auth);
    if (!fact) throw new Error(`Knowledge fact ${fact_id} not found`);
    return { content: [{ type: 'text', text: JSON.stringify(fact, null, 2) }] };
  }));

  server.tool('add_gained_knowledge', {
    kb_id: z.string(),
    title: z.string(),
    content: z.string(),
    category: z.string().optional(),
    entity_id: z.string().optional(),
    entity_name: z.string().optional(),
    entity_type: z.string().optional(),
    entity_identifier: z.string().optional(),
    confidence: z.number().optional(),
    agent_id: z.string().optional(),
  }, withPermission('add_gained_knowledge', auth, async (args) => {
    const actorId = resolveActor(auth);
    const fact = await services.kbService.addFact(args, actorId, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(fact, null, 2) }] };
  }));

  server.tool('upsert_kb_entity', {
    kb_id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    identifier: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    agent_id: z.string().optional(),
  }, withPermission('upsert_kb_entity', auth, async (args) => {
    const actorId = resolveActor(auth);
    const entity = await services.kbService.upsertEntity(args, actorId, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(entity, null, 2) }] };
  }));

  server.tool('update_gained_knowledge', {
    fact_id: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    category: z.string().optional(),
    entity_id: z.string().optional(),
    entity_name: z.string().optional(),
    entity_type: z.string().optional(),
    entity_identifier: z.string().optional(),
    confidence: z.number().optional(),
    agent_id: z.string().optional(),
  }, withPermission('update_gained_knowledge', auth, async ({ fact_id, ...data }) => {
    const actorId = resolveActor(auth);
    const fact = await services.kbService.updateFact(fact_id, data, actorId, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(fact, null, 2) }] };
  }));

  server.tool('update_kb_entity', {
    entity_id: z.string(),
    name: z.string().optional(),
    type: z.string().optional(),
    identifier: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    agent_id: z.string().optional(),
  }, withPermission('update_kb_entity', auth, async ({ entity_id, ...data }) => {
    const actorId = resolveActor(auth);
    const entity = await services.kbService.updateEntity(entity_id, data, actorId, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(entity, null, 2) }] };
  }));

  server.tool('add_kb_relation', {
    kb_id: z.string(),
    source_entity_id: z.string(),
    target_entity_id: z.string(),
    relation_type: z.string(),
    description: z.string().optional(),
    agent_id: z.string().optional(),
  }, withPermission('add_kb_relation', auth, async (args) => {
    const actorId = resolveActor(auth);
    const relation = await services.kbService.addRelation(args, actorId, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(relation, null, 2) }] };
  }));

}
