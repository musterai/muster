// File: src/connect/credentials.ts
//
// `muster login` stores a bearer token at ~/.muster/credentials.json, mode
// 0600, keyed by server URL so one user can be connected to more than one
// server. Design doc §7.2 / §8.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface StoredCredential {
  token: string;
  /** api_token.id upstream — lets `muster logout` revoke server-side without re-deriving it from the token's prefix. */
  token_id: string | null;
  created_at: string;
}

interface CredentialsFile {
  servers: Record<string, StoredCredential>;
}

export interface CredentialStoreOptions {
  /**
   * Exact file to use for this store. This is primarily useful for isolated
   * callers such as tests; the CLI leaves it unset and uses the user's home.
   */
  filePath?: string;
  /** Home directory used when `filePath` is not provided. */
  homeDir?: string;
}

export interface CredentialStore {
  credentialsPath(): string;
  getCredential(server: string): StoredCredential | null;
  setCredential(server: string, credential: StoredCredential): void;
  removeCredential(server: string): void;
  listServers(): string[];
}

/**
 * Resolve the default location at call time rather than while this module is
 * imported. `homeDir` is injectable so a caller never needs to mutate `HOME`
 * merely to select an isolated credential file.
 */
export function credentialsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.muster', 'credentials.json');
}

/** Canonical, non-secret server URL used as the lookup key. */
export function normalizeServerUrl(server: string): string {
  let parsed: URL;
  try {
    parsed = new URL(server.trim());
  } catch {
    throw new Error('Server URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Server URL must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Server URL must not contain credentials, a query string, or a fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.pathname === '/' ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
}

function readFile(file: string): CredentialsFile {
  if (!fs.existsSync(file)) return { servers: {} };
  try {
    assertSafeExistingFile(file);
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return { servers: parsed.servers || {} };
  } catch (error) {
    if (error instanceof UnsafeCredentialPathError) throw error;
    return { servers: {} };
  }
}

export class UnsafeCredentialPathError extends Error {}

function assertOwned(stat: fs.Stats, target: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new UnsafeCredentialPathError(`Refusing credential path not owned by the current user: ${target}`);
  }
}

function assertSafeExistingFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new UnsafeCredentialPathError(`Refusing unsafe credential file: ${file}`);
  }
  assertOwned(stat, file);
  if ((stat.mode & 0o077) !== 0) {
    throw new UnsafeCredentialPathError(`Refusing credential file accessible by other users: ${file}`);
  }
}

function ensurePrivateDirectory(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new UnsafeCredentialPathError(`Refusing unsafe credential directory: ${dir}`);
  }
  assertOwned(stat, dir);
  if ((stat.mode & 0o077) !== 0) {
    throw new UnsafeCredentialPathError(`Refusing credential directory accessible by other users: ${dir}`);
  }
}

/** Atomically replaces a user-secret file through a same-directory 0600 temp file. */
export function writePrivateFileAtomic(file: string, contents: string): void {
  const dir = path.dirname(file);
  ensurePrivateDirectory(dir);
  if (fs.existsSync(file)) assertSafeExistingFile(file);

  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, contents, { encoding: 'utf8' });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
    // Best-effort directory sync makes the rename durable on platforms that
    // allow directories to be opened as file descriptors.
    try {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {}
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function writeFile(file: string, data: CredentialsFile): void {
  writePrivateFileAtomic(file, JSON.stringify(data, null, 2));
}

/**
 * Build a credential store bound to one path. Binding the path once avoids a
 * HOME change halfway through an operation and lets tests use a unique root
 * without touching the operator's default credentials.
 */
export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const file = options.filePath ?? credentialsPath(options.homeDir);

  return {
    credentialsPath: () => file,

    getCredential(server: string): StoredCredential | null {
      const data = readFile(file);
      return data.servers[normalizeServerUrl(server)] || null;
    },

    setCredential(server: string, credential: StoredCredential): void {
      const data = readFile(file);
      data.servers[normalizeServerUrl(server)] = credential;
      writeFile(file, data);
    },

    removeCredential(server: string): void {
      const data = readFile(file);
      delete data.servers[normalizeServerUrl(server)];
      writeFile(file, data);
    },

    listServers(): string[] {
      return Object.keys(readFile(file).servers);
    },
  };
}

// Keep the CLI-facing helpers source-compatible while ensuring every default
// operation resolves the home directory at call time.
export function getCredential(server: string): StoredCredential | null {
  return createCredentialStore().getCredential(server);
}

export function setCredential(server: string, credential: StoredCredential): void {
  createCredentialStore().setCredential(server, credential);
}

export function removeCredential(server: string): void {
  createCredentialStore().removeCredential(server);
}

export function listServers(): string[] {
  return createCredentialStore().listServers();
}
