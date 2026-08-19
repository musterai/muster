// File: src/api/middleware/auth.ts
//
// Authentication middleware. Two credential kinds feed the same AuthContext:
//   - Authorization: Bearer <token>  — PATs (MUS-24), used by agents and by
//     API clients acting as a user.
//   - the session cookie (MUS-25) — browser logins via OIDC.
//
// Under MUSTER_AUTH_MODE=open, requests without either credential fall
// through to OPEN_AUTH_CONTEXT (local dev). Under enforced mode, missing or
// invalid credentials return 401 — except for the exact bootstrap, health,
// and protocol-discovery routes in shared/public-routes.ts.
//
// The middleware never distinguishes "no such credential" from "wrong
// credential" in timing, message, or status code.

import { Request, Response, NextFunction } from 'express';
import { DatabaseAdapter } from '../../db/adapter.js';
import { TokenService } from '../../services/token.service.js';
import { RoleService } from '../../services/role.service.js';
import { AgentService } from '../../services/agent.service.js';
import { SessionService } from '../../services/session.service.js';
import { AuthContext, OPEN_AUTH_CONTEXT } from '../../shared/auth-context.js';
import { config } from '../../config/index.js';
import { parseCookies } from '../../shared/cookies.js';
import { isPublicRoute } from '../../shared/public-routes.js';
import { getRetryAfterMs, recordFailedAttempt, recordSuccessfulAttempt } from './rate-limiter.js';
import { bootstrapWorkspaceId } from '../../services/helpers/workspace-scope.helper.js';

export const SESSION_COOKIE_NAME = 'muster_session';

/**
 * A 401 to /mcp specifically must look like an OAuth resource-server
 * challenge (MCP Authorization spec / RFC 9728) — the WWW-Authenticate
 * header naming the protected-resource metadata URL is what tells a
 * spec-compliant MCP client to go start the OAuth flow (MUS-29) instead of
 * just failing. Every other 401 (plain REST API calls) is unaffected.
 */
function send401(req: Request, res: Response, body: { error: string; message: string }): void {
  if (req.path === '/mcp') {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${config.oidc.publicUrl}/.well-known/oauth-protected-resource"`);
  }
  res.status(401).json(body);
}

/** Resolve a user's effective permissions and role name within a workspace. */
async function resolveUserPermissions(
  db: DatabaseAdapter,
  userId: string,
  workspaceId: string | null,
): Promise<{ permissions: string[]; roleName: string | null; isWorkspaceMember: boolean }> {
  if (!workspaceId) return { permissions: [], roleName: null, isWorkspaceMember: false };

  const memberRows = await db.query<any>(
    `SELECT wm.role_id, r.name as role_name, r.permissions_json, u.status
     FROM workspace_member wm
     JOIN role r ON r.id = wm.role_id AND r.workspace_id = wm.workspace_id
     JOIN app_user u ON u.id = wm.user_id
     WHERE wm.user_id = ? AND wm.workspace_id = ?`,
    [userId, workspaceId],
  );

  if (memberRows.length === 0 || memberRows[0].status !== 'active') {
    return { permissions: [], roleName: null, isWorkspaceMember: false };
  }

  const permissions = typeof memberRows[0].permissions_json === 'string'
    ? JSON.parse(memberRows[0].permissions_json)
    : (memberRows[0].permissions_json || []);

  return {
    permissions,
    roleName: memberRows[0].role_name || null,
    isWorkspaceMember: true,
  };
}

/**
 * Agents are workspace members only through an active operator membership.
 * Merely retaining an agent row or nominal role after operator offboarding
 * must not preserve implicit read access.
 */
async function resolveAgentWorkspaceMembership(
  db: DatabaseAdapter,
  agentId: string,
  workspaceId: string | null,
): Promise<boolean> {
  if (!workspaceId) return false;

  const rows = await db.query<{ id: string }>(
    `SELECT a.id
       FROM agent a
       JOIN app_user op ON op.id = a.operator_user_id
       JOIN workspace_member wm
         ON wm.user_id = a.operator_user_id
        AND wm.workspace_id = a.workspace_id
      WHERE a.id = ?
        AND a.workspace_id = ?
        AND a.status = 'active'
        AND op.status = 'active'
      LIMIT 1`,
    [agentId, workspaceId],
  );
  return rows.length === 1;
}

