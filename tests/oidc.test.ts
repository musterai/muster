// File: tests/oidc.test.ts
//
// MUS-25 acceptance criteria (OIDC relying-party flow):
// - callback with a mismatched state is refused
// - callback with a replayed nonce is refused
// - an ID token signed by an unknown key is refused
// - a replayed callback URL (reused state) is refused — state is single-use
// - an expired authorization attempt is refused
//
// These are exercised against a real, in-process fake OIDC provider
// (tests/helpers/fake-oidc-provider.ts) that issues genuinely signed JWTs,
// so signature/PKCE/nonce verification is real, not mocked.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import { OidcService } from '../src/services/oidc.service.js';
import { config } from '../src/config/index.js';
import { FakeOidcProvider } from './helpers/fake-oidc-provider.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-oidc.db');
const REDIRECT_URI = 'http://localhost:6878/api/v1/auth/callback';

describe('MUS-25: OIDC relying-party flow', () => {
  let provider: FakeOidcProvider;
  let originalOidcConfig: typeof config.oidc;

  beforeAll(async () => {
    provider = await FakeOidcProvider.start();
    originalOidcConfig = { ...config.oidc };
    (config.oidc as any).issuer = provider.issuer;
    (config.oidc as any).clientId = 'test-client-id';
    (config.oidc as any).clientSecret = 'test-client-secret';
  });

  afterAll(async () => {
    await provider.stop();
    Object.assign(config.oidc, originalOidcConfig);
  });

  let db: DatabaseAdapter;
  let oidcService: OidcService;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);
    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();
    oidcService = new OidcService(db);
    provider.overrideNonce = null;
    provider.useForeignKeyForNextToken = false;
    provider.discoveryUnavailable = false;
  });

  afterEach(async () => {
    if (db) await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* ok */ }
    }
  });

  async function runHappyPathUpTo(step: 'authorize'): Promise<{ authorizeParams: URLSearchParams }> {
    const loginUrl = await oidcService.buildLoginUrl(REDIRECT_URI, '/dashboard');
    const authorizeParams = new URL(loginUrl).searchParams;
    return { authorizeParams };
  }

  it('completes the full authorization code + PKCE flow and resolves the correct claims', async () => {
    provider.setNextIdentity('sub-alice', 'alice@example.com');
    const { authorizeParams } = await runHappyPathUpTo('authorize');

    const callbackUrl = provider.authorize(authorizeParams);
    const result = await oidcService.handleCallback(callbackUrl);

    expect(result.sub).toBe('sub-alice');
    expect(result.email).toBe('alice@example.com');
    expect(result.redirectTo).toBe('/dashboard');
  });

  it('recovers after discovery is temporarily unavailable without restarting Muster', async () => {
    provider.discoveryUnavailable = true;
    await expect(oidcService.buildLoginUrl(REDIRECT_URI)).rejects.toThrow();
    provider.discoveryUnavailable = false;
    const loginUrl = await oidcService.buildLoginUrl(REDIRECT_URI);
    const result = await oidcService.handleCallback(provider.authorize(new URL(loginUrl).searchParams));
    expect(result.sub).toBeTruthy();
  });

  it('accepts a published replacement signing key after the JWKS refresh cooldown', async () => {
    const completeLogin = async () => {
      const loginUrl = await oidcService.buildLoginUrl(REDIRECT_URI);
      return oidcService.handleCallback(provider.authorize(new URL(loginUrl).searchParams));
    };
    await completeLogin(); // Populate the relying party's JWKS cache.
    await provider.rotateSigningKey();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Only advance the clock; HTTP, PKCE, token signatures, and discovery
      // remain real. Respect the library's 60-second JWKS fetch cooldown.
      vi.setSystemTime(Date.now() + 61_000);
      expect((await completeLogin()).sub).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('refuses a callback with a mismatched state', async () => {
    provider.setNextIdentity('sub-bob', 'bob@example.com');
    const { authorizeParams } = await runHappyPathUpTo('authorize');
    const callbackUrl = provider.authorize(authorizeParams);

    // Tamper with the state after the provider issued the code for the real one
    callbackUrl.searchParams.set('state', 'attacker-supplied-state');

    await expect(oidcService.handleCallback(callbackUrl)).rejects.toThrow();
  });

  it('refuses a replayed callback URL — state is single-use', async () => {
    provider.setNextIdentity('sub-carol', 'carol@example.com');
    const { authorizeParams } = await runHappyPathUpTo('authorize');
    const callbackUrl = provider.authorize(authorizeParams);

    await oidcService.handleCallback(callbackUrl); // first use succeeds
    await expect(oidcService.handleCallback(callbackUrl)).rejects.toThrow(); // replay refused
  });

  it('refuses an ID token whose nonce does not match the expected nonce', async () => {
    provider.setNextIdentity('sub-dave', 'dave@example.com');
    const { authorizeParams } = await runHappyPathUpTo('authorize');

    provider.overrideNonce = 'a-stale-nonce-from-another-session';
    const callbackUrl = provider.authorize(authorizeParams);

    await expect(oidcService.handleCallback(callbackUrl)).rejects.toThrow();
  });

  it('refuses an ID token signed by an unknown key', async () => {
    provider.setNextIdentity('sub-erin', 'erin@example.com');
    const { authorizeParams } = await runHappyPathUpTo('authorize');

    provider.useForeignKeyForNextToken = true;
    const callbackUrl = provider.authorize(authorizeParams);

    await expect(oidcService.handleCallback(callbackUrl)).rejects.toThrow();
  });

  it('refuses an expired authorization attempt', async () => {
    provider.setNextIdentity('sub-frank', 'frank@example.com');
    const { authorizeParams } = await runHappyPathUpTo('authorize');

    // Force the stored transaction to already be expired
    const state = authorizeParams.get('state')!;
    await db.execute("UPDATE oidc_transaction SET expires_at = datetime('now', '-1 hour') WHERE state = ?", [state]);

    const callbackUrl = provider.authorize(authorizeParams);
    await expect(oidcService.handleCallback(callbackUrl)).rejects.toThrow(/expired/i);
  });

  it('refuses an unknown state that was never issued', async () => {
    const fakeUrl = new URL(REDIRECT_URI);
    fakeUrl.searchParams.set('code', 'whatever');
    fakeUrl.searchParams.set('state', 'never-issued-state');
    await expect(oidcService.handleCallback(fakeUrl)).rejects.toThrow();
  });
});
