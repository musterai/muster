// File: tests/public-routes.test.ts
//
// The public boundary is an exact inventory. These tests make accidental
// prefix-based exposure (for example a future /auth/admin route) visible.

import { describe, expect, it } from 'vitest';
import { isPublicRoute, PUBLIC_ROUTE_INVENTORY } from '../src/shared/public-routes.js';

describe('public route inventory', () => {
  it('lists only the approved bootstrap, health, and discovery endpoints', () => {
    expect(PUBLIC_ROUTE_INVENTORY.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/v1/health/live',
      'GET /api/v1/health/ready',
      'GET /api/v1/health',
      'GET /api/v1/auth/login',
      'GET /api/v1/auth/callback',
      'POST /api/v1/auth/logout',
      'GET /api/v1/auth/me',
      'POST /api/v1/auth/local',
      'POST /api/v1/oauth/device/code',
      'POST /api/v1/oauth/token',
      'POST /api/v1/oauth/register',
      'GET /api/v1/oauth/authorize',
      'GET /.well-known/oauth-protected-resource',
      'GET /.well-known/oauth-authorization-server',
    ]);
  });

  it('matches exact paths and methods while ignoring query strings', () => {
    expect(isPublicRoute('GET', '/api/v1/health/live?detail=1')).toBe(true);
    expect(isPublicRoute('GET', '/api/v1/health/ready')).toBe(true);
    expect(isPublicRoute('GET', '/api/v1/health?detail=1')).toBe(true);
    expect(isPublicRoute('GET', '/.well-known/oauth-authorization-server')).toBe(true);
    expect(isPublicRoute('POST', '/api/v1/oauth/register?client=1')).toBe(true);

    expect(isPublicRoute('GET', '/api/v1/health/details')).toBe(false);
    expect(isPublicRoute('POST', '/api/v1/health')).toBe(false);
    expect(isPublicRoute('GET', '/api/v1/auth/future')).toBe(false);
    expect(isPublicRoute('GET', '/api/v1/oauth/authorize/details')).toBe(false);
    expect(isPublicRoute('POST', '/api/v1/oauth/authorize')).toBe(false);
    expect(isPublicRoute('GET', '/api/v1/projects')).toBe(false);
  });
});
