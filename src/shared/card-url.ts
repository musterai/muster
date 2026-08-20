/**
 * Canonical browser route for a Muster card. The human-readable key is the
 * preferred reference, but the route also accepts an immutable card ULID.
 */
export function cardWebPath(cardReference: string): string {
  return `/cards/${encodeURIComponent(cardReference)}`;
}

export function cardWebUrl(publicUrl: string, cardReference: string): string {
  return `${publicUrl.replace(/\/$/, '')}${cardWebPath(cardReference)}`;
}
