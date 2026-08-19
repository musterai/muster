// File: src/api/routes/mcp-oauth.routes.ts
//
// MCP-native OAuth (MUS-29): RFC 9728 protected resource metadata, RFC 8414
// authorization server metadata, RFC 7591 dynamic client registration, and
// the Authorization Code + PKCE authorize/consent split.
//
// /well-known/* is mounted at the true root by server.ts (RFC 8615 requires
// well-known URIs at the origin, not under /api/v1). Everything else here
// lives under /api/v1/oauth, alongside the device grant's endpoints.
//
// authorize/details and authorize/consent require a session — same
// reasoning as the device grant's lookup/approve: only an already
// signed-in human can tell the server which agent identity and role a
// client is being granted.

import { Router, Request, Response, NextFunction } from 'express';
import { DatabaseAdapter } from '../../db/adapter.js';
import { McpOAuthService, redirectUriMatches } from '../../services/mcp-oauth.service.js';
import { AgentService } from '../../services/agent.service.js';
import { RoleService } from '../../services/role.service.js';
import { AuthContext } from '../../shared/auth-context.js';
import { config } from '../../config/index.js';
import { createRateLimiter } from '../middleware/generic-rate-limiter.js';
import { validateRequest } from '../middleware/validate.js';
import {
  oauthAuthorizeDetailsQuerySchema,
  oauthAuthorizeQuerySchema,
  oauthConsentSchema,
  oauthRegisterSchema,
} from '../schemas.js';

// Registration is cheap but unauthenticated — a flat per-IP cap keeps it
// from being used to fill the oauth_client table.
const registerRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20, message: 'Too many client registrations. Try again later.' });

export function canonicalMcpResource(): string {
  return `${config.oidc.publicUrl}/mcp`;
}

function protectedResourceMetadataUrl(): string {
  return `${config.oidc.publicUrl}/.well-known/oauth-protected-resource`;
}

export function createWellKnownRouter(): Router {
  const router = Router();

  router.get('/.well-known/oauth-protected-resource', ...validateRequest(), (_req: Request, res: Response) => {
    res.json({
      resource: canonicalMcpResource(),
      authorization_servers: [config.oidc.publicUrl],
    });
  });

  router.get('/.well-known/oauth-authorization-server', ...validateRequest(), (_req: Request, res: Response) => {
    const base = config.oidc.publicUrl;
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/api/v1/oauth/authorize`,
      token_endpoint: `${base}/api/v1/oauth/token`,
      registration_endpoint: `${base}/api/v1/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    });
  });

  return router;
}

function parseRedirectUri(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    new URL(raw);
    return raw;
  } catch {
    return null;
  }
}

/** Preserve registered query parameters while adding protocol response data. */
function appendRedirectParameters(redirectUri: string, parameters: URLSearchParams): string {
  const redirect = new URL(redirectUri);
  for (const [name, value] of parameters) redirect.searchParams.set(name, value);
  return redirect.toString();
}

