import type { DatabaseAdapter } from '../../src/db/adapter.js';
import {
  CardAccessPolicy,
  CardLanePolicy,
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
  return new CardService(db, eventService, {
    accessPolicy: new CardAccessPolicy(db),
    lanePolicy: new CardLanePolicy(db),
  });
}
