import type {
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
  TokenService,
  SessionService,
  OidcService,
  InvitationService,
  UserService,
  DeviceGrantService,
  McpOAuthService,
  AuditService,
} from '../services/index.js';
import type { DatabaseAdapter } from '../db/adapter.js';

/**
 * Transport-neutral application service container.
 *
 * Express, MCP, realtime, and future transports depend on this inward-facing
 * contract. No transport is the composition root for another transport.
 */
export interface Services {
  /** Root adapter used by transports that must compose mutation + audit atomically. */
  db?: DatabaseAdapter;
  projectService: ProjectService;
  boardService: BoardService;
  columnService: ColumnService;
  cardService: CardService;
  commentService: CommentService;
  documentService: DocumentService;
  agentService: AgentService;
  eventService: EventService;
  kbService: KBService;
  roleService: RoleService;
  tokenService: TokenService;
  sessionService: SessionService;
  oidcService: OidcService;
  invitationService: InvitationService;
  userService: UserService;
  deviceGrantService: DeviceGrantService;
  mcpOAuthService: McpOAuthService;
  auditService: AuditService;
}
