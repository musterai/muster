import type { DatabaseAdapter } from '../../src/db/adapter.js';
import {
  AuditService,
  DocumentService,
  type EventService,
} from '../../src/services/index.js';

export function createDocumentServiceForTest(
  db: DatabaseAdapter,
  eventService?: EventService,
  auditService: AuditService = new AuditService(db),
): DocumentService {
  return new DocumentService(db, eventService, auditService);
}
