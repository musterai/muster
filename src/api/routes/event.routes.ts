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

  router.get('/projects/:projectId/events/stream', ...validateRequest({ params: projectIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req.authContext;
      const workspaceId = await eventService.getProjectWorkspaceId(req.params.projectId);

      // Permission middleware establishes membership, but it cannot know
      // which project identifier is being streamed. Refuse a project from a
      // different workspace without confirming that it exists.
      if (auth?.is_workspace_member && (!auth.workspace_id || auth.workspace_id !== workspaceId)) {
        res.status(404).json({ error: 'not_found', message: 'Project not found.' });
        return;
      }

      const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const result = sseManager.addClient(req.params.projectId, clientId, res, {
        principalId: auth?.principal?.id,
        ip: req.ip || req.socket.remoteAddress,
        workspaceId,
      });
      if (!result.accepted) {
        res.setHeader('Retry-After', result.retryAfterSeconds.toString());
        res.status(429).json({
          error: 'sse_capacity_exceeded',
          message: 'SSE connection limit reached. Retry later.',
          scope: result.scope,
          retry_after_seconds: result.retryAfterSeconds,
        });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
