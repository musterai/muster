import type { DatabaseAdapter } from '../db/adapter.js';
import {
  AgentService,
  AuditService,
  BoardService,
  CardService,
  CardAccessPolicy,
  CardLanePolicy,
  CardRecordQueries,
  CardMoveOperations,
  CardAssignmentOperations,
  CardRelationOperations,
  ColumnService,
  CommentService,
  DeviceGrantService,
  DocumentService,
  EventService,
  InvitationService,
  KBService,
  McpOAuthService,
  OidcService,
  ProjectService,
  RoleService,
  SessionService,
  TokenService,
  TransactionServiceFactory,
  UserService,
} from '../services/index.js';
import type { EventCallback } from '../services/event.service.js';
import type { Services } from '../shared/services.js';

export type ApplicationServices = Services & { db: DatabaseAdapter };

export interface ApplicationCompositionOptions {
  /**
   * Outward event delivery is injected by the host. The application owns
   * durable event creation; SSE, tests, or another transport only publish
   * events after the transaction commits.
   */
  publishEvent?: EventCallback;
}

/**
 * Transport-neutral application composition root.
 *
 * This is the only production location that constructs domain services and
 * their shared policies. HTTP, MCP, realtime, and CLI hosts receive the same
 * container instead of constructing or importing one another.
 */
export function createApplicationServices(
  db: DatabaseAdapter,
  options: ApplicationCompositionOptions = {},
): ApplicationServices {
  const eventService = new EventService(db, options.publishEvent);
  const auditService = new AuditService(db);
  const boardService = new BoardService(db, eventService);
  const documentService = new DocumentService(db, eventService, auditService);
  const tokenService = new TokenService(db);
  const agentService = new AgentService(db, eventService);
  const transactionServiceFactory = new TransactionServiceFactory(
    adapter => adapter === db ? tokenService : new TokenService(adapter),
    adapter => adapter === db ? auditService : new AuditService(adapter),
  );
  const cardAccessPolicy = new CardAccessPolicy(db);
  const cardLanePolicy = new CardLanePolicy(db);
  const cardRecordQueries = new CardRecordQueries(db);
  const cardMoveOperations = new CardMoveOperations(
    db,
    eventService,
    cardAccessPolicy,
    cardLanePolicy,
    cardRecordQueries,
  );
  const cardAssignmentOperations = new CardAssignmentOperations(
    db,
    eventService,
    cardAccessPolicy,
    cardLanePolicy,
    cardRecordQueries,
  );
  const cardRelationOperations = new CardRelationOperations(
    db,
    eventService,
    cardRecordQueries,
  );
  const cardService = new CardService(db, eventService, {
    accessPolicy: cardAccessPolicy,
    lanePolicy: cardLanePolicy,
    records: cardRecordQueries,
    moveOperations: cardMoveOperations,
    assignmentOperations: cardAssignmentOperations,
    relationOperations: cardRelationOperations,
  });

  return {
    db,
    eventService,
    auditService,
    boardService,
    documentService,
    tokenService,
    agentService,
    transactionServiceFactory,
    cardAccessPolicy,
    cardLanePolicy,
    cardRecordQueries,
    cardMoveOperations,
    cardAssignmentOperations,
    cardRelationOperations,
    cardService,
    projectService: new ProjectService(db, eventService, boardService, documentService),
    columnService: new ColumnService(db, eventService),
    commentService: new CommentService(db, eventService),
    kbService: new KBService(db, eventService),
    roleService: new RoleService(db, eventService),
    sessionService: new SessionService(db),
    oidcService: new OidcService(db),
    invitationService: new InvitationService(db),
    userService: new UserService(db),
    deviceGrantService: new DeviceGrantService(db, transactionServiceFactory),
    mcpOAuthService: new McpOAuthService(db, agentService, transactionServiceFactory),
  };
}
