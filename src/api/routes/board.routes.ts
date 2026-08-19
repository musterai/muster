// File: src/api/routes/board.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { BoardService } from '../../services/board.service.js';
import { ColumnService } from '../../services/column.service.js';
import { CardService } from '../../services/card.service.js';
import { validateRequest } from '../middleware/validate.js';
import { boardCreateSchema, boardUpdateSchema, collectionQuerySchema, idParamsSchema, projectIdParamsSchema } from '../schemas.js';

export function createBoardRouter(
  boardService: BoardService,
  columnService: ColumnService,
  cardService: CardService
): Router {
  const router = Router();

  router.get('/projects/:projectId/boards', ...validateRequest({ query: collectionQuerySchema, params: projectIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const boards = await boardService.listPage(req.params.projectId, {
        cursor: req.query.cursor as string | undefined,
        limit: req.query.limit as number | undefined,
      });
      res.json(boards);
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects/:projectId/all-boards', ...validateRequest({ query: collectionQuerySchema, params: projectIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const boardPage = await boardService.listPage(req.params.projectId, { limit: 100 });
      const boards = boardPage.items;
      const cards = await cardService.listPage({ project_id: req.params.projectId }, {
        cursor: req.query.cursor as string | undefined,
        limit: req.query.limit as number | undefined,
      });
      const columnsList = await Promise.all(boards.map((b) => columnService.list(b.id)));
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
        cards: cards.items,
        card_page: cards.page,
        board_page: boardPage.page,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:projectId/boards', ...validateRequest({ body: boardCreateSchema, params: projectIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const board = await boardService.create({ ...req.body, project_id: req.params.projectId });
      res.status(201).json(board);
    } catch (err) {
      next(err);
    }
  });

  router.get('/boards/:id', ...validateRequest({ query: collectionQuerySchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const board = await boardService.getById(req.params.id);
      if (!board) return res.status(404).json({ error: 'Board not found' });
      const columns = await columnService.list(board.id);
      const cards = await cardService.listPage({ board_id: board.id }, {
        cursor: req.query.cursor as string | undefined,
        limit: req.query.limit as number | undefined,
      });
      res.json({ ...board, columns, cards: cards.items, card_page: cards.page });
    } catch (err) {
      next(err);
    }
  });

  router.put('/boards/:id', ...validateRequest({ body: boardUpdateSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const board = await boardService.update(req.params.id, req.body);
      res.json(board);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/boards/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await boardService.delete(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
