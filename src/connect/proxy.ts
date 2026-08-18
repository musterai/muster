// File: src/connect/proxy.ts
//
// `muster connect` — a local proxy client (MUS-27, design doc §8). Serves
// the SPA and forwards /api + /mcp upstream with the user's bearer token,
// streaming SSE and MCP Streamable HTTP responses through unmodified.
//
// Holds no database — no sync, no reconciliation. Loopback is not a
// security boundary (any local process can reach 127.0.0.1), so every
// local request must carry a per-session local token minted at startup;
// requests without it are refused before anything is forwarded.

import express, { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ConnectProxyOptions {
  /** e.g. https://muster.example.com — no trailing slash. */
  upstreamUrl: string;
  /** PAT attached to every forwarded request; never sent to the local client. */
  upstreamToken: string;
  /** Gates local /api and /mcp access — loopback is not a security boundary on its own. */
  localToken: string;
  /** Defaults to the repo's public/ directory. */
  publicDir?: string;
}

const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-length',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'user-agent',
]);

const FORWARDED_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-encoding',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'mcp-protocol-version',
  'mcp-session-id',
  'retry-after',
  'vary',
]);

function selectHeaders(
  source: http.IncomingHttpHeaders,
  allowed: Set<string>,
): http.OutgoingHttpHeaders {
  const selected: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    if (allowed.has(name.toLowerCase()) && value !== undefined) selected[name] = value;
  }
  return selected;
}

/** Consume the loopback-only query credential before crossing the trust boundary. */
function upstreamPath(basePath: string, originalUrl: string): string {
  const local = new URL(originalUrl, 'http://muster-loopback.invalid');
  local.searchParams.delete('local_token');
  return `${basePath}${local.pathname}${local.search}`;
}

/** Refuses any local request that doesn't carry the local token — via header (fetch/MCP clients) or query string (native EventSource can't set headers). */
export function requireLocalToken(localToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    const headerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;
    const queryToken = typeof req.query.local_token === 'string' ? req.query.local_token : null;

    if (headerToken === localToken || queryToken === localToken) {
      next();
      return;
    }

    res.status(401).json({
      error: 'unauthorized',
      message: 'This is the local muster connect proxy. Requests must carry the loopback token minted at startup (Authorization: Bearer <token>, or ?local_token=<token> for EventSource).',
    });
  };
}

/**
 * Streams a request through to the upstream Muster server unmodified.
 * Deliberately raw (http.request + pipe), not a buffering client — SSE and
 * MCP Streamable HTTP responses must reach the local client live, or agents
 * hang and the board stops updating.
 */
export function proxyToUpstream(upstreamUrl: string, upstreamToken: string) {
  const target = new URL(upstreamUrl);
  const lib = target.protocol === 'https:' ? https : http;
  const basePath = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');

  return (req: Request, res: Response) => {
    const headers = selectHeaders(req.headers, FORWARDED_REQUEST_HEADERS);
    // The local token gated access to *this* proxy — it is never the
    // upstream's credential and must not leak past this hop.
    headers['authorization'] = `Bearer ${upstreamToken}`;
    headers['host'] = target.host;

    const proxyReq = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: upstreamPath(basePath, req.originalUrl),
      method: req.method,
      headers,
    }, (proxyRes) => {
      // Cookies, redirects, forwarding metadata and hop-by-hop headers from a
      // remote origin must never acquire authority on the loopback origin.
      res.writeHead(
        proxyRes.statusCode || 502,
        selectHeaders(proxyRes.headers, FORWARDED_RESPONSE_HEADERS),
      );
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.status(502).json({
        error: 'upstream_unreachable',
        message: `Cannot reach the Muster server at ${upstreamUrl}: ${err.message}`,
      });
    });

    req.on('aborted', () => proxyReq.destroy());
    res.on('close', () => {
      if (!proxyReq.destroyed) proxyReq.destroy();
    });
    req.pipe(proxyReq, { end: true });
  };
}

/** Serves index.html with a `muster-local-token` meta tag injected, so the SPA (served by this same proxy) can read the token and attach it to its own requests without it ever touching the network in plaintext beyond loopback. */
function serveSpaShell(publicDir: string, localToken: string) {
  const indexPath = path.join(publicDir, 'index.html');
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!fs.existsSync(indexPath)) {
      next();
      return;
    }
    const html = fs.readFileSync(indexPath, 'utf-8');
    const injected = html.includes('</head>')
      ? html.replace('</head>', `  <meta name="muster-local-token" content="${localToken}">\n  </head>`)
      : html;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  };
}

export function createConnectApp(options: ConnectProxyOptions): express.Express {
  const publicDir = options.publicDir || path.join(__dirname, '../../public');
  const app = express();

  // No body-parsing middleware here — req must stay an unconsumed stream
  // for proxyToUpstream() to pipe it through.
  const gate = requireLocalToken(options.localToken);
  const forward = proxyToUpstream(options.upstreamUrl, options.upstreamToken);

  app.use('/api', gate, forward);
  app.post('/mcp', gate, forward);

  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: false }));
  }

  const spaShell = serveSpaShell(publicDir, options.localToken);
  app.get('*', (req, res, next) => {
    // Exact match on /mcp — not startsWith, which would also swallow the
    // SPA's own /mcp/authorize consent screen (MUS-29).
    if (req.path.startsWith('/api') || req.path === '/mcp') {
      next();
      return;
    }
    spaShell(req, res, next);
  });

  return app;
}
