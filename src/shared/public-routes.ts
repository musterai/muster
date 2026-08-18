// File: src/shared/public-routes.ts
//
// The public boundary is deliberately an allowlist.  Authentication and
// permission middleware both consume this inventory so adding a route cannot
// accidentally make an entire path prefix public.

export type PublicRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PublicRoute {
  method: PublicRouteMethod;
  path: string;
  purpose: string;
}

/**
 * Protocol/bootstrap routes that must be reachable before a workspace
 * credential exists.  Keep paths exact; query strings are stripped by
 * isPublicRoute before matching.
 */
export const PUBLIC_ROUTE_INVENTORY = [
  // Safe liveness information contains no workspace data.
  { method: 'GET', path: '/api/v1/health', purpose: 'liveness' },

  // Human OIDC bootstrap and session introspection/logout.
  { method: 'GET', path: '/api/v1/auth/login', purpose: 'oidc_login' },
  { method: 'GET', path: '/api/v1/auth/callback', purpose: 'oidc_callback' },
  { method: 'POST', path: '/api/v1/auth/logout', purpose: 'session_logout' },
  { method: 'GET', path: '/api/v1/auth/me', purpose: 'session_introspection' },
  { method: 'POST', path: '/api/v1/auth/local', purpose: 'local_open_mode_identity' },

  // OAuth/device bootstrap.  Approval, consent, and device lookup remain
  // protected and therefore are intentionally absent from this list.
  { method: 'POST', path: '/api/v1/oauth/device/code', purpose: 'device_authorization_start' },
  { method: 'POST', path: '/api/v1/oauth/token', purpose: 'oauth_token_exchange' },
  { method: 'POST', path: '/api/v1/oauth/register', purpose: 'oauth_client_registration' },
  { method: 'GET', path: '/api/v1/oauth/authorize', purpose: 'oauth_authorization_start' },

  // RFC 8615/RFC 8414/RFC 9728 discovery metadata at the origin root.
  { method: 'GET', path: '/.well-known/oauth-protected-resource', purpose: 'oauth_resource_metadata' },
  { method: 'GET', path: '/.well-known/oauth-authorization-server', purpose: 'oauth_authorization_server_metadata' },
] as const satisfies readonly PublicRoute[];

/** Compatibility alias for callers that prefer the shorter name. */
export const PUBLIC_ROUTES = PUBLIC_ROUTE_INVENTORY;

function normalizedPath(path: string): string {
  return path.split('?', 1)[0] || '/';
}

/** Return true only for an exact method/path pair in the public inventory. */
export function isPublicRoute(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const normalizedRequestPath = normalizedPath(path);
  return PUBLIC_ROUTE_INVENTORY.some(
    (route) => route.method === normalizedMethod && route.path === normalizedRequestPath,
  );
}

