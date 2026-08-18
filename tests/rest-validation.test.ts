import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { errorHandler } from '../src/api/middleware/error-handler.js';
import { validateRequest } from '../src/api/middleware/validate.js';
import {
  cardCreateSchema,
  cardIdParamsSchema,
  deviceLookupQuerySchema,
  oauthTokenSchema,
  projectCreateSchema,
  projectIdParamsSchema,
} from '../src/api/schemas.js';

describe('REST request validation', () => {
  let server: ReturnType<typeof express.application.listen> | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    });
  });

  async function start(build: (app: express.Express) => void): Promise<string> {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use(express.urlencoded({ extended: false, limit: '1mb' }));
    build(app);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve);
      server?.once('error', reject);
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('returns a stable structured error for malformed IDs, enums, dates, and unknown keys', async () => {
    const baseUrl = await start(app => {
      app.post('/projects/:projectId/cards', ...validateRequest({ body: cardCreateSchema, params: projectIdParamsSchema }), (_req, res) => {
        res.status(201).json({ ok: true });
      });
    });

    const res = await fetch(`${baseUrl}/projects/not%21valid/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Card',
        priority: 'muster_pat_secret_value',
        due_date: '2025-02-30',
        unknown_attacker_canary: true,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'Request validation failed', code: 'VALIDATION_ERROR' });
    expect(body.details.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['priority'] }),
      expect.objectContaining({ path: ['due_date'] }),
      expect.objectContaining({ code: 'unrecognized_keys' }),
    ]));
    expect(JSON.stringify(body)).not.toContain('2025-02-30');
    expect(JSON.stringify(body)).not.toContain('muster_pat_secret_value');
    expect(JSON.stringify(body)).not.toContain('unknown_attacker_canary');
    expect(body.details.issues.every((issue: Record<string, unknown>) => !('message' in issue))).toBe(true);

    const malformedId = await fetch(`${baseUrl}/projects/not%21valid/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Card' }),
    });
    expect(malformedId.status).toBe(400);
    const malformedIdBody = await malformedId.json();
    expect(malformedIdBody.details.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['projectId'] }),
    ]));
  });

  it('rejects oversized strings and arrays before the handler runs', async () => {
    let called = false;
    const baseUrl = await start(app => {
      app.post('/cards/:id', ...validateRequest({ body: cardCreateSchema, params: cardIdParamsSchema }), (_req, res) => {
        called = true;
        res.json({ ok: true });
      });
    });

    const res = await fetch(`${baseUrl}/cards/card-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(201), labels: Array.from({ length: 101 }, (_, i) => `label-${i}`) }),
    });

    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it('rejects unexpected input on a no-body endpoint and accepts an empty request', async () => {
    let calls = 0;
    const baseUrl = await start(app => {
      app.post('/logout', ...validateRequest(), (_req, res) => {
        calls += 1;
        res.status(204).end();
      });
    });

    const empty = await fetch(`${baseUrl}/logout`, { method: 'POST' });
    expect(empty.status).toBe(204);

    const unexpected = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unexpected: true }),
    });
    expect(unexpected.status).toBe(400);
    expect(calls).toBe(1);
  });

  it('accepts OAuth form bodies while rejecting extra fields and does not echo token values', async () => {
    let acceptedBody: unknown;
    const baseUrl = await start(app => {
      app.post('/oauth/token', ...validateRequest({ body: oauthTokenSchema }), (req, res) => {
        acceptedBody = req.body;
        res.status(200).json({ ok: true });
      });
    });

    const valid = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'device-secret-value',
      }),
    });
    expect(valid.status).toBe(200);
    expect(acceptedBody).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'device-secret-value',
    });

    const invalid = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'device-secret-value',
        access_token: 'must-not-appear',
      }),
    });
    expect(invalid.status).toBe(400);
    const body = await invalid.text();
    expect(body).toContain('VALIDATION_ERROR');
    expect(body).not.toContain('device-secret-value');
    expect(body).not.toContain('must-not-appear');
  });

  it('validates OAuth query variants and preserves parsed numeric/string request values', async () => {
    const baseUrl = await start(app => {
      app.get('/oauth/device/lookup', ...validateRequest({ query: deviceLookupQuerySchema }), (req, res) => {
        res.json({ user_code: req.query.user_code });
      });
      app.post('/projects', ...validateRequest({ body: projectCreateSchema }), (_req, res) => res.status(201).json({ ok: true }));
    });

    const valid = await fetch(`${baseUrl}/oauth/device/lookup?user_code=abc-123`);
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ user_code: 'abc-123' });

    const invalid = await fetch(`${baseUrl}/oauth/device/lookup?user_code=${encodeURIComponent('x'.repeat(121))}`);
    expect(invalid.status).toBe(400);
  });

  it('maps malformed and oversized parser input to redacted 400/413 responses without logging the raw body', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const baseUrl = await start(app => {
        app.post('/parser-probe', (_req, res) => res.status(201).json({ ok: true }));
      });

      const malformedCanary = 'muster-parser-raw-body-canary';
      const malformed = await fetch(`${baseUrl}/parser-probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{\"secret\":\"${malformedCanary}\"`,
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({
        error: 'Invalid request body',
        code: 'INVALID_REQUEST_BODY',
      });

      const oversizedCanary = 'muster-parser-too-large-canary';
      const oversized = await fetch(`${baseUrl}/parser-probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: oversizedCanary.repeat(300_000) }),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual({
        error: 'Request body too large',
        code: 'REQUEST_BODY_TOO_LARGE',
      });

      const logs = errorSpy.mock.calls.flat().join(' ');
      expect(logs).not.toContain(malformedCanary);
      expect(logs).not.toContain(oversizedCanary);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
