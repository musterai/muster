// File: src/api/routes/health.routes.ts
import { Router, Request, Response } from 'express';
import { DatabaseAdapter } from '../../db/adapter.js';
import { validateRequest } from '../middleware/validate.js';

export function createHealthRouter(db: DatabaseAdapter): Router {
  const router = Router();
  const startTime = Date.now();

  // Liveness deliberately does not touch the database or expose workspace
  // metadata: an orchestrator can distinguish a running process from a ready
  // process without turning the probe into an information endpoint.
  router.get('/health/live', ...validateRequest(), (_req: Request, res: Response) => {
    res.status(200).json({ status: 'alive' });
  });

  router.get('/health/ready', ...validateRequest(), async (_req: Request, res: Response) => {
    try {
      await db.query('SELECT 1');
      res.status(200).json({ status: 'ready' });
    } catch {
      // Never return driver errors, paths, or connection details in a public
      // readiness response.
      res.status(503).json({ status: 'not_ready' });
    }
  });

  router.get('/health', ...validateRequest(), async (_req: Request, res: Response) => {
    try {
      // Test DB query latency
      const t0 = Date.now();
      await db.query('SELECT 1');
      const latencyMs = Date.now() - t0;

      res.json({
        status: 'ok',
        version: '1.0.0',
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        timestamp: new Date().toISOString(),
        database: {
          status: 'connected',
          driver: 'better-sqlite3',
          mode: 'wal',
          latency_ms: latencyMs,
        },
      });
    } catch {
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
