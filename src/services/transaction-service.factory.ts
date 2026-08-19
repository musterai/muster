import type { DatabaseAdapter } from '../db/adapter.js';
import type { AuditService } from './audit.service.js';
import type { TokenService } from './token.service.js';

export interface TransactionServiceProviders {
  token(adapter: DatabaseAdapter): TokenService;
  audit(adapter: DatabaseAdapter): AuditService | undefined;
}

/**
 * Supplies adapter-bound collaborators to transaction-scoped operations.
 * Concrete construction stays in the application root; domain services only
 * request a collaborator bound to the adapter whose transaction they use.
 */
export class TransactionServiceFactory implements TransactionServiceProviders {
  constructor(
    private readonly tokenProvider: (adapter: DatabaseAdapter) => TokenService,
    private readonly auditProvider: (adapter: DatabaseAdapter) => AuditService | undefined,
  ) {}

  token(adapter: DatabaseAdapter): TokenService {
    return this.tokenProvider(adapter);
  }

  audit(adapter: DatabaseAdapter): AuditService | undefined {
    return this.auditProvider(adapter);
  }
}
