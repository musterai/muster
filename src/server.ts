// File: src/server.ts
//
// `muster serve` — the shared workspace server. Extracted from index.ts
// (MUS-27) so the CLI dispatcher can invoke it as one subcommand among
// serve/connect/login/logout without changing its behaviour: index.ts still
// calls this directly so `tsx watch src/index.ts` / `node dist/index.js`
// keep working exactly as before.

import express, { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabaseAdapter } from './db/factory.js';
import { Migrator } from './db/migrator.js';
import {
  ProjectService,
  BoardService,
  ColumnService,
  CardService,
  CommentService,
  DocumentService,
  AgentService,
  EventService,
  KBService,
  RoleService,
} from './services/index.js';
import { SSEManager } from './realtime/sse.js';
import { createRouter } from './api/router.js';
import { errorHandler } from './api/middleware/error-handler.js';
import { createMcpServer } from './mcp/server.js';
import type { Services } from './shared/services.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config, formatHostForUrl, isLoopbackHost, setDatabaseOverride } from './config/index.js';
import { OPEN_AUTH_CONTEXT } from './shared/auth-context.js';
import { ulid } from 'ulid';
import { TokenService } from './services/token.service.js';
import { SessionService } from './services/session.service.js';
import { OidcService } from './services/oidc.service.js';
import { InvitationService } from './services/invitation.service.js';
import { UserService } from './services/user.service.js';
import { DeviceGrantService } from './services/device-grant.service.js';
import { McpOAuthService } from './services/mcp-oauth.service.js';
import { AuditService } from './services/audit.service.js';
import { createAuthMiddleware } from './api/middleware/auth.js';
import { createWellKnownRouter, canonicalMcpResource } from './api/routes/mcp-oauth.routes.js';
import { corsMiddleware, securityHeadersMiddleware } from './api/middleware/security.js';
import { createRateLimiter } from './api/middleware/generic-rate-limiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Bind an Express application to the already-validated listener address.
 * Exported so the socket-level configuration tests exercise the same binding
 * call used by the production server.
 */
export function listenApplication(
  app: express.Express,
  port: number,
  host: string,
  callback?: () => void,
): ReturnType<typeof app.listen> {
  return app.listen(port, host, callback);
}

