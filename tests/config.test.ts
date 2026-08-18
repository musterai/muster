import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  config,
  formatHostForUrl,
  isLoopbackHost,
  normalizeListenHost,
  resolveDbPath,
  resolveListenerConfig,
  resolveTrustedProxies,
  validateDeploymentConfig,
  setDatabaseOverride,
} from '../src/config/index.js';
import { listenApplication } from '../src/server.js';

describe('Database Configuration & Path Resolution', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.MUSTER_DB_NAME;
    delete process.env.MUSTER_DB_PATH;
    delete process.env.MUSTER_DB_TYPE;
    delete process.env.MUSTER_DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves default path when no option or env var is supplied', () => {
    const res = resolveDbPath();
    expect(res.path).toContain(path.join('data', 'muster.db'));
  });

  it('resolves MUSTER_DB_PATH when env var is set and no explicit option is passed', () => {
    process.env.MUSTER_DB_PATH = '/custom/env/muster.db';
    const res = resolveDbPath();
    expect(res.path).toBe('/custom/env/muster.db');
  });

  it('resolves simple database name into data/<name>.db', () => {
    const res = resolveDbPath('alpha');
    expect(res.path).toContain(path.join('data', 'alpha.db'));
  });

  it('preserves existing SQLite file extension for simple name', () => {
    const res = resolveDbPath('test.sqlite');
    expect(res.path).toContain(path.join('data', 'test.sqlite'));
  });

  it('resolves absolute path directly', () => {
    const res = resolveDbPath('/tmp/custom_test.db');
    expect(res.path).toBe('/tmp/custom_test.db');
  });

  it('resolves relative path containing path separators relative to cwd', () => {
    const res = resolveDbPath('./custom_folder/app.db');
    expect(res.path).toBe(path.resolve(process.cwd(), './custom_folder/app.db'));
  });

  it('overrides postgres database URL pathname when in postgres mode', () => {
    process.env.MUSTER_DB_TYPE = 'postgres';
    process.env.MUSTER_DATABASE_URL = 'postgres://admin:secret@localhost:5432/production_db';

    const res = resolveDbPath('staging_db');
    expect(res.url).toBe('postgres://admin:secret@localhost:5432/staging_db');
  });

  it('expands tilde paths (~/...) to user home directory', () => {
    const res = resolveDbPath('~/.config/muster/db/custom.db');
    expect(res.path).toBe(path.join(path.resolve(process.env.HOME || ''), '.config', 'muster', 'db', 'custom.db'));
  });

  it('respects MUSTER_DB_DIR environment variable for simple database names', () => {
    process.env.MUSTER_DB_DIR = '/tmp/muster_custom_dir';
    const res = resolveDbPath('my_custom_db');
    expect(res.path).toBe('/tmp/muster_custom_dir/my_custom_db.db');
  });

  it('uses ~/.config/muster/db when process.cwd is outside project root', () => {
    const originalCwd = process.cwd;
    try {
      process.cwd = () => '/tmp';
      const res = resolveDbPath();
      expect(res.path).toBe(path.join(path.resolve(process.env.HOME || ''), '.config', 'muster', 'db', 'muster.db'));
    } finally {
      process.cwd = originalCwd;
    }
  });

  it('setDatabaseOverride updates global config.db', () => {
    setDatabaseOverride('override_db');
    expect(config.db.path).toContain(path.join('data', 'override_db.db'));
  });
});

