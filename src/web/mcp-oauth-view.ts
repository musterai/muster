/** Authorization navigation and consent submission have different schemas. */
export function consentRequestParams(search: string): Record<string, string> {
  const query = new URLSearchParams(search);
  const result: Record<string, string> = {};
  for (const key of ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'resource', 'state']) {
    const value = query.get(key);
    if (value !== null) result[key] = value;
  }
  return result;
}
