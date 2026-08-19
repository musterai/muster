import type { DatabaseAdapter } from '../db/adapter.js';
import { config } from '../config/index.js';
import { OPEN_AUTH_CONTEXT } from '../shared/auth-context.js';
import {
  CardRuleError,
  ConflictError,
  NotFoundError,
} from '../shared/errors.js';
import type { Card, CardOperationOptions, MoveCard } from '../shared/types.js';
import {
  assertResourceWorkspace,
  assertResourcesShareWorkspace,
  assertResourcesWorkspace,
} from './helpers/workspace-scope.helper.js';
import { resolveCardId } from './helpers/card-id.helper.js';
import type { EventService } from './event.service.js';
import type { CardAccessPolicy } from './card-access.policy.js';
import type { CardLanePolicy } from './card-lane.policy.js';
import type { CardRecordQueries } from './card-record.queries.js';

const MAX_MOVE_RETRIES = 3;
const MOVE_RETRY_DELAY_MS = 10;

class MoveRetryError extends Error {
  constructor() {
    super('card changed lanes while its move was being serialized');
    this.name = 'MoveRetryError';
  }
}

function isRetryablePostgresError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === '40P01' || code === '40001';
}

/**
 * Owns the complete serialized lane-move transaction. The compatibility
 * facade delegates here instead of splitting locks, ranks, rule checks and
 * events across independently mutable methods.
 */
