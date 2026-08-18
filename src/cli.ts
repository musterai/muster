#!/usr/bin/env node
// File: src/cli.ts
//
// `muster <serve|connect|login|logout>` — design doc §8. `serve` is today's
// server (src/server.ts, unchanged); the rest are the local-client commands
// added by MUS-27.

import crypto from 'node:crypto';
import { startServer } from './server.js';
import { createConnectApp } from './connect/proxy.js';
import { getCredential, setCredential, normalizeServerUrl, writePrivateFileAtomic } from './connect/credentials.js';
import { whoAmI, listMyTokens, tokenPrefix, RemoteError, requestDeviceCode, pollForDeviceToken } from './connect/remote-client.js';
import { logoutCredential } from './connect/logout.js';
import { promptHidden } from './connect/prompt.js';

type Flags = Record<string, string | boolean>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) continue;
    const key = arg.replace(/^-+/, '');
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function runConnect(flags: Flags): Promise<void> {
  const server = typeof flags.server === 'string' ? normalizeServerUrl(flags.server) : null;
  if (!server) fail('muster connect requires --server <url>');

  const credential = getCredential(server!);
  if (!credential) fail(`No saved credentials for ${server}. Run "muster login --server ${server}" first.`);

  const port = typeof flags.port === 'string' ? parseInt(flags.port, 10) : 4200;
  const localToken = crypto.randomBytes(24).toString('hex');

  const app = createConnectApp({
    upstreamUrl: server!,
    upstreamToken: credential!.token,
    localToken,
  });

  const listenOnPort = (p: number) => {
    const httpServer = app.listen(p, '127.0.0.1', () => {
      const localUrl = `http://127.0.0.1:${p}`;
      const mcpConfig = {
        mcpServers: {
          muster: {
            url: `${localUrl}/mcp`,
            headers: { Authorization: `Bearer ${localToken}` },
          },
        },
      };

      console.log(`\n======================================================`);
      console.log(`  Muster connect — proxying to ${server}`);
      console.log(`======================================================`);
      console.log(`  • Web UI:    ${localUrl}`);
      console.log(`  • Local /mcp is protected by an ephemeral loopback credential.`);
      console.log(`======================================================\n`);

      if (typeof flags['write-config'] === 'string') {
        writePrivateFileAtomic(flags['write-config'] as string, JSON.stringify(mcpConfig, null, 2) + '\n');
        console.log(`Wrote MCP config to ${flags['write-config']}`);
      } else {
        console.log('Use --write-config <path> to create a private MCP configuration without printing its credential.');
      }
    });

    httpServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[muster connect] Port ${p} is in use. Trying port ${p + 1}...`);
        listenOnPort(p + 1);
      } else {
        console.error('[muster connect] Server error:', err);
        process.exit(1);
      }
    });

    const shutdown = () => {
      httpServer.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  };

  listenOnPort(port);
}

async function runLogin(flags: Flags): Promise<void> {
  const server = typeof flags.server === 'string' ? normalizeServerUrl(flags.server) : null;
  if (!server) fail('muster login requires --server <url>');

  let token: string | null = null;
  if (!token && flags.paste) {
    console.log(`Paste a personal access token minted from ${server}'s Tokens page.`);
    token = await promptHidden('Token: ');
  }
  if (!token) {
    // Default path: Device Authorization Grant (RFC 8628, MUS-28) — nothing
    // secret is ever typed into this terminal.
    let deviceCode;
    try {
      deviceCode = await requestDeviceCode(server!);
    } catch (err) {
      if (err instanceof RemoteError) fail(err.message);
      throw err;
    }

    console.log(`\nTo log in, visit:\n\n  ${deviceCode.verification_uri_complete}\n`);
    console.log(`Or go to ${deviceCode.verification_uri} and enter code: ${deviceCode.user_code}\n`);
    console.log('Waiting for approval...');

    try {
      token = await pollForDeviceToken(server!, deviceCode.device_code, deviceCode.interval, deviceCode.expires_in);
    } catch (err) {
      if (err instanceof RemoteError) fail(err.message);
      throw err;
    }
  }
  if (!token) fail('No token provided');

  let me;
  try {
    me = await whoAmI(server!, token!);
  } catch (err) {
    if (err instanceof RemoteError) fail(err.message);
    throw err;
  }
  if (!me.authenticated || !me.user) fail('That token was rejected by the server — check it was copied correctly and has not expired or been revoked.');

  let tokenId: string | null = null;
  try {
    const prefix = tokenPrefix(token!);
    if (prefix) {
      const tokens = await listMyTokens(server!, token!);
      tokenId = tokens.find(t => t.prefix === prefix && !t.revoked_at)?.id || null;
    }
  } catch {
    // Non-fatal — logout falls back to local-only removal if this lookup ever fails.
  }

  setCredential(server!, { token: token!, token_id: tokenId, created_at: new Date().toISOString() });
  console.log(`Logged in to ${server} as ${me.user.display_name}.`);
}

