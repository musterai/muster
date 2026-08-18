// File: tests/connect-credentials.test.ts
//
// MUS-27 acceptance criterion: the credentials file is created with mode
// 0600. MUS-64 keeps these tests hermetic: each test owns a unique root and
// injects its credential path instead of changing HOME or cleaning up the
// process-wide default path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCredentialStore,
  credentialsPath,
  normalizeServerUrl,
  writePrivateFileAtomic,
  UnsafeCredentialPathError,
  type CredentialStore,
} from '../src/connect/credentials.js';

interface CleanupScope {
  root: string;
  credentialFile: string;
  sentinelFile: string;
  trackedPaths: Set<string>;
  store: CredentialStore;
}

const originalHome = process.env.HOME;

function isWithinRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

/**
 * Remove only paths that this test explicitly registered under its own root.
 * The guard is intentionally exercised by a failure-path test below.
 */
function removeTrackedPath(scope: CleanupScope, target: string, recursive = false): void {
  const resolvedTarget = path.resolve(target);
  if (!isWithinRoot(scope.root, resolvedTarget)) {
    throw new Error(`Refusing to remove path outside the test root: ${resolvedTarget}`);
  }
  if (!scope.trackedPaths.has(resolvedTarget)) {
    throw new Error(`Refusing to remove untracked test path: ${resolvedTarget}`);
  }

  fs.rmSync(resolvedTarget, { force: true, recursive });
  scope.trackedPaths.delete(resolvedTarget);
}

function cleanupScope(scope: CleanupScope): void {
  // Remove children first. The root is tracked too, and is removed last with
  // recursive cleanup only after the same root-boundary guard passes.
  const targets = [...scope.trackedPaths].sort((a, b) => b.length - a.length);
  for (const target of targets) {
    removeTrackedPath(scope, target, target === path.resolve(scope.root));
  }
}

function createScope(): CleanupScope {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-creds-test-'));
  const credentialFile = path.join(root, 'credentials.json');
  const sentinelFile = path.join(root, 'operator-credentials-sentinel.json');
  const trackedPaths = new Set([path.resolve(root), path.resolve(credentialFile), path.resolve(sentinelFile)]);

  return {
    root,
    credentialFile,
    sentinelFile,
    trackedPaths,
    store: createCredentialStore({ filePath: credentialFile }),
  };
}

function credential(token: string) {
  return { token, token_id: 'tok-1', created_at: '2026-01-01T00:00:00.000Z' };
}

