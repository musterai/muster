const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const BACKSLASH = /\\/;

/**
 * Return a canonical same-origin path, or null for anything a browser could
 * reinterpret as an authority/absolute URL after one or more decoding steps.
 */
export function sanitizeSameOriginPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;

  let decoded = raw;
  for (let pass = 0; pass < 3; pass += 1) {
    if (CONTROL_CHARACTERS.test(decoded) || BACKSLASH.test(decoded)) return null;
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return null;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }

  if (CONTROL_CHARACTERS.test(decoded) || BACKSLASH.test(decoded)) return null;
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return null;

  try {
    const base = new URL('https://muster.invalid/');
    const parsed = new URL(raw, base);
    if (parsed.origin !== base.origin || parsed.username || parsed.password) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
