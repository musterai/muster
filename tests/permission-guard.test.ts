// File: tests/permission-guard.test.ts
//
// Regression test: permissionGuard is mounted on the nested `v1` Express
// router (v1.use(permissionGuard)), so req.path inside it comes back
// relative to that mount point (e.g. "/projects", not "/api/v1/projects").
// Every pattern in REST_ROUTE_PERMISSIONS is anchored on the full
// "/api/v1/..." prefix, so matching against req.path silently fails every
// pattern — GET requests fall through to "unmapped GET is allowed" (masking
// the bug for reads) but every mutation is default-denied in enforced mode,
// regardless of the caller's actual permissions.
//
// permissionGuard must match against req.originalUrl (stable regardless of
// router nesting), not req.path.

import { describe, it, expect } from 'vitest';
import { Request, Response } from 'express';
import { permissionGuard } from '../src/api/middleware/permission-guard.js';
import { AuthContext } from '../src/shared/auth-context.js';
import { config } from '../src/config/index.js';

function makeReq(originalUrl: string, path: string, method: string, auth: AuthContext): Request {
  return { originalUrl, path, method, authContext: auth } as unknown as Request;
}

function makeRes(): Response {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return res as Response;
}

describe('MUS-22 regression: permissionGuard must use the full request path', () => {
  it('allows a permitted mutation when req.path is mount-relative but req.originalUrl carries the full prefix', () => {
    (config.auth as any).mode = 'enforced';
    try {
      const auth: AuthContext = {
        principal: { kind: 'user', id: 'u1' },
        workspace_id: 'ws1',
        is_workspace_member: true,
        permissions: ['project.create'],
        is_operator_override: false,
        role_name: 'owner',
      };

      // Simulates the real Express nesting: originalUrl has the full path,
      // path is relative to the v1 router's mount point.
      const req = makeReq('/api/v1/projects', '/projects', 'POST', auth);
      const res = makeRes();
      let calledNext = false;

      permissionGuard(req, res, () => { calledNext = true; });

      expect(calledNext).toBe(true);
      expect((res as any).statusCode).toBe(200);
    } finally {
      (config.auth as any).mode = 'open';
    }
  });

  it('still refuses a mutation the caller lacks permission for', () => {
    (config.auth as any).mode = 'enforced';
    try {
      const auth: AuthContext = {
        principal: { kind: 'user', id: 'u2' },
        workspace_id: 'ws1',
        is_workspace_member: true,
        permissions: [],
        is_operator_override: false,
        role_name: 'observer',
      };

      const req = makeReq('/api/v1/projects', '/projects', 'POST', auth);
      const res = makeRes();
      let calledNext = false;

      permissionGuard(req, res, () => { calledNext = true; });

      expect(calledNext).toBe(false);
      expect((res as any).statusCode).toBe(403);
    } finally {
      (config.auth as any).mode = 'open';
    }
  });

  it('exempts /auth/ routes using the full path, not the mount-relative one', () => {
    (config.auth as any).mode = 'enforced';
    try {
      const auth: AuthContext = {
        principal: null,
        workspace_id: null,
        is_workspace_member: false,
        permissions: [],
        is_operator_override: false,
        role_name: null,
      };

      const req = makeReq('/api/v1/auth/login', '/auth/login', 'GET', auth);
      const res = makeRes();
      let calledNext = false;

      permissionGuard(req, res, () => { calledNext = true; });

      expect(calledNext).toBe(true);
    } finally {
      (config.auth as any).mode = 'open';
    }
  });

  it('refuses a zero-permission, unadmitted principal on a mapped GET', () => {
    (config.auth as any).mode = 'enforced';
    try {
      const auth: AuthContext = {
        principal: { kind: 'user', id: 'unadmitted' },
        workspace_id: 'ws1',
        is_workspace_member: false,
        permissions: [],
        is_operator_override: false,
        role_name: null,
      };
      const req = makeReq('/api/v1/projects', '/projects', 'GET', auth);
      const res = makeRes();
      let calledNext = false;

      permissionGuard(req, res, () => { calledNext = true; });

      expect(calledNext).toBe(false);
      expect((res as any).statusCode).toBe(403);
      expect((res as any).body.required_permission).toBe('workspace.read');
    } finally {
      (config.auth as any).mode = 'open';
    }
  });

  it('refuses an unmapped GET even for a workspace admin', () => {
    (config.auth as any).mode = 'enforced';
    try {
      const auth: AuthContext = {
        principal: { kind: 'user', id: 'owner' },
        workspace_id: 'ws1',
        is_workspace_member: true,
        permissions: ['workspace.admin'],
        is_operator_override: true,
        role_name: 'owner',
      };
      const req = makeReq('/api/v1/not-mapped', '/not-mapped', 'GET', auth);
      const res = makeRes();
      let calledNext = false;

      permissionGuard(req, res, () => { calledNext = true; });

      expect(calledNext).toBe(false);
      expect((res as any).statusCode).toBe(403);
      expect((res as any).body.required_permission).toContain('unmapped');
    } finally {
      (config.auth as any).mode = 'open';
    }
  });
});
