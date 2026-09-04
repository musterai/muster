// File: src/services/oidc.service.ts
//
// OIDC relying-party flow for MUS-25 (Authorization Code + PKCE).
// Muster is a client, never an identity provider. Signature verification,
// JWKS handling, clock skew, and nonce/state/iss/aud checks are delegated to
// `openid-client` — a maintained RP library — rather than hand-rolled, per
// the card's own guidance: this is exactly where hand-rolled OIDC quietly
// fails open.

import * as client from 'openid-client';
import { DatabaseAdapter } from '../db/adapter.js';
import { config } from '../config/index.js';

/** How long an in-flight authorization attempt (state/nonce/PKCE) stays valid. */
const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export interface OidcCallbackResult {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  redirectTo: string | null;
}

export class OidcService {
  private discoveryConfig: client.Configuration | null = null;
  private discoveryPromise: Promise<client.Configuration> | null = null;

  constructor(private db: DatabaseAdapter) {}

  private async getConfig(): Promise<client.Configuration> {
    if (this.discoveryConfig) return this.discoveryConfig;
    if (!this.discoveryPromise) {
      const { issuer, clientId, clientSecret } = config.oidc;
      if (!issuer || !clientId || !clientSecret) {
        throw new Error('OIDC is not configured: set MUSTER_OIDC_ISSUER, MUSTER_OIDC_CLIENT_ID, MUSTER_OIDC_CLIENT_SECRET');
      }
      const issuerUrl = new URL(issuer);

      // `execute` steps run in order, immediately after discovery resolves —
      // applying them via discovery's own options (rather than patching the
      // Configuration afterward) matters for allowInsecureRequests, since
      // discovery's own metadata fetch would otherwise be rejected before a
      // Configuration object exists to patch.
      //
      // enableNonRepudiationChecks is NOT optional here even though the spec
      // treats ID token signature verification as unnecessary for a token
      // obtained directly from a TLS-secured token endpoint (the channel
      // itself authenticates the issuer) — MUS-25 explicitly requires
      // defense-in-depth signature verification against the JWKS.
      const executeSteps: Array<(c: client.Configuration) => void> = [client.enableNonRepudiationChecks];
      if (issuerUrl.protocol === 'http:') {
        executeSteps.unshift(client.allowInsecureRequests); // dev convenience only — real deployments must use https issuers
      }

      this.discoveryPromise = client.discovery(issuerUrl, clientId, clientSecret, undefined, { execute: executeSteps }).then((c) => {
        this.discoveryConfig = c;
        return c;
      }).catch((error: unknown) => {
        // A failed first discovery must not poison every future login. Keep
        // sharing in-flight requests, but retry discovery after an IdP outage.
        this.discoveryPromise = null;
        throw error;
      });
    }
    return this.discoveryPromise;
  }

  /** Test/reset hook — forces re-discovery on next call. */
  resetDiscoveryCache(): void {
    this.discoveryConfig = null;
    this.discoveryPromise = null;
  }

  /**
   * Build the authorization URL for this login attempt and persist the
   * single-use state/nonce/PKCE verifier server-side.
   */
  async buildLoginUrl(redirectUri: string, redirectTo?: string | null): Promise<string> {
    const oidcConfig = await this.getConfig();

    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

    const now = Date.now();
    await this.db.execute(
      `INSERT INTO oidc_transaction (state, nonce, pkce_verifier, redirect_to, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        state, nonce, codeVerifier, redirectTo || null,
        new Date(now).toISOString(), new Date(now + TRANSACTION_TTL_MS).toISOString(),
      ],
    );

    const url = client.buildAuthorizationUrl(oidcConfig, {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return url.href;
  }

  /**
   * Validate and consume the callback. The state lookup is deleted before
   * anything else runs — a replayed callback URL always sees "unknown state",
   * whether the first attempt succeeded or failed.
   */
  async handleCallback(currentUrl: URL): Promise<OidcCallbackResult> {
    const stateParam = currentUrl.searchParams.get('state');
    if (!stateParam) throw new Error('Callback is missing the state parameter');

    const rows = await this.db.query<any>('SELECT * FROM oidc_transaction WHERE state = ?', [stateParam]);
    await this.db.execute('DELETE FROM oidc_transaction WHERE state = ?', [stateParam]);

    if (rows.length === 0) throw new Error('Unknown, expired, or already-used authorization attempt');
    const txn = rows[0];

    if (new Date(txn.expires_at).getTime() <= Date.now()) {
      throw new Error('Authorization attempt expired');
    }

    const oidcConfig = await this.getConfig();

    // Signature, iss, aud, exp, and nonce are all verified inside this call.
    const tokens = await client.authorizationCodeGrant(oidcConfig, currentUrl, {
      expectedState: stateParam,
      expectedNonce: txn.nonce,
      pkceCodeVerifier: txn.pkce_verifier,
    });

    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== 'string') {
      throw new Error('ID token is missing a sub claim');
    }

    return {
      sub: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      // OIDC defines email_verified as a JSON boolean. Fail closed for
      // missing or string/number lookalikes supplied by non-conforming IdPs.
      emailVerified: claims.email_verified === true,
      redirectTo: txn.redirect_to || null,
    };
  }
}
