import { DatabaseAdapter } from '../../db/adapter.js';
import { NotFoundError } from '../../shared/errors.js';

/**
 * Resolve the caller-facing card reference used by APIs to the immutable
 * database ID used by foreign keys and relationship tables.
 */
export async function resolveCardId(db: DatabaseAdapter, idOrKey: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM card WHERE id = ? OR key = ?',
    [idOrKey, idOrKey],
  );
  const card = rows[0];
  if (!card) {
    throw new NotFoundError(`Card with ID or key ${idOrKey} not found`);
  }
  return card.id;
}
