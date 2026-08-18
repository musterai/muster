// File: src/api/routes/auth.routes.ts
//
// MUS-25: OIDC login, browser sessions, and workspace admission.
//
// GET  /auth/login     — redirect to the IdP's authorization endpoint
// GET  /auth/callback  — exchange the code, resolve/create the user, admit
//                        into the workspace if possible, start a session
// POST /auth/logout    — revoke the session server-side
// GET  /auth/me        — report the current authenticated/admitted state
//
// Invitation management:
// POST   /workspaces/:workspaceId/invitations
// GET    /workspaces/:workspaceId/invitations
// DELETE /invitations/:id

import { Router, Request, Response, NextFunction } from 'express';
import { OidcService } from '../../services/oidc.service.js';
import { SessionService } from '../../services/session.service.js';
import { UserService } from '../../services/user.service.js';
import { InvitationService } from '../../services/invitation.service.js';
import { RoleService } from '../../services/role.service.js';
import { AuditService } from '../../services/audit.service.js';
import { DatabaseAdapter } from '../../db/adapter.js';
import { config, isOidcConfigured } from '../../config/index.js';
import { parseCookies, serializeCookie, clearCookieHeader } from '../../shared/cookies.js';
import { SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import {
  authCallbackQuerySchema,
  authLocalSchema,
  authLoginQuerySchema,
  idParamsSchema,
  invitationCreateBodySchema,
  workspaceIdParamsSchema,
} from '../schemas.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Only same-origin, absolute-path redirect targets are honored — never a full URL (open-redirect risk). */
function sanitizeRedirectTo(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

function isSecureRequest(req: Request): boolean {
  return req.protocol === 'https' || config.oidc.publicUrl.startsWith('https');
}

export function createAuthRouter(
  db: DatabaseAdapter,
  oidcService: OidcService,
  sessionService: SessionService,
  userService: UserService,
  invitationService: InvitationService,
  roleService: RoleService,
  auditService: AuditService,
): Router {
  const router = Router();

  router.get('/auth/login', ...validateRequest({ query: authLoginQuerySchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isOidcConfigured()) {
        res.status(503).json({ error: 'oidc_not_configured', message: 'OIDC is not configured on this server.' });
        return;
      }
      const redirectUri = `${config.oidc.publicUrl}/api/v1/auth/callback`;
      const redirectTo = sanitizeRedirectTo(req.query.redirect_to);
      const url = await oidcService.buildLoginUrl(redirectUri, redirectTo);
      res.redirect(url);
    } catch (err) {
      next(err);
    }
  });

  router.get('/auth/callback', ...validateRequest({ query: authCallbackQuerySchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isOidcConfigured()) {
        res.status(503).json({ error: 'oidc_not_configured', message: 'OIDC is not configured on this server.' });
        return;
      }

      const currentUrl = new URL(req.originalUrl, config.oidc.publicUrl);
      const result = await oidcService.handleCallback(currentUrl);

      const { user } = await userService.findOrCreateBySubject(config.oidc.issuer!, result.sub, result.email);

      const wsRows = await db.query<{ id: string }>('SELECT id FROM workspace LIMIT 1');
      const workspaceId = wsRows[0]?.id;

      let admitted = false;
      if (workspaceId) {
        admitted = await userService.isWorkspaceMember(workspaceId, user.id);

        if (!admitted) {
          const isFirstUser = await userService.isWorkspaceEmpty(workspaceId);
          const isBootstrapOwner = !!config.oidc.bootstrapOwnerSubject && config.oidc.bootstrapOwnerSubject === result.sub;

          if (isFirstUser || isBootstrapOwner) {
            const ownerRole = await roleService.getByKey(workspaceId, 'owner');
            if (ownerRole) {
              await userService.addWorkspaceMember(workspaceId, user.id, ownerRole.id, null);
              admitted = true;
            }
          } else if (result.email) {
            const invite = await invitationService.findPendingByEmail(workspaceId, result.email);
            if (invite) {
              await invitationService.accept(invite.id, user.id);
              admitted = true;
              await auditService.log({
                workspace_id: workspaceId,
                actor: { id: user.id, kind: 'user' },
                action: 'invitation.accept',
                target_type: 'invitation',
                target_id: invite.id,
                payload: { email: result.email },
                ip: req.ip || null,
              });
            }
          }
        }
      }

      // A session is created regardless of admission — the user IS
      // authenticated; "admitted" (workspace membership) is a separate gate
      // enforced by requireRestPermission/requirePermission on every route.
      const session = await sessionService.create(user.id, {
        userAgent: req.headers['user-agent'] || null,
        ip: req.ip || null,
        ttlMs: SESSION_TTL_MS,
      });

      res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, session.token, {
        httpOnly: true,
        secure: isSecureRequest(req),
        sameSite: 'Lax',
        maxAgeSeconds: SESSION_TTL_MS / 1000,
      }));

      const destination = result.redirectTo || '/';
      const separator = destination.includes('?') ? '&' : '?';
      res.redirect(`${destination}${separator}admitted=${admitted}`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/auth/logout', ...validateRequest(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const sessionToken = cookies[SESSION_COOKIE_NAME];
      if (sessionToken) {
        await sessionService.revokeByToken(sessionToken);
      }
      res.setHeader('Set-Cookie', clearCookieHeader(SESSION_COOKIE_NAME));
      res.json({ message: 'Logged out' });
    } catch (err) {
      next(err);
    }
  });

  router.get('/auth/me', ...validateRequest(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const wsRows = await db.query<{ id: string; name: string }>('SELECT id, name FROM workspace LIMIT 1');
      const workspace = wsRows[0] || null;

      const auth = req.authContext;
      if (!auth?.principal || auth.principal.kind !== 'user') {
        res.json({ authenticated: false, admitted: false, user: null, role: null, workspace, auth_mode: config.auth.mode });
        return;
      }

      const admitted = auth.permissions.length > 0 || !!auth.role_name;
      const userRows = await db.query<any>(
        'SELECT id, email, display_name, avatar_url, status FROM app_user WHERE id = ?',
        [auth.principal.id],
      );

      res.json({
        authenticated: true,
        admitted,
        user: userRows[0] || null,
        role: auth.role_name,
        workspace,
        auth_mode: config.auth.mode,
      });
    } catch (err) {
      next(err);
    }
  });

  // Open-mode-only: establish a human identity with no OIDC involved. A
  // request already carries full trust in open mode (OPEN_AUTH_CONTEXT
  // grants everything); this just gives that trust a name — a real
  // app_user + session, so the person can appear as themselves instead of
  // being stuck picking an existing agent to post comments as. Explicitly
  // gated on config.auth.mode, never inferred, same convention as the
  // self-asserted comment author fallback.
  router.post('/auth/local', ...validateRequest({ body: authLocalSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (config.auth.mode !== 'open') {
        res.status(404).json({ error: 'not_found', message: 'Not available outside open mode.' });
        return;
      }

      const userIdParam = typeof req.body?.user_id === 'string' ? req.body.user_id.trim() : null;
      const displayNameParam = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : null;

      let user: any = null;

      if (userIdParam) {
        user = await userService.findById(userIdParam);
      } else if (displayNameParam) {
        user = await userService.findByDisplayName(displayNameParam);
        if (!user) {
          if (displayNameParam.length > 80) {
            res.status(400).json({ error: 'bad_request', message: 'display_name must be 80 characters or fewer' });
            return;
          }
          user = await userService.createLocalUser(displayNameParam);
        }
      }

      if (!user) {
        res.status(400).json({ error: 'bad_request', message: 'user_id or display_name is required' });
        return;
      }

      const wsRows = await db.query<{ id: string }>('SELECT id FROM workspace LIMIT 1');
      const workspaceId = wsRows[0]?.id || null;

      if (workspaceId) {
        const isMember = await userService.isWorkspaceMember(workspaceId, user.id);
        if (!isMember) {
          const ownerRole = await roleService.getByKey(workspaceId, 'owner');
          if (ownerRole) {
            await userService.addWorkspaceMember(workspaceId, user.id, ownerRole.id, null);
          }
        }
      }

      const session = await sessionService.create(user.id, {
        userAgent: req.headers['user-agent'] || null,
        ip: req.ip || null,
        ttlMs: SESSION_TTL_MS,
      });

      res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, session.token, {
        httpOnly: true,
        secure: isSecureRequest(req),
        sameSite: 'Lax',
        maxAgeSeconds: SESSION_TTL_MS / 1000,
      }));

      await auditService.log({
        workspace_id: workspaceId,
        actor: { id: user.id, kind: 'user' },
        action: 'user.local_identity_create',
        target_type: 'user',
        target_id: user.id,
        payload: { display_name: user.display_name },
        ip: req.ip || null,
      });

      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  });

  // ── Invitations ──

  router.post('/workspaces/:workspaceId/invitations', ...validateRequest({ body: invitationCreateBodySchema, params: workspaceIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, role_id } = req.body;
      if (!email || !role_id) {
        res.status(400).json({ error: 'bad_request', message: 'email and role_id are required' });
        return;
      }
      const createdBy = req.authContext?.principal?.kind === 'user' ? req.authContext.principal.id : null;
      const invitation = await invitationService.create({
        workspace_id: req.params.workspaceId,
        email,
        role_id,
        created_by: createdBy,
      });
      await auditService.logAs(req.authContext, {
        workspace_id: req.params.workspaceId,
        action: 'invitation.create',
        target_type: 'invitation',
        target_id: invitation.id,
        payload: { email, role_id },
        ip: req.ip,
      });
      res.status(201).json(invitation);
    } catch (err) {
      next(err);
    }
  });

  router.get('/workspaces/:workspaceId/invitations', ...validateRequest({ params: workspaceIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invitations = await invitationService.list(req.params.workspaceId);
      res.json(invitations);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/invitations/:id', ...validateRequest({ params: idParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invite = await invitationService.getById(req.params.id);
      await invitationService.revoke(req.params.id);
      await auditService.logAs(req.authContext, {
        workspace_id: invite?.workspace_id || null,
        action: 'invitation.revoke',
        target_type: 'invitation',
        target_id: req.params.id,
        payload: invite ? { email: invite.email } : undefined,
        ip: req.ip,
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
