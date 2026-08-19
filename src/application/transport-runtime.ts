import type { Request } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DatabaseAdapter } from '../db/adapter.js';
import { createRouter } from '../api/router.js';
import { createMcpServer } from '../mcp/server.js';
import { SSEManager } from '../realtime/sse.js';
import type { AuthContext } from '../shared/auth-context.js';
import type { Services } from '../shared/services.js';
import {
  createApplicationServices,
  type ApplicationCompositionOptions,
  type ApplicationServices,
} from './composition.js';

export interface TransportRuntimeOptions extends ApplicationCompositionOptions {
  sseManager?: SSEManager;
  restRouterFactory?: typeof createRouter;
  mcpServerFactory?: (
    services: Services,
    request?: Request,
    auth?: AuthContext,
  ) => McpServer;
}

/**
 * Host-level assembly for the concrete transports.
 *
 * The application composition remains transport-neutral; this host binds the
 * one resulting object graph to REST, MCP and outward SSE delivery.
 */
export function createTransportRuntime(
  db: DatabaseAdapter,
  options: TransportRuntimeOptions = {},
) {
  const sseManager = options.sseManager ?? new SSEManager();
  const services = createApplicationServices(db, {
    publishEvent: options.publishEvent
      ?? (event => sseManager.broadcast(event.project_id, event)),
  });
  const restRouter = (options.restRouterFactory ?? createRouter)(services, sseManager, db);
  const mcpServerFactory = options.mcpServerFactory ?? createMcpServer;

  return {
    services,
    sseManager,
    restRouter,
    createMcpServer(request?: Request, auth?: AuthContext): McpServer {
      return mcpServerFactory(services, request, auth);
    },
  } satisfies {
    services: ApplicationServices;
    sseManager: SSEManager;
    restRouter: ReturnType<typeof createRouter>;
    createMcpServer(request?: Request, auth?: AuthContext): McpServer;
  };
}
