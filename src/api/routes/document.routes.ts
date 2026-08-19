// File: src/api/routes/document.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { DocumentService } from '../../services/document.service.js';
import { AuditService } from '../../services/audit.service.js';
import { AuthContext } from '../../shared/auth-context.js';
import { config } from '../../config/index.js';
import { validateRequest } from '../middleware/validate.js';
import { documentCreateSchema, documentListQuerySchema, documentQuerySchema, documentStatusSchema, documentUpdateSchema, idParamsSchema, projectIdParamsSchema } from '../schemas.js';
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

export function createDocumentRouter(db: DatabaseAdapter, documentService: DocumentService, auditService: AuditService): Router {
  const router = Router();

  router.get('/projects/:projectId/documents', ...validateRequest({ query: documentListQuerySchema, params: projectIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = req.query.status as string;
      const parent_id = req.query.parent_id === 'null' ? null : (req.query.parent_id as string);
      const docs = await documentService.list(req.params.projectId, { status, parent_id }, req.authContext);
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
        getActorId(req, claimedAuthorId), undefined, req.authContext
      );
      res.status(201).json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.get('/documents/:id', ...validateRequest({ query: documentQuerySchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const version = typeof req.query.version === 'number' ? req.query.version : undefined;
      const doc = await documentService.getById(req.params.id, version, req.authContext);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      res.json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.put('/documents/:id', ...validateRequest({ body: documentUpdateSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { author_id: claimedAuthorId, ...data } = req.body;
      const doc = await documentService.update(req.params.id, data, getActorId(req, claimedAuthorId), undefined, req.authContext);
      res.json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/documents/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await documentService.delete(req.params.id, getActorId(req), undefined, req.authContext);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/documents/:id/status', ...validateRequest({ body: documentStatusSchema, params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      let doc: Awaited<ReturnType<DocumentService['setStatus']>> | undefined;
      await db.transaction(async tx => {
        doc = await documentService.setStatus(req.params.id, req.body.status, getActorId(req), tx, req.authContext);
        if (req.body.status === 'approved') {
          const auth: AuthContext | undefined = (req as any).authContext;
          await auditService.logAs(auth, {
            action: 'document.approve',
            target_type: 'document',
            target_id: doc.id,
            payload: { title: doc.title, project_id: doc.project_id },
            ip: req.ip,
          }, tx);
        }
      });
      if (!doc) throw new Error('Document status update did not return a document');
      res.json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.get('/documents/:id/versions', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const history = await documentService.getHistory(req.params.id, req.authContext);
      res.json(history);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
