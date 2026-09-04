import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/web/api.js';
import { consentRequestParams } from '../src/web/mcp-oauth-view.js';
import { oauthAuthorizeDetailsQuerySchema, oauthConsentSchema } from '../src/api/schemas.js';

afterEach(() => vi.unstubAllGlobals());

it('loads consent details using only the client ID and server-issued pagination', async () => {
  const queries: Record<string, string>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const query = Object.fromEntries(new URL(url, 'https://muster.test').searchParams);
    queries.push(query);
    expect(oauthAuthorizeDetailsQuerySchema.safeParse(query).success).toBe(true);
    return Response.json({ client_name: 'Test', agents: [], roles: [], page: {
      has_more: queries.length === 1, next_cursor: queries.length === 1 ? 'opaque_cursor' : null,
    } });
  }));
  await api.mcpAuthorizeDetails('client&identifier');
  expect(queries).toEqual([
    { client_id: 'client&identifier', limit: '100' },
    { client_id: 'client&identifier', limit: '100', cursor: 'opaque_cursor' },
  ]);
});

it('submits a valid consent body from the full OAuth authorization URL', () => {
  const query = new URLSearchParams({ response_type: 'code', client_id: 'test',
    redirect_uri: 'http://127.0.0.1:8765/callback', code_challenge: 'challenge',
    code_challenge_method: 'S256', resource: 'https://muster.test/mcp', state: 'state',
    decision: 'approve', agent_id: 'injected', unknown: 'extra',
  });
  const payload = { ...consentRequestParams(query.toString()), decision: 'deny' };
  expect(oauthConsentSchema.safeParse(payload).success).toBe(true);
  expect(payload).not.toHaveProperty('response_type');
  expect(payload).not.toHaveProperty('agent_id');
  expect(payload).not.toHaveProperty('unknown');
});
