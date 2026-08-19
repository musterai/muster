import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type PackageManifest = {
  engines?: { node?: string };
  devDependencies?: { '@types/node'?: string };
  overrides?: Record<string, unknown>;
};

function read(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), name), 'utf8');
}

describe('Node.js runtime support policy', () => {
  it('keeps the package contract and lockfile engine in sync', () => {
    const manifest = JSON.parse(read('package.json')) as PackageManifest;
    const lock = JSON.parse(read('package-lock.json')) as {
      packages?: { '': { engines?: { node?: string } } };
    };

    expect(manifest.engines?.node).toBe('>=22.13.0');
    expect(lock.packages?.[''].engines?.node).toBe(manifest.engines?.node);
    expect(manifest.devDependencies?.['@types/node']).toBe('^22.13.0');
    expect(manifest.overrides?.['@hono/node-server']).toBeUndefined();
  });

  it('keeps the resolved MCP server dependency on the maintained release', () => {
    const lock = read('package-lock.json');
    expect(lock).toContain('node_modules/@hono/node-server');
    expect(lock).toContain('node-server-2.1.1.tgz');
    expect(lock).not.toContain('node-server-1.19.15.tgz');
    expect(lock).not.toContain('node_modules/@modelcontextprotocol/sdk/node_modules/@hono/node-server');
  });

  it('keeps CI on both supported majors with strict engine checks', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toMatch(/node-version:\s*\[22, 24\]/);
    expect(workflow).toContain('npm ci --engine-strict');
  });

  it('keeps the production image and policy documentation aligned', () => {
    const dockerfile = read('Dockerfile');
    const policy = read('docs/runtime-support.md');
    expect(dockerfile).toContain('FROM node:24.18.1-alpine3.23 AS builder');
    expect(dockerfile).toContain('FROM node:24.18.1-alpine3.23 AS runner');
    expect(policy).toContain('minimum of\nNode.js **22.13.0**');
    expect(policy).toContain('Node.js **24.18.1**');
    expect(policy).toContain('Node 18 and Node 20 are end-of-life');
  });
});
