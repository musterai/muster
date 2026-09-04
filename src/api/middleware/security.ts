// File: src/api/middleware/security.ts
//
// CORS and security headers for a public-host deployment (MUS-30, design
// doc §13). Hand-rolled rather than a dependency — the policy is a single
// fixed origin, not the general case `cors` is built for.

import { Request, Response, NextFunction } from 'express';
import { config } from '../../config/index.js';

/**
 * Restricted to MUSTER_PUBLIC_URL. The implicit same-origin assumption the
 * REST API relied on stops holding the moment a local client (`muster
 * connect`) or a browser extension is a distinct origin — a permissive
 * default would let any page the user visits read the API with their
 * cookie attached.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  const allowed = config.oidc.publicUrl;

  if (origin && origin === allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  // No header at all for any other origin — the browser enforces same-origin
  // by omission, which is the point; echoing a mismatched origin back would
  // be actively wrong, not just unnecessary.

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }

  next();
}

/**
 * The SPA's own external resources (see public/index.html): Google Fonts'
 * stylesheet and font files. Everything else is same-origin. script-src has
 * no 'unsafe-inline'/'unsafe-eval' — markdown content is sanitised by
 * DOMPurify (src/web/markdown.ts) before it ever reaches the DOM, but CSP is
 * the second layer against a sanitiser bug, not the first.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP);
  // Only meaningful over HTTPS; harmless to set unconditionally over HTTP
  // (a browser ignores it there), and avoids an environment-sniffing branch.
  if (req.protocol === 'https' || config.oidc.publicUrl.startsWith('https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}
