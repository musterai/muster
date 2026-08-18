const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const BACKSLASH = /\\/;

/**
 * Return a canonical same-origin path, or null for anything a browser could
 * reinterpret as an authority/absolute URL after one or more decoding steps.
 */
export function sanitizeSameOriginPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;

  let decoded = raw;
  let stabilized = false;
  for (let pass = 0; pass < 5; pass += 1) {
    if (CONTROL_CHARACTERS.test(decoded) || BACKSLASH.test(decoded)) return null;
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return null;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        stabilized = true;
        break;
      }
      decoded = next;
    } catch {
      return null;
    }
  }
  if (!stabilized) return null;

  if (CONTROL_CHARACTERS.test(decoded) || BACKSLASH.test(decoded)) return null;
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return null;

  try {
    const base = new URL('https://muster.invalid/');
    // Parse the fully decoded representation so encoded dot/slash segments
    // cannot normalize into a protocol-relative path after this check.
    const parsed = new URL(decoded, base);
    if (parsed.origin !== base.origin || parsed.username || parsed.password) return null;
    const canonical = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (!canonical.startsWith('/') || canonical.startsWith('//')) return null;
    return canonical;
  } catch {
    return null;
  }
}
