// File: tests/connect-proxy.test.ts
//
// MUS-27 acceptance criteria:
// - a local request without the loopback token is refused
// - the SSE stream is not buffered — chunks arrive as the upstream writes them
// - a full request round-trips through the proxy with the upstream bearer
//   token attached and the local token stripped
// - upstream unreachable produces a visible, named error

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createConnectApp } from '../src/connect/proxy.js';

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof express.application.listen>; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('MUS-27: muster connect proxy', () => {
  const LOCAL_TOKEN = 'local-test-token';
  const UPSTREAM_TOKEN = 'muster_pat_abcd1234_deadbeef';

  let upstreamServer: ReturnType<typeof express.application.listen> | null = null;
  let upstreamUrl = '';
  let proxyServer: ReturnType<typeof express.application.listen> | null = null;
  let proxyUrl = '';

  afterEach(async () => {
    if (proxyServer) await new Promise<void>((resolve) => proxyServer!.close(() => resolve()));
    if (upstreamServer) await new Promise<void>((resolve) => upstreamServer!.close(() => resolve()));
    proxyServer = null;
    upstreamServer = null;
  });

  async function startProxy(targetUrl: string) {
    const app = createConnectApp({
      upstreamUrl: targetUrl,
      upstreamToken: UPSTREAM_TOKEN,
      localToken: LOCAL_TOKEN,
      publicDir: '/nonexistent-public-dir-for-tests',
    });
    const { server, baseUrl } = await listen(app);
    proxyServer = server;
    proxyUrl = baseUrl;
  }

  it('refuses a local /api request without the loopback token', async () => {
    const upstream = express();
    upstream.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));
    const up = await listen(upstream);
    upstreamServer = up.server;
    upstreamUrl = up.baseUrl;
    await startProxy(upstreamUrl);

    const res = await fetch(`${proxyUrl}/api/v1/health`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('accepts the loopback token via Authorization header and forwards the upstream bearer token', async () => {
    let receivedAuth: string | undefined;
    const upstream = express();
    upstream.get('/api/v1/whoami', (req, res) => {
      receivedAuth = req.headers.authorization;
      res.json({ ok: true });
    });
    const up = await listen(upstream);
    upstreamServer = up.server;
    upstreamUrl = up.baseUrl;
    await startProxy(upstreamUrl);

    const res = await fetch(`${proxyUrl}/api/v1/whoami`, {
      headers: { Authorization: `Bearer ${LOCAL_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The local token must never reach the upstream — only the stored PAT does.
    expect(receivedAuth).toBe(`Bearer ${UPSTREAM_TOKEN}`);
  });

  it('accepts the loopback token via ?local_token= for EventSource, which cannot set headers', async () => {
    let receivedUrl = '';
    const upstream = express();
    upstream.get('/api/v1/health', (req, res) => {
      receivedUrl = req.originalUrl;
      res.json({ status: 'ok' });
    });
    const up = await listen(upstream);
    upstreamServer = up.server;
    upstreamUrl = up.baseUrl;
    await startProxy(upstreamUrl);

    const res = await fetch(`${proxyUrl}/api/v1/health?keep=yes&local_token=${LOCAL_TOKEN}`);
    expect(res.status).toBe(200);
    expect(receivedUrl).toBe('/api/v1/health?keep=yes');
  });

  it('fails closed when the loopback query credential is repeated', async () => {
    const upstream = express();
    upstream.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));
    const up = await listen(upstream);
    upstreamServer = up.server;
    await startProxy(up.baseUrl);

    const res = await fetch(`${proxyUrl}/api/v1/health?local_token=${LOCAL_TOKEN}&local_token=${LOCAL_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it('forwards only allowlisted request headers and injects only the intended bearer token', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const upstream = express();
    upstream.post('/api/v1/capture', (req, res) => {
      receivedHeaders = req.headers;
      req.resume();
      res.json({ ok: true });
    });
    const up = await listen(upstream);
    upstreamServer = up.server;
    await startProxy(up.baseUrl);

    const res = await fetch(`${proxyUrl}/api/v1/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOCAL_TOKEN}`,
        Cookie: 'muster_session=local-cookie',
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.8',
        'Proxy-Authorization': 'Basic should-not-cross',
        'X-Local-Secret': 'should-not-cross',
      },
      body: JSON.stringify({ ok: true }),
    });

    expect(res.status).toBe(200);
    expect(receivedHeaders.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
    expect(receivedHeaders['content-type']).toBe('application/json');
    expect(receivedHeaders.cookie).toBeUndefined();
    expect(receivedHeaders['x-forwarded-for']).toBeUndefined();
    expect(receivedHeaders['proxy-authorization']).toBeUndefined();
    expect(receivedHeaders['x-local-secret']).toBeUndefined();
  });

  it('does not reflect upstream cookies, redirects, or arbitrary headers onto loopback', async () => {
    const upstream = express();
    upstream.get('/api/v1/redirect', (_req, res) => {
      res.status(302)
        .set('Set-Cookie', 'remote_session=secret; Secure; HttpOnly')
        .set('Location', 'https://evil.example/collect')
        .set('X-Upstream-Secret', 'not-for-loopback')
        .end();
    });
    const up = await listen(upstream);
    upstreamServer = up.server;
    await startProxy(up.baseUrl);

    const res = await fetch(`${proxyUrl}/api/v1/redirect`, {
      redirect: 'manual',
      headers: { Authorization: `Bearer ${LOCAL_TOKEN}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-upstream-secret')).toBeNull();
  });

  it('streams an SSE response without buffering — chunks arrive as the upstream writes them, not all at once at the end', async () => {
    const upstream = express();
    upstream.get('/api/v1/stream', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();
      let n = 0;
      const interval = setInterval(() => {
        n++;
        res.write(`data: chunk-${n}\n\n`);
        if (n === 3) {
          clearInterval(interval);
          res.end();
        }
      }, 60);
    });
    const up = await listen(upstream);
    upstreamServer = up.server;
    upstreamUrl = up.baseUrl;
    await startProxy(upstreamUrl);

    const res = await fetch(`${proxyUrl}/api/v1/stream`, {
      headers: { Authorization: `Bearer ${LOCAL_TOKEN}` },
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const chunkTimestamps: number[] = [];
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkTimestamps.push(Date.now());
      full += decoder.decode(value, { stream: true });
    }

    expect(full).toContain('chunk-1');
    expect(full).toContain('chunk-2');
    expect(full).toContain('chunk-3');
    // A buffering proxy would deliver everything in one chunk once the
    // upstream finally closes the connection — i.e. a single read. Getting
    // more than one read means bytes crossed the proxy as they were written.
    expect(chunkTimestamps.length).toBeGreaterThan(1);
  });

  it('returns a named, visible error when the upstream is unreachable', async () => {
    // Nothing listens on this port.
    await startProxy('http://127.0.0.1:1');

    const res = await fetch(`${proxyUrl}/api/v1/health`, {
      headers: { Authorization: `Bearer ${LOCAL_TOKEN}` },
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('upstream_unreachable');
    expect(body.message).toContain('http://127.0.0.1:1');
  });

  it('closes the upstream SSE connection when the local subscriber disconnects', async () => {
    const upstream = express();
    let closed = false;
    upstream.get('/api/v1/stream', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: connected\n\n');
      res.once('close', () => { closed = true; });
    });
    const up = await listen(upstream);
    upstreamServer = up.server;
    await startProxy(up.baseUrl);
    const controller = new AbortController();
    const response = await fetch(`${proxyUrl}/api/v1/stream`, {
      headers: { Authorization: `Bearer ${LOCAL_TOKEN}` }, signal: controller.signal,
    });
    await response.body!.getReader().read();
    controller.abort();
    await expect.poll(() => closed, { timeout: 2000 }).toBe(true);
  });

  it('forwards SSE headers immediately even when the first event has not arrived', async () => {
    const upstream = express();
    upstream.get('/api/v1/stream', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
    });
    const up = await listen(upstream);
    upstreamServer = up.server;
    await startProxy(up.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(`${proxyUrl}/api/v1/stream`, {
        headers: { Authorization: `Bearer ${LOCAL_TOKEN}` }, signal: controller.signal,
      });
      expect(response.status).toBe(200);
    } finally { clearTimeout(timeout); controller.abort(); }
  });
});
