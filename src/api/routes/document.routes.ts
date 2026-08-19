// File: src/api/routes/document.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { DocumentService } from '../../services/document.service.js';
import { AuditService } from '../../services/audit.service.js';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../../shared/auth-context.js';
import { config } from '../../config/index.js';
import { validateRequest } from '../middleware/validate.js';
import { collectionQuerySchema, documentCreateSchema, documentListQuerySchema, documentQuerySchema, documentStatusSchema, documentUpdateSchema, idParamsSchema, projectIdParamsSchema } from '../schemas.js';
import { DatabaseAdapter } from '../../db/adapter.js';

/**
 * Credentials are the only identity assertion in enforced mode. The legacy
 * author field remains an open-mode attribution convenience, never a way for
 * a network caller to choose who authored a document.
 */
function getActorId(req: Request, openModeClaim?: unknown): string | undefined {
  const auth: AuthContext | undefined = (req as any).authContext;
  if (auth?.principal?.id) return auth.principal.id;
  if (config.auth.mode === 'open' && typeof openModeClaim === 'string' && openModeClaim.length > 0) {
    return openModeClaim;
  }
  return undefined;
}

export function createDocumentRouter(_db: DatabaseAdapter, documentService: DocumentService, _auditService: AuditService): Router {
  const router = Router();

  router.get('/projects/:projectId/documents', ...validateRequest({ query: documentListQuerySchema, params: projectIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = req.query.status as string;
      const parent_id = req.query.parent_id === 'null' ? null : (req.query.parent_id as string);
      const docs = await documentService.listPage(req.params.projectId, { status, parent_id }, {
        cursor: req.query.cursor as string | undefined,
        limit: req.query.limit as number | undefined,
      });
      res.json(docs);
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:projectId/documents', ...validateRequest({ body: documentCreateSchema, params: projectIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { author_id: claimedAuthorId, ...data } = req.body;
      const doc = await documentService.create(
        { ...data, project_id: req.params.projectId },
        getActorId(req, claimedAuthorId)
      );
      res.status(201).json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.get('/documents/:id', ...validateRequest({ query: documentQuerySchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const version = typeof req.query.version === 'number' ? req.query.version : undefined;
      const doc = await documentService.getById(req.params.id, version);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      res.json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.put('/documents/:id', ...validateRequest({ body: documentUpdateSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { author_id: claimedAuthorId, ...data } = req.body;
      const doc = await documentService.update(req.params.id, data, getActorId(req, claimedAuthorId));
      res.json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/documents/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await documentService.delete(req.params.id, getActorId(req));
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/documents/:id/status', ...validateRequest({ body: documentStatusSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth: AuthContext = (req as any).authContext || OPEN_AUTH_CONTEXT;
      const doc = await documentService.setStatus(req.params.id, {
        status: req.body.status,
        expected_version: req.body.expected_version,
        ip: req.ip,
      }, auth);
      res.json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.get('/documents/:id/versions', ...validateRequest({ query: collectionQuerySchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const history = await documentService.getHistoryPage(req.params.id, {
        cursor: req.query.cursor as string | undefined,
        limit: req.query.limit as number | undefined,
      });
      res.json(history);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