export class CardMoveOperations {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly eventService: EventService | undefined,
    private readonly accessPolicy: CardAccessPolicy,
    private readonly lanePolicy: CardLanePolicy,
    private readonly records: CardRecordQueries,
  ) {}

  async move(
    id: string,
    data: MoveCard,
    actorId?: string,
    options: CardOperationOptions = {},
  ): Promise<string> {
    this.lanePolicy.assertMoveIntent(data);
    const auth = options.auth || OPEN_AUTH_CONTEXT;
    const cardId = config.auth.mode === 'enforced'
      ? await this.accessPolicy.assertCardMutationScope(id, options.auth)
      : await resolveCardId(this.db, id);
    await assertResourceWorkspace(this.db, auth, 'card', cardId);
    if (data.target_column_id) {
      await assertResourcesWorkspace(this.db, auth, [
        ['card', cardId],
        ['column', data.target_column_id],
      ]);
      await assertResourcesShareWorkspace(this.db, [
        ['card', cardId],
        ['column', data.target_column_id],
      ]);
      const projectRows = await this.db.query<{
        source_project_id: string;
        target_project_id: string;
      }>(
        `SELECT source_board.project_id AS source_project_id, target_board.project_id AS target_project_id
         FROM card c
         JOIN "column" source_col ON source_col.id = c.column_id
         JOIN board source_board ON source_board.id = source_col.board_id
         JOIN "column" target_col ON target_col.id = ?
         JOIN board target_board ON target_board.id = target_col.board_id
         WHERE c.id = ?`,
        [data.target_column_id, cardId],
      );
      if (!projectRows[0] || projectRows[0].source_project_id !== projectRows[0].target_project_id) {
        throw new NotFoundError('Resource not found');
      }
    }

    let completed = false;
    for (let attempt = 0; attempt < MAX_MOVE_RETRIES; attempt++) {
      try {
        await this.db.transaction(async (tx) => {
          const overrideRules: Array<Record<string, unknown>> = [];
          const initialRows = await tx.query<{ column_id: string }>(
            'SELECT column_id FROM card WHERE id = ?',
            [cardId],
          );
          const initial = initialRows[0];
          if (!initial) throw new NotFoundError(`Card with ID ${cardId} not found`);
          await this.accessPolicy.assertCardMutationScope(cardId, options.auth, tx);
          const initialTarget = data.target_column_id ?? initial.column_id;
          await this.accessPolicy.assertColumnWorkspaceScope(initialTarget, options.auth, tx);
          if (tx.dialect === 'postgres') {
            const laneIds = [...new Set([initial.column_id, initialTarget])].sort();
            for (const laneId of laneIds) {
              await tx.query<{ id: string }>(
                'SELECT id FROM "column" WHERE id = ? FOR UPDATE',
                [laneId],
              );
            }
          }

          const existing = await this.records.requireCard(cardId, tx, true);
          if (tx.dialect === 'postgres' && existing.column_id !== initial.column_id) {
            throw new MoveRetryError();
          }
          const targetColumnId = data.target_column_id ?? existing.column_id;
          const capacity = await this.lanePolicy.getColumnCapacity(targetColumnId, tx);
          const isColumnChange = targetColumnId !== existing.column_id;

          if (
            isColumnChange
            && capacity.wip_limit !== null
            && capacity.card_count >= capacity.wip_limit
          ) {
            const details = {
              rule: 'wip_limit',
              operation: 'move',
              column_id: capacity.id,
              column_name: capacity.name,
              current_count: capacity.card_count,
              wip_limit: capacity.wip_limit,
            };
            if (!options.operatorOverride) {
              throw new CardRuleError(
                'CARD_WIP_LIMIT',
                `Column "${capacity.name}" is at its WIP limit (${capacity.card_count}/${capacity.wip_limit}); cannot move this card there without operator override.`,
                details,
              );
            }
            overrideRules.push(details);
          }

          if (isColumnChange && capacity.name.trim().toLowerCase() === 'in progress') {
            const blockers = await this.lanePolicy.getUnresolvedBlockers(cardId, tx);
            if (blockers.length > 0) {
              const details = {
                rule: 'blocked_by',
                operation: 'move',
                blockers: blockers.map(blocker => ({ ...blocker })),
              };
              if (!options.operatorOverride) {
                const blockerSummary = blockers
                  .map(blocker => `${blocker.key} "${blocker.title}"`)
                  .join(', ');
                throw new CardRuleError(
                  'CARD_BLOCKED',
                  `Cannot move this card into "${capacity.name}" while it is blocked by ${blockerSummary}. Resolve the blocking cards or use operator override.`,
                  details,
                );
              }
              overrideRules.push(details);
            }
          }

          const targetCards = await this.lanePolicy.orderedLaneCards(targetColumnId, tx, cardId);
          const movedCard: Card = { ...existing, column_id: targetColumnId, position: 'm' };
          const orderedTargetCards = this.lanePolicy.orderWithPosition(
            targetCards,
            movedCard,
            data.position,
          );
          const targetRanks = await this.lanePolicy.rebalanceLane(tx, orderedTargetCards);
          const movedIndex = orderedTargetCards.findIndex(card => card.id === cardId);
          const position = targetRanks[movedIndex];

          if (isColumnChange) {
            const sourceCards = await this.lanePolicy.orderedLaneCards(
              existing.column_id,
              tx,
              cardId,
            );
            await this.lanePolicy.rebalanceLane(tx, sourceCards);
          }

          const updatedAt = new Date().toISOString();
          await tx.execute(
            'UPDATE card SET column_id = ?, position = ?, updated_at = ? WHERE id = ?',
            [targetColumnId, position, updatedAt, cardId],
          );

          const projectId = await this.records.projectIdForColumn(targetColumnId, tx);
          if (!projectId) throw new Error(`Column ${targetColumnId} is not attached to a project`);
          if (this.eventService) {
            await this.eventService.create({
              project_id: projectId,
              entity_type: 'card',
              entity_id: cardId,
              action: 'moved',
              actor_id: actorId,
              payload: {
                from_column_id: existing.column_id,
                to_column_id: targetColumnId,
                position,
              },
            }, tx);
            if (isColumnChange && capacity.is_terminal === 1) {
              await this.eventService.create({
                project_id: projectId,
                entity_type: 'card',
                entity_id: cardId,
                action: 'completed',
                actor_id: actorId,
                payload: {
                  card_key: existing.key,
                  card_title: existing.title,
                  from_column_id: existing.column_id,
                  to_column_id: targetColumnId,
                  to_column_name: capacity.name,
                },
              }, tx);
            }
            if (overrideRules.length > 0) {
              await this.eventService.create({
                project_id: projectId,
                entity_type: 'card',
                entity_id: cardId,
                action: 'override',
                actor_id: actorId,
                payload: { operation: 'move', rules: overrideRules },
              }, tx);
            }
          }
        });
        completed = true;
        break;
      } catch (error) {
        const retryable = this.db.dialect === 'postgres'
          && (error instanceof MoveRetryError || isRetryablePostgresError(error));
        if (!retryable || attempt === MAX_MOVE_RETRIES - 1) {
          if (retryable) {
            throw new ConflictError(
              'Card move conflicted with concurrent lane changes; retry the move.',
              { operation: 'move', retryable: true },
            );
          }
          throw error;
        }
        await new Promise(resolve => setTimeout(
          resolve,
          MOVE_RETRY_DELAY_MS * (attempt + 1),
        ));
      }
    }
    if (!completed) {
      throw new ConflictError(
        'Card move could not be serialized; retry the move.',
        { retryable: true },
      );
    }
    return cardId;
  }
}
