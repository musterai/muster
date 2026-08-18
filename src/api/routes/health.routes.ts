// File: src/api/routes/health.routes.ts
import { Router, Request, Response } from 'express';
import { DatabaseAdapter } from '../../db/adapter.js';
import { validateRequest } from '../middleware/validate.js';

export function createHealthRouter(db: DatabaseAdapter): Router {
  const router = Router();

  // Liveness deliberately does not touch the database or expose workspace
  // metadata: an orchestrator can distinguish a running process from a ready
  // process without turning the probe into an information endpoint.
  router.get('/health/live', ...validateRequest(), (_req: Request, res: Response) => {
    res.status(200).json({ status: 'alive' });
  });

  const readiness = async (_req: Request, res: Response): Promise<void> => {
    try {
      await db.query('SELECT 1');
      res.status(200).json({ status: 'ready' });
    } catch {
      // Never return driver errors, paths, or connection details in a public
      // readiness response.
      res.status(503).json({ status: 'not_ready' });
    }
  };

  router.get('/health/ready', ...validateRequest(), readiness);

  // Keep the legacy URL public only as a compatibility alias for the safe
  // readiness contract. It must never disclose version, uptime, database
  // driver/mode, paths, or timing to unauthenticated callers.
  router.get('/health', ...validateRequest(), readiness);

  return router;
}