export function createMcpOAuthRouter(
  db: DatabaseAdapter,
  oauthService: McpOAuthService,
  agentService: AgentService,
  roleService: RoleService,
): Router {
  const router = Router();

  // ── RFC 7591 Dynamic Client Registration ──
  router.post('/oauth/register', registerRateLimiter, ...validateRequest({ body: oauthRegisterSchema }), async (req: Request, res: Response) => {
    try {
      const client = await oauthService.registerClient({
        client_name: req.body?.client_name,
        redirect_uris: req.body?.redirect_uris,
        token_endpoint_auth_method: req.body?.token_endpoint_auth_method,
        grant_types: req.body?.grant_types,
        response_types: req.body?.response_types,
      });
      res.status(201).json({
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    } catch (err: any) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: err.message });
    }
  });

  // ── Authorization request — validates what it safely can before ever
  //    redirecting anywhere, then hands off to the SPA consent screen ──
  router.get('/oauth/authorize', ...validateRequest({ query: oauthAuthorizeQuerySchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { response_type, client_id, code_challenge, code_challenge_method, resource } = req.query;
      const redirectUri = parseRedirectUri(req.query.redirect_uri);

      if (typeof client_id !== 'string') {
        res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
        return;
      }
      const client = await oauthService.getClient(client_id);
      if (!client) {
        res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
        return;
      }
      if (!redirectUri || !client.redirect_uris.some(r => redirectUriMatches(r, redirectUri))) {
        // Never redirect to an unregistered URI — that's an open redirect.
        res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is missing or not registered for this client' });
        return;
      }

      // From here on the redirect_uri is trusted, so any further problem
      // can be reported back to the client instead of shown as a bare error page.
      const qs = new URLSearchParams();
      if (response_type !== 'code') {
        qs.set('error', 'unsupported_response_type');
      } else if (code_challenge_method !== 'S256' || typeof code_challenge !== 'string' || !code_challenge) {
        qs.set('error', 'invalid_request');
        qs.set('error_description', 'PKCE with S256 is required');
      } else if (resource !== canonicalMcpResource()) {
        qs.set('error', 'invalid_target');
        qs.set('error_description', `resource must be ${canonicalMcpResource()}`);
      }
      if (qs.has('error')) {
        if (typeof req.query.state === 'string') qs.set('state', req.query.state);
        qs.set('iss', config.oidc.publicUrl);
        res.redirect(appendRedirectParameters(redirectUri, qs));
        return;
      }

      // Everything is valid — hand off to the SPA consent screen, which
      // re-validates via /authorize/details once the user is signed in.
      const forward = new URLSearchParams(req.query as Record<string, string>).toString();
      res.redirect(`/mcp/authorize?${forward}`);
    } catch (err) {
      next(err);
    }
  });

  // ── Consent screen data ──
  router.get('/oauth/authorize/details', ...validateRequest({ query: oauthAuthorizeDetailsQuerySchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth: AuthContext | undefined = req.authContext;
      if (!auth?.principal || auth.principal.kind !== 'user' || !auth.workspace_id) {
        res.status(401).json({ error: 'unauthorized', message: 'Sign in first.' });
        return;
      }

      const clientId = req.query.client_id;
      if (typeof clientId !== 'string') {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const client = await oauthService.getClient(clientId);
      if (!client) {
        res.status(400).json({ error: 'invalid_client' });
        return;
      }

      const agents = await agentService.list(auth.workspace_id);
      const myAgents = agents.filter(a => a.operator_user_id === auth.principal!.id);
      const roles = await roleService.list(auth.workspace_id);

      res.json({
        client_name: client.client_name || client.client_id,
        resource: canonicalMcpResource(),
        agents: myAgents.map(a => ({ id: a.id, name: a.name, role_id: a.role_id })),
        roles: roles.map(r => ({ id: r.id, name: r.name })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Consent decision ──
  router.post('/oauth/authorize/consent', ...validateRequest({ body: oauthConsentSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth: AuthContext | undefined = req.authContext;
      if (!auth?.principal || auth.principal.kind !== 'user' || !auth.workspace_id) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      const { client_id, redirect_uri, code_challenge, code_challenge_method, resource, state, decision, agent_id, new_agent_name, role_id } = req.body || {};
      const redirectUri = parseRedirectUri(redirect_uri);
      const client = typeof client_id === 'string' ? await oauthService.getClient(client_id) : null;
      if (!client || !redirectUri || !client.redirect_uris.some(r => redirectUriMatches(r, redirectUri))) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Unknown client or redirect_uri' });
        return;
      }

      const qs = new URLSearchParams();
      if (typeof state === 'string') qs.set('state', state);
      qs.set('iss', config.oidc.publicUrl);

      if (decision !== 'approve') {
        qs.set('error', 'access_denied');
        res.json({ redirect_uri: appendRedirectParameters(redirectUri, qs) });
        return;
      }

      if (resource !== canonicalMcpResource() || code_challenge_method !== 'S256' || typeof code_challenge !== 'string') {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      if (!role_id || typeof role_id !== 'string') {
        res.status(400).json({ error: 'invalid_request', error_description: 'role_id is required' });
        return;
      }

      // Resolve the agent identity being granted — reuse one the approver
      // already operates, or register a new one bound to them right now.
      let agentPrincipalId: string;
      if (typeof agent_id === 'string' && agent_id) {
        const existing = await agentService.assertAgentScope(agent_id, auth, 'agent.manage_others');
        agentPrincipalId = existing.id;
        if (existing.role_id !== role_id) {
          await agentService.update(existing.id, { role_id }, { workspaceId: auth.workspace_id, auth });
        }
      } else {
        const name = typeof new_agent_name === 'string' && new_agent_name.trim() ? new_agent_name.trim() : (client.client_name || 'MCP Agent');
        const created = await agentService.register({ name }, auth.principal.id, role_id, auth.workspace_id, auth);
        agentPrincipalId = created.id;
      }

      const code = await oauthService.createAuthorizationCode({
        clientId: client.client_id,
        redirectUri,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        resource,
        agentPrincipalId,
        operatorUserId: auth.principal.id,
        workspaceId: auth.workspace_id,
      });

      qs.set('code', code);
      res.json({ redirect_uri: appendRedirectParameters(redirectUri, qs) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
