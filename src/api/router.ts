// File: src/api/router.ts
import { Router } from 'express';
import { DatabaseAdapter } from '../db/adapter.js';
import type { Services } from '../shared/services.js';
import { SSEManager } from '../realtime/sse.js';
import { createProjectRouter } from './routes/project.routes.js';
import { createBoardRouter } from './routes/board.routes.js';
import { createColumnRouter } from './routes/column.routes.js';
import { createCardRouter } from './routes/card.routes.js';
import { createDocumentRouter } from './routes/document.routes.js';
import { createAgentRouter } from './routes/agent.routes.js';
import { createEventRouter } from './routes/event.routes.js';
import { createHealthRouter } from './routes/health.routes.js';
import { createKBRouter } from './routes/kb.routes.js';
import { createRoleRouter } from './routes/role.routes.js';
import { createTokenRouter } from './routes/token.routes.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createUserRouter } from './routes/user.routes.js';
import { createDeviceRouter } from './routes/device.routes.js';
import { createMcpOAuthRouter } from './routes/mcp-oauth.routes.js';
import { createAuditRouter } from './routes/audit.routes.js';
import { permissionGuard } from './middleware/permission-guard.js';

export function createRouter(services: Services, sseManager: SSEManager, db: DatabaseAdapter): Router {
  const router = Router();
  const v1 = Router();

  // Apply permission guard to all v1 routes
  v1.use(permissionGuard);

  v1.use(createHealthRouter(db));
  v1.use('/projects', createProjectRouter(services.projectService, services.auditService));
  v1.use(createBoardRouter(services.boardService, services.columnService, services.cardService));
  v1.use(createColumnRouter(services.columnService));
  v1.use(createCardRouter(services.cardService, services.commentService));
  v1.use(createDocumentRouter(services.documentService, services.auditService));
  v1.use(createAgentRouter(services.agentService, services.cardService));
  v1.use(createUserRouter(db, services.userService, services.roleService, services.auditService));
  v1.use(createEventRouter(services.eventService, sseManager));
  v1.use(createKBRouter(services.kbService));
  v1.use(createRoleRouter(services.roleService, services.auditService));
  v1.use(createTokenRouter(services.tokenService, services.auditService));
  v1.use(createAuthRouter(
    db,
    services.oidcService,
    services.sessionService,
    services.userService,
    services.invitationService,
    services.roleService,
    services.auditService,
  ));
  v1.use(createDeviceRouter(db, services.deviceGrantService, services.mcpOAuthService));
  v1.use(createMcpOAuthRouter(db, services.mcpOAuthService, services.agentService, services.roleService));
  v1.use(createAuditRouter(services.auditService));


  router.use('/v1', v1);
  return router;
}