export async function startServer(options?: { db?: string }): Promise<void> {
  if (options?.db) {
    setDatabaseOverride(options.db);
  }

  const db = createDatabaseAdapter();

  const migrator = new Migrator(db, path.join(__dirname, 'db/migrations'));
  await migrator.run();

  const sseManager = new SSEManager();
  const eventService = new EventService(db, async (evt) => {
    sseManager.broadcast(evt.project_id, evt);
  });

  const boardService = new BoardService(db, eventService);
  const documentService = new DocumentService(db, eventService);
  const kbService = new KBService(db, eventService);
  const roleService = new RoleService(db, eventService);
  const tokenService = new TokenService(db);
  const sessionService = new SessionService(db);
  const oidcService = new OidcService(db);
  const invitationService = new InvitationService(db);
  const userService = new UserService(db);
  const auditService = new AuditService(db);
  const deviceGrantService = new DeviceGrantService(db, tokenService, auditService);
  const agentService = new AgentService(db, eventService);
  const mcpOAuthService = new McpOAuthService(db, tokenService, agentService, auditService);
  const services: Services = {
    projectService: new ProjectService(db, eventService, boardService, documentService),
    boardService,
    columnService: new ColumnService(db, eventService),
    cardService: new CardService(db, eventService),
    commentService: new CommentService(db, eventService),
    documentService,
    agentService,
    eventService,
    kbService,
    roleService,
    tokenService,
    sessionService,
    oidcService,
    invitationService,
    auditService,
    deviceGrantService,
    mcpOAuthService,
    userService,
  };

  // Bootstrap: create default workspace and project if empty
  const workspaces = await db.query<{ id: string }>('SELECT id FROM workspace LIMIT 1');
  if (workspaces.length === 0) {
    const wsId = ulid();
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [wsId, 'Default Workspace', 'default', now, now]
    );
    console.log('Created default workspace');
  }

  // Seed preset roles into the default workspace and backfill agent roles
  const wsRows = await db.query<{ id: string }>('SELECT id FROM workspace LIMIT 1');
  if (wsRows.length > 0) {
    const wsId = wsRows[0].id;
    const seeded = await roleService.seedPreset(wsId);
    const backfilled = await roleService.backfillAgentRoles(wsId);
    console.log(`Seeded ${seeded.length} preset roles; backfilled ${backfilled} agents`);
  }

  const existingProjects = await services.projectService.list();
  if (existingProjects.length === 0) {
    console.log('No existing projects found. Creating default project "Alpha Agent Project"...');
    await services.projectService.create({
      name: 'Alpha Agent Project',
      description: 'Primary project for AI agent collaboration'
    });
  }

  const authMiddleware = createAuthMiddleware(db, tokenService, roleService, agentService, sessionService);

  const app = express();
  app.use(corsMiddleware);
  app.use(securityHeadersMiddleware);
  // Explicit, not the body-parser default — large enough for a real design
  // doc (design doc §13 calls out "tens of KB" as normal), small enough
  // that an unbounded body isn't a trivial DoS against a single-connection
  // SQLite. Document/card content itself is capped tighter still — see
  // document.service.ts / card.service.ts.
  app.use(express.json({ limit: '5mb' }));
  // OAuth device/token clients commonly use application/x-www-form-urlencoded;
  // keep parsing bounded and do not enable nested object coercion at this
  // public boundary.
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // RFC 8615 well-known URIs must live at the true origin root, not under /api.
  app.use(createWellKnownRouter());

  // AuthContext resolution — scoped to /api and /mcp inside the middleware
  // itself (see the early return in auth.ts). Applying it to every request
  // would 401 the SPA shell in enforced mode, which is exactly the page
  // that has to load *before* sign-in so there is somewhere for the
  // "Sign in" button to live. Mounted unscoped (not under '/api') so
  // req.path inside it stays the full original path — the exemption
  // checks in auth.ts compare against '/api/v1/auth/' etc.
  app.use((req, res, next) => authMiddleware(req, res, next));

  const apiRouter = createRouter(services, sseManager, db);
  app.use('/api', apiRouter);

  const publicDir = config.publicDir;
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  // Per-principal once authenticated (so one noisy agent doesn't throttle
  // everyone else on the same box), falling back to per-IP before auth
  // resolves — e.g. the unauthenticated request that triggers the 401 +
  // WWW-Authenticate challenge in the first place (MUS-29).
  const mcpRateLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 300,
    keyFn: (req) => (req as any).authContext?.principal?.id || req.ip || 'unknown',
    message: 'Too many MCP requests. Slow down.',
  });

  // MCP Streamable HTTP Transport
  app.post('/mcp', mcpRateLimiter, async (req: Request, res: Response) => {
    const auth = (req as any).authContext || OPEN_AUTH_CONTEXT;
    const mcpServer = createMcpServer(services, req, auth);

    const mcpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await mcpServer.connect(mcpTransport);
      await mcpTransport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: req.body?.id || null,
        });
      }
    }
  });

  // SPA Fallback Handler
  app.get('*', (req: Request, res: Response, next) => {
    // Exact match on /mcp — not startsWith, which would also swallow the
    // SPA's own /mcp/authorize consent screen (MUS-29).
    if (req.path.startsWith('/api') || req.path === '/mcp') {
      return next();
    }
    const indexPath = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      next();
    }
  });

  app.use(errorHandler);

  const statusTimer = setInterval(() => {
    services.agentService.updateStatus().catch(console.error);
    services.cardService.releaseExpiredLeases().catch(console.error);
  }, 60000);

  const host = config.host;
  if (config.auth.mode === 'open' && !isLoopbackHost(host)) {
    // This should be unreachable because resolveListenerConfig() rejects the
    // contradictory environment at module load. Keep the invariant here too
    // in case an embedding caller mutates the exported config object.
    throw new Error(
      `Unsafe listener configuration: open authentication cannot bind non-loopback host "${host}"`
    );
  }

  const initialPort = config.port;

  const listenOnPort = (port: number) => {
    const server = listenApplication(app, port, host, () => {
      const activeDb = config.db.type === 'sqlite'
        ? `sqlite at ${config.db.path}`
        : 'postgres (configured)';
      const displayHost = formatHostForUrl(host);
      console.log(`\n======================================================`);
      console.log(`  Muster v1.0.0 - ONLINE`);
      console.log(`======================================================`);
      console.log(`  • Bind:     ${displayHost}:${port}`);
      console.log(`  • Web UI:   http://${displayHost}:${port}`);
      console.log(`  • REST API: http://${displayHost}:${port}/api/v1`);
      console.log(`  • MCP Tool: POST http://${displayHost}:${port}/mcp`);
      console.log(`  • Auth:     ${config.auth.mode}`);
      console.log(`  • Database: ${activeDb}`);
      console.log(`======================================================\n`);
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[Muster] Port ${port} is currently in use. Trying port ${port + 1}...`);
        listenOnPort(port + 1);
      } else {
        console.error('[Muster] Server error:', err);
        process.exit(1);
      }
    });

    const shutdown = async () => {
      console.log('Shutting down Muster...');
      clearInterval(statusTimer);
      sseManager.close();
      server.close();
      await db.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  };

  listenOnPort(initialPort);
}
