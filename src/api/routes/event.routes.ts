// File: src/api/routes/event.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { EventService } from '../../services/event.service.js';
import { SSEManager } from '../../realtime/sse.js';
import { validateRequest } from '../middleware/validate.js';
import { eventQuerySchema, projectIdParamsSchema } from '../schemas.js';

export function createEventRouter(eventService: EventService, sseManager: SSEManager): Router {
  const router = Router();

  router.get('/projects/:projectId/events', ...validateRequest({ query: eventQuerySchema, params: projectIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const events = await eventService.list(req.params.projectId, {
        entity_type: req.query.entity_type as string,
        entity_id: req.query.entity_id as string,
        since: req.query.since as string,
        limit: typeof req.query.limit === 'number' ? req.query.limit : undefined,
      });
      res.json(events);
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects/:projectId/events/stream', ...validateRequest({ params: projectIdParamsSchema }), (req: Request, res: Response) => {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    sseManager.addClient(req.params.projectId, clientId, res);
  });

  return router;
}
