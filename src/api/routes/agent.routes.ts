// File: src/api/routes/agent.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { AgentService } from '../../services/agent.service.js';
import { CardService } from '../../services/card.service.js';
import { AuthContext } from '../../shared/auth-context.js';
import { validateRequest } from '../middleware/validate.js';
import { agentRegisterSchema, agentUpdateSchema, idParamsSchema } from '../schemas.js';

function getActorId(req: Request): string | undefined {
  const auth: AuthContext | undefined = (req as any).authContext;
  return auth?.principal?.id;
}

export function createAgentRouter(agentService: AgentService, cardService: CardService): Router {
  const router = Router();

  // Global agent list
  router.get('/agents', ...validateRequest(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agents = await agentService.list();
      res.json(agents);
    } catch (err) {
      next(err);
    }
  });

  // Register a new global agent (or re-bind existing session)
  router.post('/agents', ...validateRequest({ body: agentRegisterSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agent = await agentService.register(req.body, getActorId(req));
      res.status(201).json(agent);
    } catch (err) {
      next(err);
    }
  });

  router.post('/agents/:id/heartbeat', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agent = await agentService.heartbeat(req.params.id);
      await cardService.renewClaims(req.params.id);
      res.json(agent);
    } catch (err) {
      next(err);
    }
  });

  // Update agent attributes
  router.put('/agents/:id', ...validateRequest({ body: agentUpdateSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agent = await agentService.update(req.params.id, req.body);
      res.json(agent);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/agents/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await agentService.unregister(req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
