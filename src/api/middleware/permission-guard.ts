// File: src/api/middleware/permission-guard.ts
//
// Express middleware that checks the authenticated principal's permissions
// against the REST route permission map before allowing the request through.

import { Request, Response, NextFunction } from 'express';
import { AuthContext } from '../../shared/auth-context.js';
import { requireRestPermission, PermissionDeniedError } from '../../shared/permission-enforcer.js';
import { isPublicRoute } from '../../shared/public-routes.js';

declare global {
  namespace Express {
    interface Request {
      authContext?: AuthContext;
    }
  }
}

export function permissionGuard(req: Request, res: Response, next: NextFunction): void {
  // req.path is relative to wherever this middleware is mounted — inside the
  // nested v1 router it comes back as e.g. "/health", not "/api/v1/health",
  // which silently fails every anchored pattern in REST_ROUTE_PERMISSIONS.
  // req.originalUrl is the one representation that is stable regardless of
  // router nesting depth, so route matching (and the /auth/ exemption below)
  // must use it, not req.path.
  const fullPath = req.originalUrl.split('?')[0];

  // Bootstrap and protocol discovery routes are the only unauthenticated
  // exceptions.  Keep this decision in the shared exact allowlist used by
  // auth middleware; prefix-based exemptions would make future routes public.
  if (isPublicRoute(req.method, fullPath)) {
    next();
    return;
  }

  const auth = req.authContext;
  if (!auth) {
    // No auth context — unlikely but guard against it
    res.status(403).json({
      error: 'forbidden',
      message: 'No authentication context available',
    });
    return;
  }

  try {
    const input = req.body && typeof req.body === 'object' ? req.body : undefined;
    requireRestPermission(req.method, fullPath, auth, input);
    next();
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      res.status(403).json(err.refusal);
      return;
    }
    next(err);
  }
}
