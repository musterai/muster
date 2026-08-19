// File: src/api/routes/board.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { BoardService } from '../../services/board.service.js';
import { ColumnService } from '../../services/column.service.js';
import { CardService } from '../../services/card.service.js';
import { validateRequest } from '../middleware/validate.js';
import { boardCreateSchema, boardUpdateSchema, idParamsSchema, projectIdParamsSchema } from '../schemas.js';

export function createBoardRouter(
  boardService: BoardService,
  columnService: ColumnService,
  cardService: CardService
): Router {
  const router = Router();

  router.get('/projects/:projectId/boards', ...validateRequest({ params: projectIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const boards = await boardService.list(req.params.projectId, req.authContext);
      res.json(boards);
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects/:projectId/all-boards', ...validateRequest({ params: projectIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const boards = await boardService.list(req.params.projectId, req.authContext);
      const cards = await cardService.list({ project_id: req.params.projectId }, req.authContext);
      const columnsList = await Promise.all(boards.map((b) => columnService.list(b.id, req.authContext)));
      const columns = columnsList.flat();

      res.json({
        id: 'all',
        project_id: req.params.projectId,
        name: 'All Boards',
        slug: 'all',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        boards,
        columns,
        cards,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:projectId/boards', ...validateRequest({ body: boardCreateSchema, params: projectIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const board = await boardService.create({ ...req.body, project_id: req.params.projectId }, undefined, undefined, req.authContext);
      res.status(201).json(board);
    } catch (err) {
      next(err);
    }
  });

  router.get('/boards/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const board = await boardService.getById(req.params.id, req.authContext);
      if (!board) return res.status(404).json({ error: 'Board not found' });
      const columns = await columnService.list(board.id, req.authContext);
      const cards = await cardService.list({ board_id: board.id }, req.authContext);
      res.json({ ...board, columns, cards });
    } catch (err) {
      next(err);
    }
  });

  router.put('/boards/:id', ...validateRequest({ body: boardUpdateSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const board = await boardService.update(req.params.id, req.body, undefined, undefined, req.authContext);
      res.json(board);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/boards/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await boardService.delete(req.params.id, undefined, undefined, req.authContext);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
