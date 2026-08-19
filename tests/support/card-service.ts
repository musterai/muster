import type { DatabaseAdapter } from '../../src/db/adapter.js';
import {
  CardAccessPolicy,
  CardLanePolicy,
  CardRecordQueries,
  CardMoveOperations,
  CardAssignmentOperations,
  CardRelationOperations,
  CardService,
  type EventService,
} from '../../src/services/index.js';

/**
 * Unit tests intentionally compose their own isolated graph. Production
 * code must use createApplicationServices so transport hosts share one
 * root-owned policy/service graph.
 */
export function createCardServiceForTest(
  db: DatabaseAdapter,
  eventService?: EventService,
): CardService {
  const accessPolicy = new CardAccessPolicy(db);
  const lanePolicy = new CardLanePolicy(db);
  const records = new CardRecordQueries(db);
  return new CardService(db, eventService, {
    accessPolicy,
    lanePolicy,
    records,
    moveOperations: new CardMoveOperations(db, eventService, accessPolicy, lanePolicy, records),
    assignmentOperations: new CardAssignmentOperations(db, eventService, accessPolicy, lanePolicy, records),
    relationOperations: new CardRelationOperations(db, eventService, records),
  });
}
