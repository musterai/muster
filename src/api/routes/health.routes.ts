// File: src/api/routes/health.routes.ts
import { Router, Request, Response } from 'express';
import { DatabaseAdapter } from '../../db/adapter.js';
import { validateRequest } from '../middleware/validate.js';

export function createHealthRouter(db: DatabaseAdapter): Router {
  const router = Router();
  const startTime = Date.now();

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
    } catch (err: any) {
      res.status(503).json({
        status: 'unhealthy',
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
