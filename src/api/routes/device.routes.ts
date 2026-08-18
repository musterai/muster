// File: src/api/routes/device.routes.ts
//
// OAuth 2.0 Device Authorization Grant (RFC 8628) for `muster login`
// (MUS-28).
//
// POST /oauth/device/code    — public: mint a device_code + user_code
// POST /oauth/token          — public: the CLI's poll
// GET  /oauth/device/lookup  — authenticated: what the user_code would authorise
// POST /oauth/device/approve — authenticated: approve as the signed-in user
// POST /oauth/device/deny    — authenticated: deny
//
// device/code and token are exempted from session/bearer auth in
// api/middleware/auth.ts and from the permission guard — they are the
// mechanism by which a not-yet-authenticated CLI bootstraps a credential
// in the first place, the same reasoning that exempts /auth/*.

import { Router, Request, Response, NextFunction } from 'express';
import { DatabaseAdapter } from '../../db/adapter.js';
import { DeviceGrantService } from '../../services/device-grant.service.js';
import { McpOAuthService } from '../../services/mcp-oauth.service.js';
import { AuthContext } from '../../shared/auth-context.js';
import { config } from '../../config/index.js';
import { getRetryAfterMs, recordFailedAttempt, recordSuccessfulAttempt } from '../middleware/rate-limiter.js';
import { createRateLimiter } from '../middleware/generic-rate-limiter.js';

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

// Generous enough for legitimate device-flow polling (every `interval`
// seconds, default 5s = ~12/min) plus normal authorization_code/refresh_token
// traffic, while still bounding a script hammering the endpoint.
const tokenRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60, message: 'Too many token requests. Try again later.' });

function normalizeCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

/**
 * /oauth/token is one endpoint shared by two grants: the device flow
 * (MUS-28) and MCP-native OAuth's authorization_code/refresh_token grants
 * (MUS-29) — both mint the same api_token shape, just via different
 * services, so they share the wire format and this dispatcher.
 */
export function createDeviceRouter(db: DatabaseAdapter, deviceGrantService: DeviceGrantService, oauthService?: McpOAuthService): Router {
  const router = Router();

  router.post('/oauth/device/code', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const retryAfterMs = getRetryAfterMs(clientIp);
      if (retryAfterMs > 0) {
        res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
        res.status(429).json({ error: 'rate_limited', message: 'Too many device code requests. Try again later.' });
        return;
      }
      // Every mint counts against the window — cheap to call, so treat
      // frequency itself as the signal rather than trying to define "failure".
      recordFailedAttempt(clientIp);

      const result = await deviceGrantService.createDeviceCode();
      const verificationUri = `${config.oidc.publicUrl}/device`;
      res.status(200).json({
        device_code: result.device_code,
        user_code: result.user_code,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(result.user_code)}`,
        expires_in: result.expires_in,
        interval: result.interval,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/oauth/token', tokenRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { grant_type } = req.body || {};

      if (grant_type === DEVICE_GRANT_TYPE) {
        const { device_code } = req.body || {};
        if (!device_code || typeof device_code !== 'string') {
          res.status(400).json({ error: 'invalid_request', error_description: 'device_code is required' });
          return;
        }
        const result = await deviceGrantService.poll(device_code);
        if (!result.ok) {
          res.status(400).json({ error: result.error });
          return;
        }
        res.status(200).json({ access_token: result.token.token, token_type: 'bearer' });
        return;
      }

      if (grant_type === 'authorization_code') {
        if (!oauthService) {
          res.status(400).json({ error: 'unsupported_grant_type' });
          return;
        }
        const { code, client_id, redirect_uri, code_verifier, resource } = req.body || {};
        if (!code || !client_id || !redirect_uri || !code_verifier || !resource) {
          res.status(400).json({ error: 'invalid_request', error_description: 'code, client_id, redirect_uri, code_verifier and resource are all required' });
          return;
        }
        const result = await oauthService.exchangeAuthorizationCode({ code, clientId: client_id, redirectUri: redirect_uri, codeVerifier: code_verifier, resource });
        if (!result.ok) {
          res.status(400).json({ error: result.error, error_description: result.error_description });
          return;
        }
        res.status(200).json({
          access_token: result.token.token,
          token_type: 'bearer',
          refresh_token: result.refreshToken,
        });
        return;
      }

      if (grant_type === 'refresh_token') {
        if (!oauthService) {
          res.status(400).json({ error: 'unsupported_grant_type' });
          return;
        }
        const { refresh_token, client_id, resource } = req.body || {};
        if (!refresh_token || !client_id || !resource) {
          res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token, client_id and resource are all required' });
          return;
        }
        const result = await oauthService.refreshToken({ refreshToken: refresh_token, clientId: client_id, resource });
        if (!result.ok) {
          res.status(400).json({ error: result.error, error_description: result.error_description });
          return;
        }
        res.status(200).json({
          access_token: result.token.token,
          token_type: 'bearer',
          refresh_token: result.refreshToken,
        });
        return;
      }

      res.status(400).json({ error: 'unsupported_grant_type' });
    } catch (err) {
      next(err);
    }
  });

  router.get('/oauth/device/lookup', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const retryAfterMs = getRetryAfterMs(clientIp);
      if (retryAfterMs > 0) {
        res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
        res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Try again later.' });
        return;
      }

      const auth: AuthContext | undefined = req.authContext;
      if (!auth?.principal || auth.principal.kind !== 'user' || !auth.workspace_id) {
        res.status(401).json({ error: 'unauthorized', message: 'Sign in first, then enter the code.' });
        return;
      }

      const userCode = normalizeCode(req.query.user_code);
      const grant = await deviceGrantService.findByUserCode(userCode);
      if (!grant || grant.status !== 'pending') {
        recordFailedAttempt(clientIp);
        res.status(404).json({ error: 'not_found', message: 'That code is invalid or has expired.' });
        return;
      }
      recordSuccessfulAttempt(clientIp);

      const wsRows = await db.query<{ name: string }>('SELECT name FROM workspace WHERE id = ?', [auth.workspace_id]);
      const userRows = await db.query<{ display_name: string }>('SELECT display_name FROM app_user WHERE id = ?', [auth.principal.id]);

      res.json({
        user_code: grant.user_code,
        workspace_name: wsRows[0]?.name || null,
        principal_display_name: userRows[0]?.display_name || null,
        role_name: auth.role_name,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/oauth/device/approve', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth: AuthContext | undefined = req.authContext;
      if (!auth?.principal || auth.principal.kind !== 'user' || !auth.workspace_id) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const userCode = normalizeCode(req.body?.user_code);
      const ok = await deviceGrantService.approve(userCode, auth);
      if (!ok) {
        res.status(404).json({ error: 'not_found', message: 'That code is invalid or has expired.' });
        return;
      }
      res.json({ message: 'approved' });
    } catch (err) {
      next(err);
    }
  });

  router.post('/oauth/device/deny', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth: AuthContext | undefined = req.authContext;
      if (!auth?.principal || auth.principal.kind !== 'user') {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const userCode = normalizeCode(req.body?.user_code);
      const ok = await deviceGrantService.deny(userCode);
      if (!ok) {
        res.status(404).json({ error: 'not_found', message: 'That code is invalid or has expired.' });
        return;
      }
      res.json({ message: 'denied' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
