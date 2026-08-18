import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHealthRouter } from '../src/api/routes/health.routes.js';

function probeDb(shouldFail = false) {
  return {
    query: async () => {
      if (shouldFail) throw new Error('secret database path must not escape');
      return [{ one: 1 }];
    },
  } as any;
}

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

/**
 * This is intentionally not a partial `.dockerignore` interpreter. Docker
 * supports shell globs, `**`, negation, and last-match-wins ordering; a
 * hand-rolled subset can certify an unsafe context. The checked-in deployment
 * needs no exception rules, so fail closed: the three protected inputs must
 * be excluded explicitly and no non-comment negation is permitted at all.
 */
function hasFailClosedSecretContextRules(dockerignore: string): boolean {
  const rules = dockerignore
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
  const requiredExclusions = ['.env', '.env.*', 'secrets/'];

  return requiredExclusions.every(rule => rules.includes(rule))
    && rules.every(rule => !rule.startsWith('!'));
}

describe('production deployment safety', () => {
  it('keeps liveness independent and readiness metadata-free', async () => {
    const app = express();
    app.use('/api/v1', createHealthRouter(probeDb(true)));
    const { server, url } = await listen(app);
    try {
      const live = await fetch(`${url}/api/v1/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: 'alive' });

      const ready = await fetch(`${url}/api/v1/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: 'not_ready' });

      // Compatibility does not make the old telemetry endpoint public again.
      const legacy = await fetch(`${url}/api/v1/health`);
      expect(legacy.status).toBe(503);
      expect(await legacy.json()).toEqual({ status: 'not_ready' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('ignores spoofed forwarded headers when no proxy is trusted', async () => {
    const app = express();
    app.set('trust proxy', []);
    app.get('/probe', (req, res) => res.json({ ip: req.ip, protocol: req.protocol }));
    const { server, url } = await listen(app);
    try {
      const response = await fetch(`${url}/probe`, {
        headers: { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https' },
      });
      const body = await response.json() as { ip: string; protocol: string };
      expect(body.protocol).toBe('http');
      expect(body.ip).not.toBe('203.0.113.9');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses forwarded headers only from the explicitly trusted loopback proxy', async () => {
    const app = express();
    app.set('trust proxy', ['127.0.0.1']);
    app.get('/probe', (req, res) => res.json({ ip: req.ip, protocol: req.protocol }));
    const { server, url } = await listen(app);
    try {
      const response = await fetch(`${url}/probe`, {
        headers: { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https' },
      });
      expect(await response.json()).toEqual({ ip: '203.0.113.9', protocol: 'https' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('pins the Compose proxy topology, origin derivation, and maintained container bases', () => {
    const root = process.cwd();
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const caddyfile = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8');
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const deploymentDocs = fs.readFileSync(path.join(root, 'docs/deployment.md'), 'utf8');
    const serverBlock = compose.slice(compose.indexOf('  muster-server:'), compose.indexOf('  muster-proxy:'));
    const proxyBlock = compose.slice(compose.indexOf('  muster-proxy:'), compose.indexOf('\nvolumes:'));

    expect(serverBlock).toContain('MUSTER_TRUST_PROXY=172.30.0.2');
    expect(serverBlock).toContain('MUSTER_PUBLIC_URL=https://${MUSTER_PUBLIC_HOST:?Set the public DNS hostname}');
    expect(serverBlock).toContain('ipv4_address: 172.30.0.3');
    expect(serverBlock).not.toContain('ports:');
    expect(serverBlock).not.toContain('MUSTER_TRUST_PROXY=127.0.0.1');

    expect(proxyBlock).toContain('image: caddy:2.11.4-alpine');
    expect(proxyBlock).toContain('ipv4_address: 172.30.0.2');
    expect(proxyBlock).toContain('${MUSTER_PROXY_BIND_ADDRESS:-127.0.0.1}:443:443');
    expect(compose).toContain('internal: true');
    expect(compose).toContain('subnet: 172.30.0.0/29');
    expect(caddyfile).toContain('reverse_proxy muster-backend:6878');
    expect(caddyfile).toContain('header_up -X-Forwarded-For');
    expect(caddyfile).toContain('header_up X-Forwarded-For {remote_host}');

    expect(dockerfile).toContain('FROM node:24.18.1-alpine3.23 AS builder');
    expect(dockerfile).toContain('FROM node:24.18.1-alpine3.23 AS runner');
    expect(dockerfile).not.toContain('FROM node:20-');
    expect(deploymentDocs).toMatch(/If it overlaps an existing\s+Docker network/);
    expect(deploymentDocs).toContain('Never solve an overlap by');
  });

  it('keeps the documented Compose OIDC secret outside the Docker build context', () => {
    const root = process.cwd();
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
    const deploymentDocs = fs.readFileSync(path.join(root, 'docs/deployment.md'), 'utf8');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

    // The expression is scoped to the top-level Compose secret declaration,
    // rather than the similarly named service-level `secrets:` list.
    const secretFileMatch = compose.match(/^ {2}oidc_client_secret:\s*\n^ {4}file:\s*\.\/([^\s#]+)\s*$/m);
    expect(secretFileMatch?.[1]).toBe('secrets/oidc_client_secret');
    const secretSource = secretFileMatch![1];

    expect(hasFailClosedSecretContextRules(dockerignore)).toBe(true);
    // Docker's exception rules are glob-capable and last-match-wins. Do not
    // attempt to emulate them partially: every possible re-inclusion fails
    // closed, including the literal and wildcard variants of this secret.
    for (const reinclude of [
      `!${secretSource}`,
      '!secrets/*',
      '!secrets/**',
      '!.env',
    ]) {
      expect(hasFailClosedSecretContextRules(`${dockerignore}\n${reinclude}`)).toBe(false);
    }
    expect(deploymentDocs).toContain(`create \`${secretSource}\``);
    expect(deploymentDocs).toContain('excluded from the\nDocker build context');
    expect(readme).toContain(`\`${secretSource}\``);
  });
});
