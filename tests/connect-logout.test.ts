import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCredentialStore } from '../src/connect/credentials.js';
import { logoutCredential } from '../src/connect/logout.js';
import { RemoteError } from '../src/connect/remote-client.js';

const SERVER = 'https://muster.example.com';

function withStore(run: (store: ReturnType<typeof createCredentialStore>) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-logout-test-'));
  const store = createCredentialStore({ filePath: path.join(root, 'credentials.json') });
  return run(store).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

function seed(store: ReturnType<typeof createCredentialStore>, tokenId: string | null = 'token-id'): void {
  store.setCredential(SERVER, {
    token: 'muster_pat_prefix_secret',
    token_id: tokenId,
    created_at: '2026-01-01T00:00:00.000Z',
  });
}

describe('MUS-71 logout recovery semantics', () => {
  it.each([
    ['revoked', 'logged_out'],
    ['already_revoked', 'already_revoked'],
  ] as const)('removes the local credential after confirmed %s state', async (remote, expected) => {
    await withStore(async (store) => {
      seed(store);
      const result = await logoutCredential(SERVER, { store, revoke: async () => remote });
      expect(result.status).toBe(expected);
      expect(store.getCredential(SERVER)).toBeNull();
    });
  });

  it.each([
    [new RemoteError('network unavailable'), 'network_failure'],
    [new RemoteError('server refused', 403), 'server_refusal'],
  ] as const)('retains the recovery credential after %s', async (failure, expected) => {
    await withStore(async (store) => {
      seed(store);
      const result = await logoutCredential(SERVER, { store, revoke: async () => { throw failure; } });
      expect(result.status).toBe(expected);
      expect(store.getCredential(SERVER)?.token_id).toBe('token-id');
    });
  });

  it('retains an untracked credential unless local-only removal is explicit', async () => {
    await withStore(async (store) => {
      seed(store, null);
      const retained = await logoutCredential(SERVER, { store });
      expect(retained.status).toBe('untracked_remote_token');
      expect(store.getCredential(SERVER)).not.toBeNull();

      const removed = await logoutCredential(SERVER, { store, localOnly: true });
      expect(removed.status).toBe('local_only');
      expect(store.getCredential(SERVER)).toBeNull();
    });
  });
});
