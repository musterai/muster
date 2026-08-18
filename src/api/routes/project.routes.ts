// File: src/api/routes/project.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { ProjectService } from '../../services/project.service.js';
import { AuditService } from '../../services/audit.service.js';
import { AuthContext } from '../../shared/auth-context.js';
import { validateRequest } from '../middleware/validate.js';
import { idParamsSchema, projectCreateSchema, projectUpdateSchema } from '../schemas.js';
import { DatabaseAdapter } from '../../db/adapter.js';

export function createProjectRouter(db: DatabaseAdapter, projectService: ProjectService, auditService: AuditService): Router {
  const router = Router();

  router.get('/', ...validateRequest(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projects = await projectService.list();
      res.json(projects);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', ...validateRequest({ body: projectCreateSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await projectService.create(req.body);
      res.status(201).json(project);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await projectService.getById(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      res.json(project);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', ...validateRequest({ body: projectUpdateSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await projectService.update(req.params.id, req.body);
      res.json(project);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await projectService.getById(req.params.id);
      await db.transaction(async tx => {
        await projectService.delete(req.params.id, req.authContext?.principal?.id, tx);
        const auth: AuthContext | undefined = (req as any).authContext;
        await auditService.logAs(auth, {
          action: 'project.delete',
          target_type: 'project',
          target_id: req.params.id,
          payload: project ? { name: project.name } : undefined,
          ip: req.ip,
        }, tx);
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/summary', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const summary = await projectService.getSummary(req.params.id);
      res.json(summary);
    } catch (err: any) {
      if (err?.message?.includes('not found')) {
        return res.status(404).json({ error: err.message });
      }
      next(err);
    }
  });

  return router;
}
