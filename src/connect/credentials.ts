// File: src/connect/credentials.ts
//
// `muster login` stores a bearer token at ~/.muster/credentials.json, mode
// 0600, keyed by server URL so one user can be connected to more than one
// server. Design doc §7.2 / §8.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/** Canonical form used as the lookup key — strips a trailing slash so "https://x.com" and "https://x.com/" collide. */
export function normalizeServerUrl(server: string): string {
  return server.trim().replace(/\/+$/, '');
}

function readFile(file: string): CredentialsFile {
  if (!fs.existsSync(file)) return { servers: {} };
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return { servers: parsed.servers || {} };
  } catch {
    return { servers: {} };
  }
}

/** Writes the file with mode 0600 regardless of umask or the file's prior mode. */
function writeFile(file: string, data: CredentialsFile): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
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
