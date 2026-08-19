import type { DatabaseAdapter } from '../db/adapter.js';
import type { Card } from '../shared/types.js';
import { NotFoundError } from '../shared/errors.js';

/**
 * Minimal card record queries shared by mutation collaborators.
 * Hydrated transport-facing reads remain in CardService for compatibility.
 */
export class CardRecordQueries {
  constructor(private readonly db: DatabaseAdapter) {}

  async requireCard(
    cardId: string,
    adapter: DatabaseAdapter = this.db,
    lock = false,
  ): Promise<Card> {
    const lockClause = lock && adapter.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const rows = await adapter.query<Card>(`SELECT * FROM card WHERE id = ?${lockClause}`, [cardId]);
    if (!rows[0]) throw new NotFoundError(`Card with ID ${cardId} not found`);
    return rows[0];
  }

  async projectIdForColumn(
    columnId: string,
    adapter: DatabaseAdapter = this.db,
  ): Promise<string | null> {
    const rows = await adapter.query<{ project_id: string }>(
      `SELECT b.project_id
       FROM board b JOIN "column" c ON c.board_id = b.id
       WHERE c.id = ?`,
      [columnId],
    );
    return rows[0]?.project_id ?? null;
  }
}
