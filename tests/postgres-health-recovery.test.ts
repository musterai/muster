import { expect, it, vi } from 'vitest';
import express from 'express';
import net, { type AddressInfo, type Socket } from 'node:net';
import { PostgresAdapter } from '../src/db/postgres-adapter.js';
import { createHealthRouter } from '../src/api/routes/health.routes.js';

it('bounds an unresponsive PostgreSQL handshake and recovers readiness without replacing the pool', async () => {
  const sockets = new Set<Socket>();
  let responsive = false;
  let accepted = 0;
  // This transport fixture speaks only the protocol messages needed by
  // SELECT 1. The first connection accepts TCP but never answers startup,
  // unlike ECONNREFUSED, which would fail immediately even without a timeout.
  const postgres = net.createServer(socket => {
    sockets.add(socket);
    accepted += 1;
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', () => {
      if (!responsive) return;
      // AuthenticationOk, ReadyForQuery (idle).
      socket.write(Buffer.from('5200000008000000005a0000000549', 'hex'));
      socket.on('data', data => {
        if (data[0] === 81) {
          // CommandComplete (SELECT 1), ReadyForQuery (idle).
          socket.write(Buffer.from('430000000d53454c4543542031005a0000000549', 'hex'));
        }
      });
    });
  });
  await new Promise<void>(resolve => postgres.listen(0, '127.0.0.1', resolve));
  const database = new PostgresAdapter(`postgres://test:test@127.0.0.1:${(postgres.address() as AddressInfo).port}/test?sslmode=disable`);
  const app = express();
  app.use('/api/v1', createHealthRouter(database));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const live = await fetch(`${origin}/api/v1/health/live`);
    expect(live.status).toBe(200);
    expect(accepted).toBe(0);

    const unavailable = await fetch(`${origin}/api/v1/health/ready`, { signal: AbortSignal.timeout(8000) });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: 'not_ready' });
    expect(accepted).toBe(1);
    // A driver timeout must dispose of the connection, not just race the HTTP
    // response against an abandoned promise that leaves a pool slot occupied.
    await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1000, interval: 10 });

    responsive = true;
    const recovered = await fetch(`${origin}/api/v1/health/ready`, { signal: AbortSignal.timeout(2000) });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ status: 'ready' });
    expect(accepted).toBe(2);
  } finally {
    for (const socket of sockets) socket.destroy();
    await database.close();
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>(resolve => server.close(() => resolve())),
      new Promise<void>(resolve => postgres.close(() => resolve())),
    ]);
  }
}, 12000);
