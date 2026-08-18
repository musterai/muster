// File: src/api/middleware/permission-guard.ts
//
// Express middleware that checks the authenticated principal's permissions
// against the REST route permission map before allowing the request through.

import { Request, Response, NextFunction } from 'express';
import { AuthContext } from '../../shared/auth-context.js';
import { requireRestPermission, PermissionDeniedError } from '../../shared/permission-enforcer.js';

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

  // The auth routes (login/callback/logout/me) are the mechanism by which a
  // principal is established in the first place — they cannot themselves
  // require a permission the caller has no way to hold yet. The device-code
  // and token endpoints of the Device Authorization Grant (MUS-28), and MCP
  // OAuth's client registration and authorize hand-off (MUS-29), are the
  // same story for a not-yet-authenticated CLI/MCP client; device/lookup|
  // approve|deny and authorize/details|consent are NOT exempted — those run
  // as the already-signed-in approving user.
  const PUBLIC_AUTH_PATH = /^\/api\/v1\/auth\/(?:login|callback|logout|me|local)$/;
  const PUBLIC_OAUTH_PATHS = new Set([
    '/api/v1/oauth/device/code',
    '/api/v1/oauth/token',
    '/api/v1/oauth/register',
    '/api/v1/oauth/authorize',
  ]);
  if (PUBLIC_AUTH_PATH.test(fullPath) || PUBLIC_OAUTH_PATHS.has(fullPath)) {
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
