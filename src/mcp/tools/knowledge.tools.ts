import { z } from 'zod';
import { withPermission } from '../../shared/permission-enforcer.js';
import { resolveActor, type McpToolContext } from '../tool-context.js';

export function registerKnowledgeTools({ server, services, auth }: McpToolContext): void {
  // --- Event & Activity Tools ---
  server.tool('get_activity', {
    project_id: z.string(),
    entity_type: z.string().optional(),
    entity_id: z.string().optional(),
    limit: z.number().optional()
  }, withPermission('get_activity', auth, async ({ project_id, ...filters }) => {
    const result = await services.eventService.list(project_id, filters, auth);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }));

  // --- Knowledge Base Tools ---
  server.tool('list_knowledge_bases', { project_id: z.string().optional() }, withPermission('list_knowledge_bases', auth, async ({ project_id }) => {
    const kbs = await services.kbService.list(project_id, auth);
    return { content: [{ type: 'text', text: JSON.stringify(kbs, null, 2) }] };
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
    query: z.string(),
    kb_id: z.string().optional(),
    project_id: z.string().optional(),
    limit: z.number().optional()
  }, withPermission('search_knowledge', auth, async ({ query, kb_id, project_id, limit }) => {
    let kbIds: string[] | undefined;
    if (kb_id) {
      kbIds = [kb_id];
    } else if (project_id) {
      const kbs = await services.kbService.list(project_id, auth);
      kbIds = kbs.map(k => k.id);
    }
    const results = await services.kbService.searchKnowledge(query, kbIds, limit, auth);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }));

  server.tool('get_entity_knowledge', {
    query: z.string().describe('Entity ID, canonical identifier (IP, email, hostname), or entity name'),
    kb_id: z.string().optional()
  }, withPermission('get_entity_knowledge', auth, async ({ query, kb_id }) => {
    const result = await services.kbService.getEntityKnowledge(query, kb_id ? [kb_id] : undefined, auth);
    if (!result) return { content: [{ type: 'text', text: `No entity knowledge found for \"${query}\"` }] };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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

