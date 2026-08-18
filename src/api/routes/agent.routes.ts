// File: src/api/routes/agent.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { AgentService } from '../../services/agent.service.js';
import { CardService } from '../../services/card.service.js';
import { AuthContext } from '../../shared/auth-context.js';
import { validateRequest } from '../middleware/validate.js';
import { agentRegisterSchema, agentUpdateSchema, idParamsSchema } from '../schemas.js';
import { config } from '../../config/index.js';
import { PermissionDeniedError } from '../../shared/permission-enforcer.js';

function getAuth(req: Request): AuthContext | undefined {
  return (req as any).authContext;
}

function getOperatorUserId(req: Request): string | undefined {
  const auth: AuthContext | undefined = (req as any).authContext;
  return auth?.principal?.kind === 'user' ? auth.principal.id : undefined;
}

async function requireAgentScope(agentService: AgentService, req: Request, agentId: string): Promise<void> {
  if (config.auth.mode === 'open') return;
  const auth = getAuth(req);
  if (!auth?.principal || !auth.is_workspace_member || !auth.workspace_id) {
    throw new PermissionDeniedError('workspace.read', auth?.role_name || null);
  }
  const target = await agentService.getById(agentId);
  if (!target || target.workspace_id !== auth.workspace_id) {
    // Resolve the target workspace before any admin/self bypass. This keeps
    // cross-workspace and missing targets deliberately indistinguishable.
    throw new PermissionDeniedError('agent.manage_others', auth.role_name);
  }
  if (auth.permissions.includes('workspace.admin')) return;
  if (auth.principal.kind === 'agent' && auth.principal.id === agentId) return;
  if (auth.principal.kind !== 'user') {
    throw new PermissionDeniedError('agent.manage_others', auth.role_name);
  }
  try {
    const ownerId = await agentService.validateAgentOwnership(agentId, auth.principal.id, auth.workspace_id);
    if (!ownerId) throw new Error('Agent is not in scope');
  } catch {
    // Deliberately do not distinguish missing, cross-workspace, unassigned,
    // or another operator's agent.
    throw new PermissionDeniedError('agent.manage_others', auth.role_name);
  }
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
      const auth = getAuth(req);
      const agent = await agentService.register(
        req.body,
        getOperatorUserId(req),
        undefined,
        auth?.workspace_id || undefined,
        config.auth.mode === 'enforced' ? auth?.principal : null,
      );
      res.status(201).json(agent);
    } catch (err) {
      next(err);
    }
  });

  router.post('/agents/:id/heartbeat', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await requireAgentScope(agentService, req, req.params.id);
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
      await requireAgentScope(agentService, req, req.params.id);
      const auth = getAuth(req);
      const agent = await agentService.update(req.params.id, req.body, {
        workspaceId: auth?.workspace_id || undefined,
        allowIdentityChanges: auth?.permissions.includes('workspace.admin') || false,
      });
      res.json(agent);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/agents/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await requireAgentScope(agentService, req, req.params.id);
      await agentService.unregister(req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
