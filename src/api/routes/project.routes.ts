// File: src/api/routes/project.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { ProjectService } from '../../services/project.service.js';
import { AuditService } from '../../services/audit.service.js';
import { AuthContext } from '../../shared/auth-context.js';
import { validateRequest } from '../middleware/validate.js';
import { collectionQuerySchema, idParamsSchema, projectCreateSchema, projectUpdateSchema } from '../schemas.js';
import { DatabaseAdapter } from '../../db/adapter.js';

export function createProjectRouter(db: DatabaseAdapter, projectService: ProjectService, auditService: AuditService): Router {
  const router = Router();

  router.get('/', ...validateRequest({ query: collectionQuerySchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projects = await projectService.listPage({
        cursor: req.query.cursor as string | undefined,
        limit: req.query.limit as number | undefined,
      }, req.authContext);
      res.json(projects);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', ...validateRequest({ body: projectCreateSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await projectService.create(req.body, req.authContext?.principal?.id, undefined, req.authContext);
      res.status(201).json(project);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await projectService.getById(req.params.id, req.authContext);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      res.json(project);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', ...validateRequest({ body: projectUpdateSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await projectService.update(req.params.id, req.body, req.authContext?.principal?.id, undefined, req.authContext);
      res.json(project);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await db.transaction(async tx => {
        const projectRows = await tx.query<{ name: string }>('SELECT name FROM project WHERE id = ?', [req.params.id]);
        const project = projectRows[0];
        await projectService.delete(req.params.id, req.authContext?.principal?.id, tx, req.authContext);
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
      const summary = await projectService.getSummary(req.params.id, req.authContext);
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
