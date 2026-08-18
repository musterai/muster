import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
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
});
