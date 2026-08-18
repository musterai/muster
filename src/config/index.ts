import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

export type AuthMode = 'open' | 'enforced';

export interface ListenerConfig {
  /** The validated address passed to `app.listen()`. */
  host: string;
  /** Whether the address is a loopback address. */
  isLoopback: boolean;
  /** The effective request-authentication posture. */
  authMode: AuthMode;
  /** The explicitly requested mode, if one was supplied. */
  requestedAuthMode: AuthMode | null;
}

function validateHost(host: string): string {
  if (!host || /\s|\0/.test(host)) {
    throw new Error('MUSTER_HOST must be a non-empty hostname or IP address without whitespace');
  }

  // An IPv6 address is sometimes supplied in URL-style brackets. Node's
  // `listen()` API expects the bare address, so remove them before binding.
  if (host.startsWith('[') || host.endsWith(']')) {
    if (!(host.startsWith('[') && host.endsWith(']'))) {
      throw new Error(`Invalid MUSTER_HOST "${host}"`);
    }
    host = host.slice(1, -1);
  }

  if (!host || host.length > 253) {
    throw new Error(`Invalid MUSTER_HOST "${host}"`);
  }

  return host.toLowerCase();
}

/**
 * Normalize the supported loopback spellings to deterministic listen values.
 * In particular, `localhost` is mapped to IPv4 loopback so a default launch
 * cannot depend on the machine's hostname/DNS preference for IPv4 vs IPv6.
 */
export function normalizeListenHost(value?: string): string {
  // Preserve the documented zero-config default when an environment file
  // contains an explicitly empty MUSTER_HOST, while still rejecting a value
  // made only of whitespace as a likely configuration mistake.
  const raw = value === undefined || value === '' ? 'localhost' : value.trim();
  const candidate = validateHost(raw);

  if (candidate === 'localhost' || candidate === '127.0.0.1') {
    return '127.0.0.1';
  }
  if (candidate === '::1') {
    return '::1';
  }

  // IPv4-mapped IPv6 loopback is still loopback, but normalizing it avoids
  // platform-dependent dual-stack behaviour when it is supplied explicitly.
  if (candidate === '::ffff:127.0.0.1') {
    return '127.0.0.1';
  }

  return candidate;
}

export function isLoopbackHost(value?: string): boolean {
  const host = normalizeListenHost(value);
  return host === '127.0.0.1' || host === '::1';
}

/**
 * Resolve the listener address and authentication posture together. Keeping
 * this decision in one pure function prevents the socket and auth middleware
 * from drifting apart.
 *
 * A public/non-loopback address defaults to enforced auth. An explicit
 * `MUSTER_AUTH_MODE=open` with such an address is rejected before the server
 * opens its database or socket: silently starting in an unsafe posture is not
 * an acceptable recovery path.
 */
export function resolveListenerConfig(env: NodeJS.ProcessEnv = process.env): ListenerConfig {
  const host = normalizeListenHost(env.MUSTER_HOST);
  const isLoopback = isLoopbackHost(host);
  const rawMode = env.MUSTER_AUTH_MODE?.trim().toLowerCase();
  let requestedAuthMode: AuthMode | null = null;

  if (rawMode) {
    if (rawMode !== 'open' && rawMode !== 'enforced') {
      throw new Error(`MUSTER_AUTH_MODE must be "open" or "enforced", received "${env.MUSTER_AUTH_MODE}"`);
    }
    requestedAuthMode = rawMode;
  }

  if (!isLoopback && requestedAuthMode === 'open') {
    throw new Error(
      `Unsafe listener configuration: MUSTER_AUTH_MODE=open cannot bind non-loopback host "${host}". ` +
      'Set MUSTER_AUTH_MODE=enforced or bind to loopback.'
    );
  }

  return {
    host,
    isLoopback,
    requestedAuthMode,
    authMode: requestedAuthMode ?? (isLoopback ? 'open' : 'enforced'),
  };
}

/** Render an address safely inside an HTTP URL for startup guidance. */
export function formatHostForUrl(host: string): string {
  return net.isIP(host) === 6 && !host.startsWith('[') ? `[${host}]` : host;
}

const listener = resolveListenerConfig();

