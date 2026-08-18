// File: src/api/routes/user.routes.ts
//
// Read-only workspace member listing (MUS-32). Powers the agent roster's
// operator lookup and the activity feed / assignee pickers; the full
// member-management surface (invite, remove, change role) is MUS-26.

import { Router, Request, Response, NextFunction } from 'express';
import { DatabaseAdapter } from '../../db/adapter.js';
import { UserService } from '../../services/user.service.js';
import { RoleService } from '../../services/role.service.js';
import { AuditService } from '../../services/audit.service.js';
import { OPEN_AUTH_CONTEXT } from '../../shared/auth-context.js';
import { assertPermissionsGrantable, PermissionDeniedError } from '../../shared/permission-enforcer.js';
import { validateRequest } from '../middleware/validate.js';
import { memberRoleSchema, workspaceMemberParamsSchema } from '../schemas.js';
import { config } from '../../config/index.js';

function requireWorkspacePathScope(req: Request): void {
  if (config.auth.mode === 'open') return;
  const auth = req.authContext;
  if (!auth?.principal || !auth.is_workspace_member || auth.workspace_id !== req.params.workspaceId) {
    throw new PermissionDeniedError('workspace.read', auth?.role_name || null);
  }
}

export function createUserRouter(db: DatabaseAdapter, userService: UserService, roleService: RoleService, auditService: AuditService): Router {
  const router = Router();

  router.get('/users', ...validateRequest(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authWorkspaceId = req.authContext?.workspace_id;
      const wsRows = authWorkspaceId
        ? []
        : await db.query<{ id: string }>('SELECT id FROM workspace LIMIT 1');
      const workspaceId = authWorkspaceId || wsRows[0]?.id;
      if (!workspaceId) {
        res.json([]);
        return;
      }
      const members = await userService.listMembers(workspaceId);
      res.json(members);
    } catch (err) {
      next(err);
    }
  });

  router.put('/workspaces/:workspaceId/members/:userId', ...validateRequest({ body: memberRoleSchema, params: workspaceMemberParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireWorkspacePathScope(req);
      const targetRole = await roleService.getById(req.body.role_id);
      if (targetRole) {
        assertPermissionsGrantable(req.authContext || OPEN_AUTH_CONTEXT, targetRole.permissions);
      }
      await userService.changeMemberRole(req.params.workspaceId, req.params.userId, req.body.role_id);
      await auditService.logAs(req.authContext, {
        workspace_id: req.params.workspaceId,
        action: 'member.role_change',
        target_type: 'app_user',
        target_id: req.params.userId,
        payload: { role_id: req.body.role_id, role_name: targetRole?.name },
        ip: req.ip,
      });
      const members = await userService.listMembers(req.params.workspaceId);
      res.json(members.find(m => m.id === req.params.userId) || null);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/workspaces/:workspaceId/members/:userId', ...validateRequest({ params: workspaceMemberParamsSchema }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireWorkspacePathScope(req);
      await userService.removeMember(req.params.workspaceId, req.params.userId);
      await auditService.logAs(req.authContext, {
        workspace_id: req.params.workspaceId,
        action: 'member.remove',
        target_type: 'app_user',
        target_id: req.params.userId,
        ip: req.ip,
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
