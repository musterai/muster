import type { DatabaseAdapter } from '../db/adapter.js';
import { config } from '../config/index.js';
import { OPEN_AUTH_CONTEXT, type AuthContext } from '../shared/auth-context.js';
import { CardRuleError } from '../shared/errors.js';
import type {
  Card,
  CardOperationOptions,
  ClaimRefusal,
} from '../shared/types.js';
import { assertAgentSelectorScope } from './agent-scope.authorization.js';
import type { CardAccessPolicy } from './card-access.policy.js';
import type { CardLanePolicy } from './card-lane.policy.js';
import type { CardRecordQueries } from './card-record.queries.js';
import type { EventService } from './event.service.js';
import { resolveCardId } from './helpers/card-id.helper.js';
import {
  assertResourcesShareWorkspace,
  assertResourcesWorkspace,
} from './helpers/workspace-scope.helper.js';

const DEFAULT_CLAIM_TTL_SECONDS = 600;

export type CardClaimOperationResult =
  | { success: true; cardId: string }
  | ClaimRefusal;

/**
 * Owns assignment and lease transactions, including Postgres row locking,
 * blocker overrides and event delivery on the same adapter.
 */
export class CardAssignmentOperations {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly eventService: EventService | undefined,
    private readonly accessPolicy: CardAccessPolicy,
    private readonly lanePolicy: CardLanePolicy,
    private readonly records: CardRecordQueries,
  ) {}

  async assign(
    idOrKey: string,
    agentId: string,
    actorId?: string,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<void> {
    await this.db.transaction(async tx => {
      const cardId = config.auth.mode === 'enforced'
        ? await this.accessPolicy.assertCardWorkspaceScope(idOrKey, auth, tx)
        : await resolveCardId(tx, idOrKey);
      await assertResourcesWorkspace(tx, auth, [['card', cardId], ['agent', agentId]]);
      await assertResourcesShareWorkspace(tx, [['card', cardId], ['agent', agentId]]);
      await assertAgentSelectorScope(tx, agentId, auth, 'card.assign_others');
      const result = await tx.execute(
        'INSERT OR IGNORE INTO card_assignee (card_id, principal_id) VALUES (?, ?)',
        [cardId, agentId],
      );
      if (this.eventService && result.changes > 0) {
        const card = await this.records.requireCard(cardId, tx);
        const projectId = await this.records.projectIdForColumn(card.column_id, tx);
        if (projectId) {
          await this.eventService.create({
            project_id: projectId,
            entity_type: 'card',
            entity_id: cardId,
            action: 'assigned',
            actor_id: actorId,
            payload: { agent_id: agentId },
          }, tx);
        }
      }
    });
  }

  async unassign(
    idOrKey: string,
    agentId: string,
    auth: AuthContext = OPEN_AUTH_CONTEXT,
  ): Promise<void> {
    await this.db.transaction(async tx => {
      const cardId = config.auth.mode === 'enforced'
        ? await this.accessPolicy.assertCardWorkspaceScope(idOrKey, auth, tx)
        : await resolveCardId(tx, idOrKey);
      await assertResourcesWorkspace(tx, auth, [['card', cardId], ['agent', agentId]]);
      await assertResourcesShareWorkspace(tx, [['card', cardId], ['agent', agentId]]);
      await assertAgentSelectorScope(tx, agentId, auth, 'card.assign_others');
      await tx.execute(
        'DELETE FROM card_assignee WHERE card_id = ? AND principal_id = ?',
        [cardId, agentId],
      );
    });
  }

  async claim(
    cardId: string,
    agentId: string,
    ttlSeconds: number = DEFAULT_CLAIM_TTL_SECONDS,
    actorId?: string,
    options: CardOperationOptions = {},
  ): Promise<CardClaimOperationResult> {
    const auth = options.auth || OPEN_AUTH_CONTEXT;
    const canonicalCardId = config.auth.mode === 'enforced'
      ? await this.accessPolicy.assertCardWorkspaceScope(cardId, options.auth)
      : await resolveCardId(this.db, cardId);
    await assertResourcesWorkspace(this.db, auth, [
      ['card', canonicalCardId],
      ['agent', agentId],
    ]);
    await assertResourcesShareWorkspace(this.db, [
      ['card', canonicalCardId],
      ['agent', agentId],
    ]);

    return this.db.transaction(async tx => {
      const card = await this.records.requireCard(canonicalCardId, tx, true);
      await this.accessPolicy.assertCardWorkspaceScope(canonicalCardId, options.auth, tx);
      await assertAgentSelectorScope(tx, agentId, options.auth, 'card.assign_others');
      await this.lanePolicy.assertWorkflowConfigured(card.column_id, 'claim cards', tx);

      const now = new Date();
      const nowIso = now.toISOString();
      const heldByOther = card.claimed_by
        && card.claimed_by !== agentId
        && card.claim_expires_at
        && card.claim_expires_at > nowIso;
      if (heldByOther) {
        const holderRows = await tx.query<{ name: string }>(
          'SELECT a.name FROM agent a JOIN principal p ON a.id = p.id WHERE p.id = ?',
          [card.claimed_by],
        );
        return {
          success: false,
          reason: 'already_claimed',
          card_id: canonicalCardId,
          held_by: {
            id: card.claimed_by as string,
            name: holderRows[0]?.name ?? null,
          },
          claim_expires_at: card.claim_expires_at as string,
        };
      }

      const blockers = await this.lanePolicy.getUnresolvedBlockers(canonicalCardId, tx);
      if (blockers.length > 0 && !options.operatorOverride) {
        const blockerSummary = blockers
          .map(blocker => `${blocker.key} "${blocker.title}"`)
          .join(', ');
        throw new CardRuleError(
          'CARD_BLOCKED',
          `Cannot claim this card while it is blocked by ${blockerSummary}. Resolve the blocking cards or use operator override.`,
          {
            rule: 'blocked_by',
            operation: 'claim',
            blockers: blockers.map(blocker => ({ ...blocker })),
          },
        );
      }

      const expiresIso = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      await tx.execute(
        'UPDATE card SET claimed_by = ?, claimed_at = ?, claim_expires_at = ?, updated_at = ? WHERE id = ?',
        [agentId, nowIso, expiresIso, nowIso, canonicalCardId],
      );
      await tx.execute(
        'INSERT OR IGNORE INTO card_assignee (card_id, principal_id) VALUES (?, ?)',
        [canonicalCardId, agentId],
      );

      if (this.eventService) {
        const projectId = await this.records.projectIdForColumn(card.column_id, tx);
        if (projectId) {
          await this.eventService.create({
            project_id: projectId,
            entity_type: 'card',
            entity_id: canonicalCardId,
            action: 'claimed',
            actor_id: agentId,
            payload: { claim_expires_at: expiresIso },
          }, tx);
          if (blockers.length > 0) {
            await this.eventService.create({
              project_id: projectId,
              entity_type: 'card',
              entity_id: canonicalCardId,
              action: 'override',
              actor_id: actorId || agentId,
              payload: {
                operation: 'claim',
                rule: 'blocked_by',
                blockers: blockers.map(blocker => ({ ...blocker })),
              },
            }, tx);
          }
        }
      }
      return { success: true, cardId: canonicalCardId };
    });
  }

  async renewClaims(
    agentId: string,
    ttlSeconds: number = DEFAULT_CLAIM_TTL_SECONDS,
  ): Promise<void> {
    const expiresIso = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await this.db.execute(
      'UPDATE card SET claim_expires_at = ? WHERE claimed_by = ?',
      [expiresIso, agentId],
    );
  }

  async releaseExpiredLeases(adapter?: DatabaseAdapter): Promise<string[]> {
    if (!adapter) {
      return this.db.transaction(tx => this.releaseExpiredLeases(tx));
    }
    const nowIso = new Date().toISOString();
    const lockClause = adapter.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const expired = await adapter.query<Card>(
      `SELECT * FROM card
       WHERE claimed_by IS NOT NULL
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at <= ?${lockClause}`,
      [nowIso],
    );
    const released: string[] = [];
    for (const card of expired) {
      const updatedAt = new Date().toISOString();
      const result = await adapter.execute(
        `UPDATE card
         SET claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = ?
         WHERE id = ?
           AND claimed_by IS NOT NULL
           AND claim_expires_at IS NOT NULL
           AND claim_expires_at <= ?`,
        [updatedAt, card.id, nowIso],
      );
      if (result.changes !== 1) continue;
      released.push(card.id);
      if (this.eventService) {
        const projectId = await this.records.projectIdForColumn(card.column_id, adapter);
        if (projectId) {
          await this.eventService.create({
            project_id: projectId,
            entity_type: 'card',
            entity_id: card.id,
            action: 'claim_expired',
            payload: { previously_claimed_by: card.claimed_by },
          }, adapter);
        }
      }
    }
    return released;
  }
}
