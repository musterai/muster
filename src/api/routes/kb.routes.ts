// File: src/api/routes/kb.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { KBService } from '../../services/kb.service.js';
import { validateRequest } from '../middleware/validate.js';
import {
  idParamsSchema,
  kbActorSchema,
  kbCreateSchema,
  kbEntityCreateSchema,
  kbEntityKnowledgeQuerySchema,
  kbEntityListQuerySchema,
  kbEntityUpdateSchema,
  kbFactsQuerySchema,
  kbFactCreateSchema,
  kbFactUpdateSchema,
  kbGraphQuerySchema,
  kbListQuerySchema,
  kbProjectLinkSchema,
  kbRelationCreateSchema,
  kbSearchQuerySchema,
} from '../schemas.js';

export function createKBRouter(kbService: KBService): Router {
  const router = Router();

  // List Knowledge Bases (optionally filtered by project_id)
  router.get('/kbs', ...validateRequest({ query: kbListQuerySchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.query.project_id as string | undefined;
      const kbs = await kbService.list(projectId);
      res.json(kbs);
    } catch (err) {
      next(err);
    }
  });

  // Create Knowledge Base
  router.post('/kbs', ...validateRequest({ body: kbCreateSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const kb = await kbService.create(req.body, req.body?.actor_id || undefined);
      res.status(201).json(kb);
    } catch (err) {
      next(err);
    }
  });

  // Search Knowledge across KBs
  router.get('/kbs/search', ...validateRequest({ query: kbSearchQuerySchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = (req.query.q as string) || '';
      const kbId = req.query.kb_id as string | undefined;
      const projectId = req.query.project_id as string | undefined;

      let kbIds: string[] | undefined;
      if (kbId) {
        kbIds = [kbId];
      } else if (projectId) {
        const kbs = await kbService.list(projectId);
        kbIds = kbs.map(k => k.id);
      }

      const results = await kbService.searchKnowledge(query, kbIds);
      res.json(results);
    } catch (err) {
      next(err);
    }
  });

  // Get Graph Tree for visualization
  router.get('/kbs/graph', ...validateRequest({ query: kbGraphQuerySchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const kbId = req.query.kb_id as string | undefined;
      const projectId = req.query.project_id as string | undefined;
      const tree = await kbService.getGraphTree(kbId, projectId);
      res.json(tree);
    } catch (err) {
      next(err);
    }
  });

  // Get canonical entity knowledge (entity profile + facts + graph edges)
  router.get('/kbs/entity-knowledge', ...validateRequest({ query: kbEntityKnowledgeQuerySchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = (req.query.q as string) || (req.query.identifier as string);
      if (!q) return res.status(400).json({ error: 'Query parameter q or identifier is required' });

      const kbId = req.query.kb_id as string | undefined;
      const result = await kbService.getEntityKnowledge(q, kbId ? [kbId] : undefined);
      if (!result) return res.status(404).json({ error: 'Entity knowledge not found' });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Get KB by ID
  router.get('/kbs/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const kb = await kbService.getById(req.params.id);
      if (!kb) return res.status(404).json({ error: 'Knowledge base not found' });
      res.json(kb);
    } catch (err) {
      next(err);
    }
  });

  // Delete KB
  router.delete('/kbs/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await kbService.delete(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Link Project to KB
  router.post('/kbs/:id/link', ...validateRequest({ body: kbProjectLinkSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { project_id } = req.body;
      if (!project_id) return res.status(400).json({ error: 'project_id is required' });
      await kbService.linkProject(req.params.id, project_id, req.body?.actor_id || undefined);
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // Unlink Project from KB
  router.post('/kbs/:id/unlink', ...validateRequest({ body: kbProjectLinkSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { project_id } = req.body;
      if (!project_id) return res.status(400).json({ error: 'project_id is required' });
      await kbService.unlinkProject(req.params.id, project_id);
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // List Entities in KB
  router.get('/kbs/:id/entities', ...validateRequest({ query: kbEntityListQuerySchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const type = req.query.type as string | undefined;
      const entities = await kbService.listEntities(req.params.id, type);
      res.json(entities);
    } catch (err) {
      next(err);
    }
  });

  // Upsert Entity
  router.post('/kbs/entities', ...validateRequest({ body: kbEntityCreateSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entity = await kbService.upsertEntity(req.body, req.body?.actor_id || undefined);
      res.status(201).json(entity);
    } catch (err) {
      next(err);
    }
  });

  // Update Entity
  router.put('/kbs/entities/:id', ...validateRequest({ body: kbEntityUpdateSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entity = await kbService.updateEntity(req.params.id, req.body, req.body?.actor_id || undefined);
      res.json(entity);
    } catch (err) {
      next(err);
    }
  });

  // Delete Entity
  router.delete('/kbs/entities/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await kbService.deleteEntity(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // List Facts in KB
  router.get('/kbs/:id/facts', ...validateRequest({ query: kbFactsQuerySchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entityId = req.query.entity_id as string | undefined;
      const category = req.query.category as string | undefined;
      const facts = await kbService.listFacts(req.params.id, entityId, category);
      res.json(facts);
    } catch (err) {
      next(err);
    }
  });

  // Add Gained Knowledge Fact
  router.post('/kbs/facts', ...validateRequest({ body: kbFactCreateSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fact = await kbService.addFact(req.body, req.body?.actor_id || undefined);
      res.status(201).json(fact);
    } catch (err) {
      next(err);
    }
  });

  // Update Fact
  router.put('/kbs/facts/:id', ...validateRequest({ body: kbFactUpdateSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fact = await kbService.updateFact(req.params.id, req.body, req.body?.actor_id || undefined);
      res.json(fact);
    } catch (err) {
      next(err);
    }
  });

  // Delete Fact
  router.delete('/kbs/facts/:id', ...validateRequest({ body: kbActorSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await kbService.deleteFact(req.params.id, req.body?.actor_id || undefined);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Add Graph Relation
  router.post('/kbs/relations', ...validateRequest({ body: kbRelationCreateSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const relation = await kbService.addRelation(req.body, req.body?.actor_id || undefined);
      res.status(201).json(relation);
    } catch (err) {
      next(err);
    }
  });

  // Delete Relation
  router.delete('/kbs/relations/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await kbService.deleteRelation(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