describe('MUS-27: credentials.json', () => {
  let scope: CleanupScope | null = null;

  beforeEach(() => {
    scope = createScope();
  });

  afterEach(() => {
    const activeScope = scope;
    scope = null;
    try {
      if (activeScope) cleanupScope(activeScope);
    } finally {
      // These tests never mutate HOME. Keep this assertion so a future test
      // that does must restore process-global state even on failure.
      expect(process.env.HOME).toBe(originalHome);
    }
  });

  it('is created with mode 0600', () => {
    scope!.store.setCredential('https://muster.example.com', credential('token-a'));
    const stat = fs.statSync(scope!.credentialFile);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(scope!.credentialFile)).mode & 0o777).toBe(0o700);
  });

  it('round-trips a credential by server URL', () => {
    scope!.store.setCredential('https://muster.example.com', credential('token-a'));
    expect(scope!.store.getCredential('https://muster.example.com')?.token).toBe('token-a');
  });

  it('normalizes a trailing slash so it matches the same server', () => {
    scope!.store.setCredential('https://muster.example.com', credential('token-a'));
    expect(scope!.store.getCredential('https://muster.example.com/')?.token).toBe('token-a');
    expect(normalizeServerUrl('https://muster.example.com/')).toBe('https://muster.example.com');
  });

  it('rejects secret-bearing and non-HTTP server URLs', () => {
    expect(() => normalizeServerUrl('https://user:secret@muster.example.com')).toThrow(/must not contain credentials/);
    expect(() => normalizeServerUrl('https://muster.example.com/?token=secret')).toThrow(/query string/);
    expect(() => normalizeServerUrl('file:///tmp/muster')).toThrow(/HTTP or HTTPS/);
  });

  it('keeps credentials for more than one server independently', () => {
    scope!.store.setCredential('https://a.example.com', credential('token-a'));
    scope!.store.setCredential('https://b.example.com', credential('token-b'));
    expect(scope!.store.listServers().sort()).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(scope!.store.getCredential('https://a.example.com')?.token).toBe('token-a');
    expect(scope!.store.getCredential('https://b.example.com')?.token).toBe('token-b');
  });

  it('removes a credential without disturbing others', () => {
    scope!.store.setCredential('https://a.example.com', credential('token-a'));
    scope!.store.setCredential('https://b.example.com', credential('token-b'));
    scope!.store.removeCredential('https://a.example.com');
    expect(scope!.store.getCredential('https://a.example.com')).toBeNull();
    expect(scope!.store.getCredential('https://b.example.com')?.token).toBe('token-b');
  });

  it('returns null for a server with no saved credential', () => {
    expect(scope!.store.getCredential('https://never-logged-in.example.com')).toBeNull();
  });

  it('writes only to the injected root while an operator sentinel stays byte-for-byte unchanged', () => {
    const sentinel = Buffer.from('operator credential sentinel\n', 'utf8');
    fs.writeFileSync(scope!.sentinelFile, sentinel, { mode: 0o600 });

    // Resolve the default path as a string only; do not probe it on disk. The
    // real ~/.muster/credentials.json is never read or written by this test.
    const defaultPath = credentialsPath();
    expect(scope!.store.credentialsPath()).not.toBe(defaultPath);

    scope!.store.setCredential('https://muster.example.com', credential('token-a'));
    expect(fs.readFileSync(scope!.sentinelFile)).toEqual(sentinel);
    expect(isWithinRoot(scope!.root, scope!.store.credentialsPath())).toBe(true);
  });

  it('refuses failure cleanup outside the unique root and leaves the foreign sentinel untouched', () => {
    const foreignScope = createScope();
    const foreignSentinel = Buffer.from('foreign operator data\n', 'utf8');
    fs.writeFileSync(foreignScope.sentinelFile, foreignSentinel, { mode: 0o600 });

    try {
      expect(() => removeTrackedPath(scope!, foreignScope.sentinelFile)).toThrow(/outside the test root/);
      expect(fs.readFileSync(foreignScope.sentinelFile)).toEqual(foreignSentinel);
    } finally {
      cleanupScope(foreignScope);
    }
  });

  it('supports an injected home directory without mutating process.env', () => {
    const injectedHome = path.join(scope!.root, 'fake-home');
    expect(credentialsPath(injectedHome)).toBe(path.join(injectedHome, '.muster', 'credentials.json'));
    expect(process.env.HOME).toBe(originalHome);
  });

  it('atomically replaces private files without leaving temporary secret copies', () => {
    writePrivateFileAtomic(scope!.credentialFile, 'first\n');
    writePrivateFileAtomic(scope!.credentialFile, 'second\n');
    expect(fs.readFileSync(scope!.credentialFile, 'utf8')).toBe('second\n');
    expect(fs.statSync(scope!.credentialFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(scope!.root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the previous credential intact when replacement is interrupted before rename', () => {
    scope!.store.setCredential('https://muster.example.com', credential('token-before'));
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('injected rename interruption');
    });
    try {
      expect(() => scope!.store.setCredential('https://muster.example.com', credential('token-after')))
        .toThrow(/injected rename interruption/);
    } finally {
      rename.mockRestore();
    }

    expect(scope!.store.getCredential('https://muster.example.com')?.token).toBe('token-before');
    expect(fs.readdirSync(scope!.root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('refuses a symlink credential target without changing its destination', () => {
    const destination = path.join(scope!.root, 'destination.json');
    scope!.trackedPaths.add(path.resolve(destination));
    fs.writeFileSync(destination, 'sentinel', { mode: 0o600 });
    fs.symlinkSync(destination, scope!.credentialFile);

    expect(() => scope!.store.setCredential('https://muster.example.com', credential('secret')))
      .toThrow(UnsafeCredentialPathError);
    expect(fs.readFileSync(destination, 'utf8')).toBe('sentinel');
  });

  it.runIf(process.platform !== 'win32')('rejects a shared directory without silently changing its permissions', () => {
    const sharedDir = path.join(scope!.root, 'shared');
    fs.mkdirSync(sharedDir, { mode: 0o755 });
    fs.chmodSync(sharedDir, 0o755);
    const target = path.join(sharedDir, 'config.json');

    expect(() => writePrivateFileAtomic(target, 'secret')).toThrow(UnsafeCredentialPathError);
    expect(fs.statSync(sharedDir).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(target)).toBe(false);
  });
});
