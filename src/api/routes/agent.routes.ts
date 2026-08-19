// File: src/api/routes/agent.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { AgentService } from '../../services/agent.service.js';
import { CardService } from '../../services/card.service.js';
import { AuthContext } from '../../shared/auth-context.js';
import { validateRequest } from '../middleware/validate.js';
import { agentRegisterSchema, agentUpdateSchema, idParamsSchema } from '../schemas.js';
import { config } from '../../config/index.js';
import { DatabaseAdapter } from '../../db/adapter.js';
import { AuditService } from '../../services/audit.service.js';

function getAuth(req: Request): AuthContext | undefined {
  return (req as any).authContext;
}

function getOperatorUserId(req: Request): string | undefined {
  const auth: AuthContext | undefined = (req as any).authContext;
  return auth?.principal?.kind === 'user' ? auth.principal.id : undefined;
}

export function createAgentRouter(
  dbOrService: DatabaseAdapter | AgentService,
  serviceOrCards: AgentService | CardService,
  cardsOrAudit?: CardService | AuditService,
  maybeAudit?: AuditService,
): Router {
  const db = (maybeAudit ? dbOrService : (dbOrService as any).db) as DatabaseAdapter;
  const agentService = (maybeAudit ? serviceOrCards : dbOrService) as AgentService;
  const cardService = (maybeAudit ? cardsOrAudit : serviceOrCards) as CardService;
  const auditService = (maybeAudit || (cardsOrAudit as AuditService) || new AuditService(db)) as AuditService;
  const router = Router();

  // Global agent list
  router.get('/agents', ...validateRequest(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = getAuth(req);
      const agents = await agentService.list(config.auth.mode === 'enforced' ? auth?.workspace_id : undefined);
      res.json(agents);
    } catch (err) {
      next(err);
    }
  });

  // Register a new global agent (or re-bind existing session)
  router.post('/agents', ...validateRequest({ body: agentRegisterSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = getAuth(req);
      const agent = await agentService.register(
        req.body,
        getOperatorUserId(req),
        undefined,
        auth?.workspace_id || undefined,
        config.auth.mode === 'enforced' ? auth : null,
      );
      res.status(201).json(agent);
    } catch (err) {
      next(err);
    }
  });

  router.post('/agents/:id/heartbeat', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = getAuth(req);
      const agent = await agentService.heartbeat(req.params.id, auth);
      await cardService.renewClaims(req.params.id);
      res.json(agent);
    } catch (err) {
      next(err);
    }
  });

  // Update agent attributes
  router.put('/agents/:id', ...validateRequest({ body: agentUpdateSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = getAuth(req);
      const agent = await agentService.update(req.params.id, req.body, {
        workspaceId: auth?.workspace_id || undefined,
        allowIdentityChanges: auth?.permissions.includes('workspace.admin') || false,
        auth,
      });
      res.json(agent);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/agents/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = getAuth(req);
      const agent = await agentService.assertAgentScope(req.params.id, auth, 'agent.manage_others');
      await db.transaction(async tx => {
        await agentService.unregister(req.params.id, auth?.principal?.id, tx, auth);
        await auditService.logAs(auth, {
          workspace_id: agent?.workspace_id || auth?.workspace_id || null,
          action: 'agent.unregister',
          target_type: 'agent',
          target_id: req.params.id,
          payload: agent ? { name: agent.name } : undefined,
          ip: req.ip,
        }, tx);
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