function getDefaultDbDir(): string {
  if (process.env.MUSTER_DB_DIR) {
    return path.resolve(process.env.MUSTER_DB_DIR);
  }

  const cwd = process.cwd();
  const isInsideProject =
    (cwd === projectRoot || cwd.startsWith(projectRoot + path.sep)) &&
    !projectRoot.includes('node_modules');

  if (isInsideProject) {
    return path.join(projectRoot, 'data');
  }

  return path.join(os.homedir(), '.config', 'muster', 'db');
}

export function resolveDbPath(dbOption?: string): { path: string; url: string | null } {
  const dbType = (process.env.MUSTER_DB_TYPE || 'sqlite') as 'sqlite' | 'postgres';
  const initialUrl = process.env.MUSTER_DATABASE_URL || null;

  let targetOption = dbOption || process.env.MUSTER_DB_NAME;

  if (!targetOption) {
    if (process.env.MUSTER_DB_PATH) {
      const resolvedEnvPath = process.env.MUSTER_DB_PATH.startsWith('~/')
        ? path.join(os.homedir(), process.env.MUSTER_DB_PATH.slice(2))
        : process.env.MUSTER_DB_PATH;
      return { path: path.resolve(resolvedEnvPath), url: initialUrl };
    }
    return { path: path.join(getDefaultDbDir(), 'muster.db'), url: initialUrl };
  }

  if (targetOption.startsWith('~/')) {
    targetOption = path.join(os.homedir(), targetOption.slice(2));
  }

  const defaultDbPath = path.join(getDefaultDbDir(), 'muster.db');

  if (dbType === 'postgres') {
    if (!initialUrl) {
      return { path: defaultDbPath, url: null };
    }
    try {
      const parsedUrl = new URL(initialUrl);
      parsedUrl.pathname = `/${targetOption.replace(/^\//, '')}`;
      return { path: defaultDbPath, url: parsedUrl.toString() };
    } catch {
      return { path: defaultDbPath, url: initialUrl };
    }
  }

  if (path.isAbsolute(targetOption)) {
    return { path: path.resolve(targetOption), url: initialUrl };
  }

  if (targetOption.includes('/') || targetOption.includes('\\')) {
    return { path: path.resolve(process.cwd(), targetOption), url: initialUrl };
  }

  let fileName = targetOption;
  if (!/\.(db|sqlite|sqlite3)$/i.test(fileName)) {
    fileName = `${fileName}.db`;
  }

  return { path: path.join(getDefaultDbDir(), fileName), url: initialUrl };
}

const port = parseInt(process.env.MUSTER_PORT || '6878', 10);
const initialDb = resolveDbPath();

export const config = {
  port,
  host: listener.host,
  auth: {
    mode: listener.authMode,
  },
  db: {
    /** 'sqlite' (default, zero-config) or 'postgres' — see docs/deployment.md. */
    type: (process.env.MUSTER_DB_TYPE || 'sqlite') as 'sqlite' | 'postgres',
    path: initialDb.path,
    /** e.g. postgres://user:pass@host:5432/muster — required when type is 'postgres'. */
    url: initialDb.url,
  },
  attachmentsDir: process.env.MUSTER_ATTACHMENTS_DIR || path.join(projectRoot, 'data/attachments'),
  publicDir: path.join(projectRoot, 'public'),
  oidc: {
    issuer: process.env.MUSTER_OIDC_ISSUER || null,
    clientId: process.env.MUSTER_OIDC_CLIENT_ID || null,
    clientSecret: process.env.MUSTER_OIDC_CLIENT_SECRET || null,
    publicUrl: process.env.MUSTER_PUBLIC_URL || `http://localhost:${port}`,
    /** OIDC `sub` claim pinned in advance as the workspace owner, bypassing invitation admission. */
    bootstrapOwnerSubject: process.env.MUSTER_BOOTSTRAP_OWNER_SUBJECT || null,
  },
};

export function setDatabaseOverride(dbOption?: string): void {
  const resolved = resolveDbPath(dbOption);
  config.db.path = resolved.path;
  config.db.url = resolved.url;
}

/** True when enough OIDC configuration is present to enable the auth routes. */
export function isOidcConfigured(): boolean {
  return !!(config.oidc.issuer && config.oidc.clientId && config.oidc.clientSecret);
}