async function runLogout(flags: Flags): Promise<void> {
  const server = typeof flags.server === 'string' ? normalizeServerUrl(flags.server) : null;
  if (!server) fail('muster logout requires --server <url>');

  const result = await logoutCredential(server!, { localOnly: flags['local-only'] === true });
  if (result.status === 'logged_out' || result.status === 'already_revoked') {
    console.log(result.message);
    return;
  }
  if (result.status === 'local_only') {
    console.warn(result.message);
    return;
  }
  fail(result.message);
}

const ALLOWED_FLAGS: Record<string, string[]> = {
  serve: ['db', 'db-name', 'database', 'd', 'help', 'h'],
  connect: ['server', 'port', 'write-config', 'help', 'h'],
  login: ['server', 'paste', 'help', 'h'],
  logout: ['server', 'local-only', 'help', 'h'],
};

function validateFlags(subcommand: string, flags: Flags): void {
  const allowed = ALLOWED_FLAGS[subcommand] || [];
  for (const key of Object.keys(flags)) {
    if (!allowed.includes(key)) {
      const fullFlag = key.length === 1 ? `-${key}` : `--${key}`;
      const validList = allowed.map((k) => (k.length === 1 ? `-${k}` : `--${k}`)).join(', ');
      fail(`Unknown option "${fullFlag}" for "muster ${subcommand}". Valid options: ${validList}`);
    }
  }
}

async function main() {
  let [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand) {
    subcommand = 'serve';
  } else if (subcommand.startsWith('-')) {
    rest = [subcommand, ...rest];
    subcommand = 'serve';
  }

  const knownCommands = ['serve', 'connect', 'login', 'logout'];
  if (!knownCommands.includes(subcommand)) {
    fail(`Unknown command "${subcommand}". Expected one of: ${knownCommands.join(', ')}.`);
  }

  const flags = parseFlags(rest);
  validateFlags(subcommand, flags);

  if (flags.help || flags.h) {
    console.log(`\nUsage: muster <command> [options]\n`);
    console.log(`Commands:`);
    console.log(`  serve                      Start the workspace server (default)`);
    console.log(`  connect --server <url>     Proxy local MCP connection to remote server`);
    console.log(`  login --server <url>       Authenticate with remote server`);
    console.log(`  logout --server <url>      Log out of remote server\n`);
    console.log(`Options for serve:`);
    console.log(`  --db, -d <name|path>       Database name or file path (e.g. --db dev)\n`);
    process.exit(0);
  }

  if (subcommand === 'serve') {
    if (flags.db === true || flags['db-name'] === true || flags.database === true || flags.d === true) {
      fail('Database option requires a database name or file path (e.g. --db myproject)');
    }
    const dbOption = (flags.db || flags['db-name'] || flags.database || flags.d) as string | undefined;
    await startServer({ db: dbOption });
    return;
  }

  switch (subcommand) {
    case 'connect':
      await runConnect(flags);
      break;
    case 'login':
      await runLogin(flags);
      break;
    case 'logout':
      await runLogout(flags);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
