// File: tests/connect-remote-client.test.ts
//
// `muster login`/`logout` (MUS-27) validate a pasted token and find its own
// token_id by matching the prefix segment of the token string against
// GET /tokens — these are the calls that do that, against a real HTTP server.

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { whoAmI, listMyTokens, tokenPrefix, revokeToken, RemoteError } from '../src/connect/remote-client.js';

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof express.application.listen>; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('MUS-27: remote-client (muster login/logout helpers)', () => {
  let server: ReturnType<typeof express.application.listen> | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('tokenPrefix extracts the prefix segment from muster_pat_<prefix>_<secret>', () => {
    expect(tokenPrefix('muster_pat_ab12cd34_deadbeefcafe')).toBe('ab12cd34');
    expect(tokenPrefix('not-a-muster-token')).toBeNull();
    expect(tokenPrefix('muster_pat_only-three-parts')).toBeNull();
  });

  it('whoAmI reports the authenticated user for a valid token', async () => {
    const app = express();
    app.get('/api/v1/auth/me', (req, res) => {
      if (req.headers.authorization === 'Bearer good-token') {
        res.json({ authenticated: true, admitted: true, user: { id: 'u1', display_name: 'Ada' } });
      } else {
        res.json({ authenticated: false, admitted: false, user: null });
      }
    });
    const { server: s, baseUrl } = await listen(app);
    server = s;

    const me = await whoAmI(baseUrl, 'good-token');
    expect(me.authenticated).toBe(true);
    expect(me.user?.display_name).toBe('Ada');

    const rejected = await whoAmI(baseUrl, 'bad-token');
    expect(rejected.authenticated).toBe(false);
  });

  it('whoAmI throws RemoteError when the server is unreachable', async () => {
    await expect(whoAmI('http://127.0.0.1:1', 'x')).rejects.toBeInstanceOf(RemoteError);
  });

  it('does not include bearer token material in a connection error', async () => {
    const bearer = 'muster_pat_redaction_secret';
    try {
      await whoAmI('http://127.0.0.1:1', bearer);
      throw new Error('expected whoAmI to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteError);
      expect((err as Error).message).not.toContain(bearer);
    }
  });

  it('listMyTokens finds the just-pasted token by its prefix, not its secret', async () => {
    const app = express();
    app.get('/api/v1/tokens', (_req, res) => {
      res.json([
        { id: 'tok-old', prefix: 'aaaaaaaa', name: 'old laptop', revoked_at: null },
        { id: 'tok-new', prefix: 'bb112233', name: 'this login', revoked_at: null },
      ]);
    });
    const { server: s, baseUrl } = await listen(app);
    server = s;

    const pasted = 'muster_pat_bb112233_somesecrethexvalue';
    const prefix = tokenPrefix(pasted)!;
    const tokens = await listMyTokens(baseUrl, pasted);
    const match = tokens.find(t => t.prefix === prefix);
    expect(match?.id).toBe('tok-new');
  });

  it('revokeToken calls DELETE on the token id and never throws on network failure', async () => {
    let deletedId: string | null = null;
    const app = express();
    app.delete('/api/v1/tokens/:id', (req, res) => {
      deletedId = req.params.id;
      res.status(200).json({ message: 'Token revoked', id: req.params.id });
    });
    const { server: s, baseUrl } = await listen(app);
    server = s;

    await revokeToken(baseUrl, 'muster_pat_bb112233_secret', 'tok-new');
    expect(deletedId).toBe('tok-new');

    // Best-effort — logout must still proceed locally even if the network call fails.
    await expect(revokeToken('http://127.0.0.1:1', 'x', 'tok-new')).resolves.toBeUndefined();
  });
});
