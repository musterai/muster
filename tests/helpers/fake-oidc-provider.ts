// File: tests/helpers/fake-oidc-provider.ts
//
// A minimal, in-process OIDC provider used only by tests, so MUS-25's
// Authorization Code + PKCE flow can be exercised genuinely — including real
// JWKS-based ID token signature verification — without a network dependency
// on a real IdP (Keycloak/Authentik/etc).

import http from 'node:http';
import { AddressInfo } from 'node:net';
import * as jose from 'jose';
import crypto from 'node:crypto';

interface PendingAuthorization {
  codeChallenge: string;
  redirectUri: string;
  nonce: string;
  state: string;
  sub: string;
  email: string | null;
  emailVerified: unknown;
}

export class FakeOidcProvider {
  private server: http.Server;
  public issuer = '';
  private privateKey!: CryptoKey;
  private publicJwk!: jose.JWK;
  private kid = 'test-key-1';

  // code -> pending authorization details, single-use (deleted on redemption)
  private codes = new Map<string, PendingAuthorization>();
  private nextSub = 'user-1';
  private nextEmail: string | null = 'user@example.com';
  private nextEmailVerified: unknown = true;
  /** When set, the next issued ID token's nonce is overridden (simulates a replayed/stale token). */
  overrideNonce: string | null = null;
  /** When set, sign the next ID token with this key instead of the provider's own (simulates an unknown-key attack). */
  useForeignKeyForNextToken = false;
  private foreignPrivateKey: CryptoKey | null = null;

  private constructor() {}

  static async start(): Promise<FakeOidcProvider> {
    const provider = new FakeOidcProvider();
    const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { extractable: true });
    provider.privateKey = privateKey;
    provider.publicJwk = await jose.exportJWK(publicKey);
    provider.publicJwk.kid = provider.kid;
    provider.publicJwk.alg = 'RS256';
    provider.publicJwk.use = 'sig';

    const foreign = await jose.generateKeyPair('RS256', { extractable: true });
    provider.foreignPrivateKey = foreign.privateKey;

    provider.server = http.createServer((req, res) => provider.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      provider.server.listen(0, '127.0.0.1', resolve);
      provider.server.once('error', reject);
    });
    const port = (provider.server.address() as AddressInfo).port;
    provider.issuer = `http://127.0.0.1:${port}`;
    return provider;
  }

  setNextIdentity(sub: string, email: string | null, emailVerified?: unknown): void {
    this.nextSub = sub;
    this.nextEmail = email;
    this.nextEmailVerified = arguments.length >= 3 ? emailVerified : true;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Simulates the user completing the consent screen at the authorization_endpoint. */
  authorize(params: URLSearchParams): URL {
    const redirectUri = params.get('redirect_uri')!;
    const state = params.get('state')!;
    const nonce = params.get('nonce') || '';
    const codeChallenge = params.get('code_challenge')!;

    const code = crypto.randomBytes(16).toString('hex');
    this.codes.set(code, {
      codeChallenge, redirectUri, nonce, state, sub: this.nextSub, email: this.nextEmail,
      emailVerified: this.nextEmailVerified,
    });

    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', state);
    return url;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', this.issuer);

    if (url.pathname === '/.well-known/openid-configuration') {
      this.json(res, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
      return;
    }

    if (url.pathname === '/jwks') {
      this.json(res, { keys: [this.publicJwk] });
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const body = await this.readBody(req);
      const params = new URLSearchParams(body);
      const code = params.get('code') || '';
      const codeVerifier = params.get('code_verifier') || '';

      const pending = this.codes.get(code);
      // Single-use: delete on first redemption attempt, valid or not.
      this.codes.delete(code);

      if (!pending) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }

      const expectedChallenge = base64url(await sha256(codeVerifier));
      if (expectedChallenge !== pending.codeChallenge) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' }));
        return;
      }

      const signingKey = this.useForeignKeyForNextToken ? this.foreignPrivateKey! : this.privateKey;
      const nonceToUse = this.overrideNonce !== null ? this.overrideNonce : pending.nonce;

      const idToken = await new jose.SignJWT({
        sub: pending.sub,
        email: pending.email || undefined,
        email_verified: pending.emailVerified,
        nonce: nonceToUse || undefined,
      })
        .setProtectedHeader({ alg: 'RS256', kid: this.useForeignKeyForNextToken ? 'foreign-key' : this.kid })
        .setIssuedAt()
        .setIssuer(this.issuer)
        .setAudience('test-client-id')
        .setExpirationTime('5m')
        .sign(signingKey);

      this.json(res, {
        access_token: 'fake-access-token',
        token_type: 'Bearer',
        id_token: idToken,
        expires_in: 300,
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  }

  private json(res: http.ServerResponse, body: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => resolve(data));
    });
  }
}

async function sha256(input: string): Promise<Uint8Array> {
  const hash = crypto.createHash('sha256').update(input).digest();
  return new Uint8Array(hash);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
