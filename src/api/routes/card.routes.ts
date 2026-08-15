// File: src/api/routes/card.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { CardService } from '../../services/card.service.js';
import { CommentService } from '../../services/comment.service.js';
import { AuthContext } from '../../shared/auth-context.js';
import { config } from '../../config/index.js';

function getActorId(req: Request): string | undefined {
  const auth: AuthContext | undefined = (req as any).authContext;
  return auth?.principal?.id;
}

function mayUseOperatorOverride(req: Request, requested: unknown): boolean {
  if (requested !== true) return false;
  const auth: AuthContext | undefined = (req as any).authContext;
  return config.auth.mode === 'open' || auth?.is_operator_override === true;
}

/**
 * Like getActorId, but falls back to a caller-supplied identity hint in the
 * request body — ONLY in open mode (checked explicitly, not inferred from an
 * absent principal). See resolveActor() in src/mcp/server.ts for the full
 * rationale: open mode has no differential trust to spoof across, enforced
 * mode does, so the fallback must never fire there.
 *
 * Accepts either `author_id` or `agent_id` in the body — mirrors resolveActor()
 * in src/mcp/server.ts, which supports both spellings for the same reason.
 */
function getActorIdWithOpenModeFallback(req: Request): string | undefined {
  const principalId = getActorId(req);
  if (principalId) return principalId;
  if (config.auth.mode === 'open') {
    const candidate = req.body?.author_id ?? req.body?.agent_id;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Row-level scope check for comment PUT/DELETE: a principal may only edit or
 * delete their own comments unless they hold workspace.admin. Mirrors
 * requireCommentOwnershipOrAdmin() in src/mcp/server.ts.
 */
async function requireCommentOwnershipOrAdmin(
  commentService: CommentService,
  req: Request,
  commentId: string,
): Promise<boolean> {
  const auth: AuthContext | undefined = (req as any).authContext;
  if (!auth?.principal) return true; // open mode — no differential trust to enforce
  if (auth.permissions.includes('workspace.admin')) return true;
  return commentService.validateCommentOwnership(commentId, auth.principal.id);
}

export function createCardRouter(cardService: CardService, commentService: CommentService): Router {
  const router = Router();

  router.get('/projects/:projectId/cards/search', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cards = await cardService.searchByTitle(req.params.projectId, (req.query.q as string) || '', {
        excludeCardId: req.query.exclude_card_id as string | undefined,
      });
      res.json(cards);
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects/:projectId/cards', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cards = await cardService.list({
        project_id: req.params.projectId,
        column_id: req.query.column_id as string,
        assignee_id: req.query.assignee_id as string,
        label: req.query.label as string,
        archived: req.query.archived === 'true',
      });
      res.json(cards);
    } catch (err) {
      next(err);
    }
  });

  router.get('/boards/:boardId/cards', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cards = await cardService.list({
        board_id: req.params.boardId,
        column_id: req.query.column_id as string,
        assignee_id: req.query.assignee_id as string,
        label: req.query.label as string,
        archived: req.query.archived === 'true',
      });
      res.json(cards);
    } catch (err) {
      next(err);
    }
  });

  router.post('/columns/:columnId/cards', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const card = await cardService.create(
        { ...req.body, column_id: req.params.columnId },
        getActorId(req),
        { operatorOverride: mayUseOperatorOverride(req, req.body?.operator_override) },
      );
      res.status(201).json(card);
    } catch (err) {
      next(err);
    }
  });

  router.get('/cards/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const card = await cardService.getById(req.params.id);
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  router.put('/cards/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getActorId(req);
      const card = await cardService.update(req.params.id, req.body, actorId, {
        operatorOverride: mayUseOperatorOverride(req, req.body?.operator_override),
      });
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/cards/:id/move', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getActorId(req);
      const card = await cardService.move(req.params.id, req.body, actorId, {
        operatorOverride: mayUseOperatorOverride(req, req.body?.operator_override),
      });
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  router.post('/cards/:id/comments', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Identity is derived from the credential whenever one resolved a
      // principal; the body's author_id is only a fallback for open mode,
      // where there is no principal to derive from.
      const authorId = getActorIdWithOpenModeFallback(req);
      if (!authorId) {
        res.status(400).json({ error: 'author_id (or agent_id) is required' });
        return;
      }
      const comment = await commentService.create({ ...req.body, author_id: authorId, card_id: req.params.id });
      res.status(201).json(comment);
    } catch (err) {
      next(err);
    }
  });

  router.put('/cards/:id/comments/:commentId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const allowed = await requireCommentOwnershipOrAdmin(commentService, req, req.params.commentId);
      if (!allowed) {
        res.status(403).json({ error: 'forbidden', message: 'You may only edit your own comments' });
        return;
      }
      const comment = await commentService.update(req.params.commentId, req.body.content, getActorId(req));
      res.json(comment);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/cards/:id/comments/:commentId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const allowed = await requireCommentOwnershipOrAdmin(commentService, req, req.params.commentId);
      if (!allowed) {
        res.status(403).json({ error: 'forbidden', message: 'You may only delete your own comments' });
        return;
      }
      await commentService.delete(req.params.commentId, getActorId(req));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post('/cards/:id/claim', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.body.agent_id || getActorId(req);
      if (!agentId) {
        res.status(400).json({ error: 'agent_id is required to claim a card' });
        return;
      }
      const result = await cardService.claim(
        req.params.id,
        agentId,
        req.body.ttl_seconds,
        getActorId(req) || agentId,
        { operatorOverride: mayUseOperatorOverride(req, req.body?.operator_override) },
      );
      res.status('success' in result && result.success === false ? 409 : 200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/cards/:id/assignees', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await cardService.assign(req.params.id, req.body.agent_id);
      const card = await cardService.getById(req.params.id);
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/cards/:id/assignees/:agentId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await cardService.unassign(req.params.id, req.params.agentId);
      const card = await cardService.getById(req.params.id);
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  router.post('/cards/:id/labels', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await cardService.addLabel(req.params.id, req.body.label_id);
      const card = await cardService.getById(req.params.id);
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/cards/:id/labels/:labelId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await cardService.removeLabel(req.params.id, req.params.labelId);
      const card = await cardService.getById(req.params.id);
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/cards/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getActorId(req);
      await cardService.delete(req.params.id, actorId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });


  // Document links
  router.post('/cards/:id/documents', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await cardService.linkDocument(req.params.id, req.body.document_id);
      const card = await cardService.getById(req.params.id);
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/cards/:id/documents/:documentId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await cardService.unlinkDocument(req.params.id, req.params.documentId);
      const card = await cardService.getById(req.params.id);
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  // Card-to-card links
  router.post('/cards/:id/links', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getActorId(req);
      await cardService.linkCard(req.params.id, req.body.target_card_id, req.body.relation_type, actorId);
      const card = await cardService.getById(req.params.id);
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/cards/:id/links/:linkId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getActorId(req);
      await cardService.unlinkCard(req.params.id, req.params.linkId, actorId);
      const card = await cardService.getById(req.params.id);
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  // Work links (branches, PRs, commits, pipelines)
  router.get('/cards/:id/work-links', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const links = await cardService.listWorkLinks(req.params.id);
      res.json(links);
    } catch (err) {
      next(err);
    }
  });

  router.post('/cards/:id/work-links', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getActorId(req);
      await cardService.addWorkLink(req.params.id, req.body, actorId);
      const card = await cardService.getById(req.params.id);
      res.status(201).json(card);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/cards/:id/work-links/:linkId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getActorId(req);
      await cardService.removeWorkLink(req.params.id, req.params.linkId, actorId);
      const card = await cardService.getById(req.params.id);
      res.json(card);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