describe('Listener and authentication configuration', () => {
  it('defaults to IPv4 loopback with open authentication', () => {
    expect(resolveListenerConfig({})).toEqual({
      host: '127.0.0.1',
      isLoopback: true,
      authMode: 'open',
      requestedAuthMode: null,
    });
    expect(resolveListenerConfig({ MUSTER_HOST: '' }).host).toBe('127.0.0.1');
  });

  it.each(['localhost', '127.0.0.1', '::1', '[::1]'])('accepts loopback spelling %s', (host) => {
    const resolved = resolveListenerConfig({ MUSTER_HOST: host });
    expect(resolved.isLoopback).toBe(true);
    expect(resolved.authMode).toBe('open');
    expect(resolved.host).toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it('normalizes IPv4-mapped loopback and identifies only loopback addresses', () => {
    expect(normalizeListenHost('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(formatHostForUrl('::1')).toBe('[::1]');
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });

  it.each(['0.0.0.0', '::'])('defaults non-loopback bind %s to enforced auth', (host) => {
    const resolved = resolveListenerConfig({ MUSTER_HOST: host });
    expect(resolved.host).toBe(host);
    expect(resolved.isLoopback).toBe(false);
    expect(resolved.authMode).toBe('enforced');
  });

  it('rejects contradictory explicit open auth on a non-loopback bind', () => {
    expect(() => resolveListenerConfig({ MUSTER_HOST: '0.0.0.0', MUSTER_AUTH_MODE: 'open' }))
      .toThrow('MUSTER_AUTH_MODE=open cannot bind non-loopback host "0.0.0.0"');
    expect(() => resolveListenerConfig({ MUSTER_HOST: '::', MUSTER_AUTH_MODE: 'open' }))
      .toThrow('MUSTER_AUTH_MODE=open cannot bind non-loopback host "::"');
  });

  it('allows an explicit enforced mode on loopback and public binds', () => {
    expect(resolveListenerConfig({ MUSTER_HOST: 'localhost', MUSTER_AUTH_MODE: 'enforced' }).authMode)
      .toBe('enforced');
    expect(resolveListenerConfig({ MUSTER_HOST: '192.0.2.10', MUSTER_AUTH_MODE: 'enforced' }).authMode)
      .toBe('enforced');
  });

  it('validates enforced deployments before startup and supports secret files', () => {
    expect(() => validateDeploymentConfig({
      MUSTER_HOST: '0.0.0.0', MUSTER_AUTH_MODE: 'enforced', MUSTER_PUBLIC_URL: 'http://example.test',
      MUSTER_OIDC_ISSUER: 'https://id.example.test', MUSTER_OIDC_CLIENT_ID: 'muster', MUSTER_OIDC_CLIENT_SECRET: 'secret',
    })).toThrow('MUSTER_PUBLIC_URL must use https');
    expect(() => validateDeploymentConfig({ MUSTER_HOST: '0.0.0.0', MUSTER_AUTH_MODE: 'enforced' }))
      .toThrow('MUSTER_PUBLIC_URL is required');
    expect(() => validateDeploymentConfig({ MUSTER_HOST: '0.0.0.0', MUSTER_AUTH_MODE: 'enforced', MUSTER_PUBLIC_URL: 'https://muster.example.test' }))
      .toThrow('MUSTER_OIDC_ISSUER');
  });

  it('accepts only explicit proxy IPs and CIDRs', () => {
    expect(resolveTrustedProxies({ MUSTER_TRUST_PROXY: '127.0.0.1, ::1, 10.0.0.0/8' }))
      .toEqual(['127.0.0.1', '::1', '10.0.0.0/8']);
    expect(() => resolveTrustedProxies({ MUSTER_TRUST_PROXY: '0.0.0.0/33' })).toThrow('invalid CIDR');
    expect(() => resolveTrustedProxies({ MUSTER_TRUST_PROXY: 'proxy.internal' })).toThrow('invalid address');
  });

  it('rejects invalid auth modes and malformed host values', () => {
    expect(() => resolveListenerConfig({ MUSTER_AUTH_MODE: 'sometimes' }))
      .toThrow('MUSTER_AUTH_MODE must be "open" or "enforced"');
    expect(() => resolveListenerConfig({ MUSTER_HOST: '   ' }))
      .toThrow('MUSTER_HOST must be a non-empty hostname');
  });

  it('binds the production listener to the effective loopback address', async () => {
    const app = express();
    const listener = resolveListenerConfig({});
    const server = listenApplication(app, 0, listener.host);

    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});
