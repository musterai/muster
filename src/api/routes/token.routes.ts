// File: src/api/routes/token.routes.ts
//
// REST endpoints for Personal Access Token management (MUS-24).
// Token format: muster_pat_<prefix>_<secret>.
// POST  /tokens          — create (returns plaintext secret once)
// GET   /tokens          — list tokens for the authenticated principal
// DELETE /tokens/:id     — revoke a token

import { Router, Request, Response, NextFunction } from 'express';
import { TokenService } from '../../services/token.service.js';
import { AuditService } from '../../services/audit.service.js';
import { AuthContext } from '../../shared/auth-context.js';
import { ValidationError } from '../../shared/errors.js';
import { PermissionDeniedError } from '../../shared/permission-enforcer.js';

async function auditIssuanceRefusal(
  auditService: AuditService,
  auth: AuthContext | undefined,
  error: unknown,
  ip?: string,
): Promise<void> {
  if (!auth?.principal || !auth.workspace_id) return;
  if (!(error instanceof PermissionDeniedError) && !(error instanceof ValidationError)) return;
  try {
    await auditService.logAs(auth, {
      action: 'token.create_refused',
      target_type: 'api_token',
      target_id: undefined,
      // Never include request values here: a caller-controlled name could be
      // a secret, and target IDs should not become an enumeration oracle.
      payload: {
        via: 'rest',
        reason: error instanceof PermissionDeniedError ? 'forbidden' : 'invalid_request',
      },
      ip,
    });
  } catch {
    // An audit failure must not turn a safe refusal into a 500 response.
  }
}

export function createTokenRouter(tokenService: TokenService, auditService: AuditService): Router {
  const router = Router();

  // List tokens for the authenticated principal
  router.get('/tokens', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth: AuthContext | undefined = (req as any).authContext;
      if (!auth?.principal?.id) {
        res.status(401).json({ error: 'unauthorized', message: 'Not authenticated' });
        return;
      }
      const tokens = await tokenService.list(auth.principal.id);
      // Never expose token_hash — only list metadata
      res.json(tokens);
    } catch (err) {
      next(err);
    }
  });

  // Create a new token
  router.post('/tokens', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth: AuthContext = (req as any).authContext;
      if (!auth?.principal?.id) {
        res.status(401).json({ error: 'unauthorized', message: 'Not authenticated' });
        return;
      }

      const body = req.body || {};
      const created = await tokenService.issue(auth, {
        principal_id: body.target_principal_id,
        workspace_id: auth.workspace_id,
        name: body.name,
        expires_at: body.expires_at,
      });
      await auditService.logAs(auth, {
        action: 'token.create',
        target_type: 'api_token',
        target_id: created.id,
        // The plaintext token is intentionally absent; only the one-time
        // response below contains it.  Do not echo the caller's name either.
        payload: { principal_id: created.principal_id, via: 'rest' },
        ip: req.ip,
      });

      res.status(201).json(created);
    } catch (err) {
      const auth: AuthContext = (req as any).authContext;
      await auditIssuanceRefusal(auditService, auth, err, req.ip);
      next(err);
    }
  });

  // Revoke a token
  router.delete('/tokens/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth: AuthContext = (req as any).authContext;
      if (!auth?.principal?.id) {
        res.status(401).json({ error: 'unauthorized', message: 'Not authenticated' });
        return;
      }

      // Verify the token belongs to the authenticated principal
      const token = await tokenService.getById(req.params.id);
      if (!token) {
        res.status(404).json({ error: 'not_found', message: 'Token not found' });
        return;
      }

      if (token.principal_id !== auth.principal.id) {
        res.status(403).json({ error: 'forbidden', message: 'Token belongs to a different principal' });
        return;
      }

      if (token.revoked_at) {
        res.status(200).json({ message: 'Token already revoked', id: token.id });
        return;
      }

      await tokenService.revoke(req.params.id);
      await auditService.logAs(auth, {
        action: 'token.revoke',
        target_type: 'api_token',
        target_id: req.params.id,
        payload: { name: token.name },
        ip: req.ip,
      });
      res.status(200).json({ message: 'Token revoked', id: req.params.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