export function createAuthMiddleware(
  db: DatabaseAdapter,
  tokenService: TokenService,
  roleService: RoleService,
  agentService: AgentService,
  sessionService: SessionService,
) {
  return async function authMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      // Only /api and /mcp ever read req.authContext — everything else
      // (static assets, the SPA shell) must load with no credential at
      // all, or an unauthenticated visitor could never reach the page
      // that has the "Sign in" button on it in enforced mode.
      if (!req.path.startsWith('/api/') && req.path !== '/mcp') {
        next();
        return;
      }

      const authHeader = req.headers.authorization;
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const isPublic = isPublicRoute(req.method, req.path);

      // Locked out from prior failed bearer attempts — refuse before touching the token
      if (authHeader) {
        const retryAfterMs = getRetryAfterMs(clientIp);
        if (retryAfterMs > 0) {
          _res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
          _res.status(429).json({
            error: 'rate_limited',
            message: 'Too many failed authentication attempts. Try again later.',
          });
          return;
        }
      }

      // ── Bearer token path (PATs) ──
      if (authHeader) {
        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
          recordFailedAttempt(clientIp);
          if (config.auth.mode === 'enforced' && !isPublic) {
            send401(req, _res, { error: 'unauthorized', message: 'Authentication required.' });
            return;
          }
          (req as any).authContext = OPEN_AUTH_CONTEXT;
          next();
          return;
        }

        const tokenString = parts[1];
        const verification = await tokenService.verify(tokenString);

        if (!verification) {
          recordFailedAttempt(clientIp);
          if (config.auth.mode === 'enforced' && !isPublic) {
            send401(req, _res, { error: 'unauthorized', message: 'Authentication required.' });
            return;
          }
          (req as any).authContext = OPEN_AUTH_CONTEXT;
          next();
          return;
        }

        recordSuccessfulAttempt(clientIp);

        const principals = await db.query<{ kind: string }>('SELECT kind FROM principal WHERE id = ?', [verification.principal_id]);
        const principalKind = principals.length > 0 ? (principals[0].kind as 'user' | 'agent') : 'user';

        let permissions: string[] = [];
        let roleName: string | null = null;
        let isOperatorOverride = false;
        let isWorkspaceMember = false;

        if (principalKind === 'agent') {
          permissions = await roleService.getEffectivePermissions(
            verification.principal_id,
            verification.workspace_id,
          );
          const agent = await agentService.getById(verification.principal_id);
          isWorkspaceMember = await resolveAgentWorkspaceMembership(
            db,
            verification.principal_id,
            verification.workspace_id,
          );
          if (!isWorkspaceMember) {
            // Do not carry a nominal agent role across operator offboarding;
            // it would both leak stale role metadata and make a future
            // boundary mistake more dangerous.
            permissions = [];
          } else if (agent?.role_id) {
            const role = await roleService.getById(agent.role_id);
            roleName = role?.name || null;
          }
        } else {
          const resolved = await resolveUserPermissions(db, verification.principal_id, verification.workspace_id);
          permissions = resolved.permissions;
          roleName = resolved.roleName;
          isWorkspaceMember = resolved.isWorkspaceMember;
          isOperatorOverride = permissions.includes('workspace.admin');
        }

        (req as any).authContext = {
          principal: { kind: principalKind, id: verification.principal_id },
          workspace_id: verification.workspace_id,
          is_workspace_member: isWorkspaceMember,
          permissions,
          is_operator_override: isOperatorOverride,
          role_name: roleName,
        } satisfies AuthContext;
        next();
        return;
      }

      // ── Session cookie path (browser logins, MUS-25) ──
      const cookies = parseCookies(req.headers.cookie);
      const sessionToken = cookies[SESSION_COOKIE_NAME];

      if (sessionToken) {
        const verification = await sessionService.verify(sessionToken);

        if (!verification) {
          recordFailedAttempt(clientIp);
          if (config.auth.mode === 'enforced' && !isPublic) {
            send401(req, _res, { error: 'unauthorized', message: 'Authentication required.' });
            return;
          }
          (req as any).authContext = OPEN_AUTH_CONTEXT;
          next();
          return;
        }

        recordSuccessfulAttempt(clientIp);

        const workspaceId = await bootstrapWorkspaceId(db);
        const { permissions, roleName, isWorkspaceMember } = await resolveUserPermissions(
          db,
          verification.user_id,
          workspaceId,
        );

        // Membership and account status are part of session validity, not a
        // one-time check at login.  Revoke a stale session immediately so a
        // removed or suspended user cannot keep presenting it forever.  The
        // current request still receives a zero-permission context and is
        // denied by the route/MCP boundary without revealing membership data.
        if (!isWorkspaceMember) {
          await sessionService.revokeById(verification.id);
        }

        (req as any).authContext = {
          principal: { kind: 'user', id: verification.user_id },
          workspace_id: workspaceId,
          is_workspace_member: isWorkspaceMember,
          permissions,
          is_operator_override: permissions.includes('workspace.admin'),
          role_name: roleName,
        } satisfies AuthContext;
        next();
        return;
      }

      // No credential at all — use OPEN_AUTH_CONTEXT in open mode or on the auth routes, 401 in enforced
      if (config.auth.mode === 'enforced' && !isPublic) {
        send401(req, _res, { error: 'unauthorized', message: 'Authentication required.' });
        return;
      }
      (req as any).authContext = OPEN_AUTH_CONTEXT;
      next();
    } catch (err) {
      next(err);
    }
  };
}
