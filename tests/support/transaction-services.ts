import type { DatabaseAdapter } from '../../src/db/adapter.js';
import {
  AgentService,
  AuditService,
  DeviceGrantService,
  McpOAuthService,
  TokenService,
  TransactionServiceFactory,
} from '../../src/services/index.js';

export function createTransactionServicesForTest(
  db: DatabaseAdapter,
  tokenService: TokenService = new TokenService(db),
  auditService?: AuditService,
): TransactionServiceFactory {
  return new TransactionServiceFactory(
    adapter => adapter === db ? tokenService : new TokenService(adapter),
    adapter => {
      if (!auditService) return undefined;
      return adapter === db ? auditService : new AuditService(adapter);
    },
  );
}

export function createDeviceGrantServiceForTest(
  db: DatabaseAdapter,
  tokenService: TokenService = new TokenService(db),
  auditService?: AuditService,
): DeviceGrantService {
  return new DeviceGrantService(
    db,
    createTransactionServicesForTest(db, tokenService, auditService),
  );
}

export function createMcpOAuthServiceForTest(
  db: DatabaseAdapter,
  tokenService: TokenService,
  agentService: AgentService,
  auditService?: AuditService,
): McpOAuthService {
  return new McpOAuthService(
    db,
    agentService,
    createTransactionServicesForTest(db, tokenService, auditService),
  );
}
