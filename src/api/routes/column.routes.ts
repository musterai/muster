// File: src/api/routes/column.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { ColumnService } from '../../services/column.service.js';
import { validateRequest } from '../middleware/validate.js';
import { boardIdParamsSchema, columnCreateSchema, columnUpdateSchema, idParamsSchema } from '../schemas.js';

export function createColumnRouter(columnService: ColumnService): Router {
  const router = Router();

  router.post('/boards/:boardId/columns', ...validateRequest({ body: columnCreateSchema, params: boardIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const column = await columnService.create({ ...req.body, board_id: req.params.boardId }, undefined, undefined, req.authContext);
      res.status(201).json(column);
    } catch (err) {
      next(err);
    }
  });

  router.put('/columns/:id', ...validateRequest({ body: columnUpdateSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const column = await columnService.update(req.params.id, req.body, undefined, undefined, req.authContext);
      res.json(column);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/columns/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await columnService.delete(req.params.id, undefined, undefined, req.authContext);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
