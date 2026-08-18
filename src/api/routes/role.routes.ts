// File: src/api/routes/role.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { RoleService } from '../../services/role.service.js';
import { AuditService } from '../../services/audit.service.js';
import { OPEN_AUTH_CONTEXT } from '../../shared/auth-context.js';
import { assertPermissionsGrantable } from '../../shared/permission-enforcer.js';
import { validateRequest } from '../middleware/validate.js';
import { idParamsSchema, roleCloneSchema, roleCreateSchema, roleIdParamsSchema, roleUpdateSchema, workspaceIdParamsSchema } from '../schemas.js';

export function createRoleRouter(roleService: RoleService, auditService: AuditService): Router {
  const router = Router();

  router.get('/workspaces/:workspaceId/roles', ...validateRequest({ params: workspaceIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const roles = await roleService.list(req.params.workspaceId);
      res.json(roles);
    } catch (err) {
      next(err);
    }
  });

  router.get('/roles/:id', ...validateRequest({ params: roleIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = await roleService.getById(req.params.id);
      if (!role) return res.status(404).json({ error: 'Role not found' });
      res.json(role);
    } catch (err) {
      next(err);
    }
  });

  router.post('/workspaces/:workspaceId/roles', ...validateRequest({ body: roleCreateSchema, params: workspaceIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req.authContext || OPEN_AUTH_CONTEXT;
      assertPermissionsGrantable(auth, req.body.permissions || []);
      const role = await roleService.create({ ...req.body, workspace_id: req.params.workspaceId });
      await auditService.logAs(auth, {
        workspace_id: req.params.workspaceId,
        action: 'role.create',
        target_type: 'role',
        target_id: role.id,
        payload: { key: role.key, name: role.name, permissions: role.permissions },
        ip: req.ip,
      });
      res.status(201).json(role);
    } catch (err) {
      next(err);
    }
  });

  router.put('/roles/:id', ...validateRequest({ body: roleUpdateSchema, params: roleIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req.authContext || OPEN_AUTH_CONTEXT;
      if (req.body.permissions) assertPermissionsGrantable(auth, req.body.permissions);
      const role = await roleService.update(req.params.id, req.body);
      await auditService.logAs(auth, {
        workspace_id: role.workspace_id,
        action: 'role.update',
        target_type: 'role',
        target_id: role.id,
        payload: { name: role.name, permissions: role.permissions },
        ip: req.ip,
      });
      res.json(role);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/roles/:id', ...validateRequest({ params: roleIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = await roleService.getById(req.params.id);
      await roleService.delete(req.params.id);
      await auditService.logAs(req.authContext, {
        workspace_id: role?.workspace_id || null,
        action: 'role.delete',
        target_type: 'role',
        target_id: req.params.id,
        payload: role ? { key: role.key, name: role.name } : undefined,
        ip: req.ip,
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.post('/roles/:id/clone', ...validateRequest({ body: roleCloneSchema, params: roleIdParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = await roleService.clone(req.params.id, req.body.new_key, req.body.new_name);
      await auditService.logAs(req.authContext, {
        workspace_id: role.workspace_id,
        action: 'role.clone',
        target_type: 'role',
        target_id: role.id,
        payload: { from: req.params.id, key: role.key, name: role.name },
        ip: req.ip,
      });
      res.status(201).json(role);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
