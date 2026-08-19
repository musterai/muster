import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCleanArchitecture,
  inspectArchitecture,
  type ArchitectureViolationKind,
} from './support/architecture-inventory.js';

const temporaryProjects: string[] = [];

function fixture(
  files: Record<string, string>,
  compilerOptions: Record<string, unknown> = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-architecture-'));
  temporaryProjects.push(root);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      baseUrl: '.',
      ...compilerOptions,
    },
    include: ['src/**/*'],
  }));
  const completeFiles = {
    'src/application/composition.ts': 'export const composition = true;',
    'src/mcp/server.ts': 'export const mcp = true;',
    ...files,
  };
  for (const [file, content] of Object.entries(completeFiles)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function kinds(root: string): ArchitectureViolationKind[] {
  return inspectArchitecture({ projectRoot: root }).violations.map(violation => violation.kind);
}

describe('resolved architecture and construction inventory', () => {
  afterEach(() => {
    for (const root of temporaryProjects.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds the production graph to the exact root construction inventory', () => {
    const inventory = inspectArchitecture({ projectRoot: process.cwd() });
    expect(inventory.files.some(file => file.endsWith('.tsx'))).toBe(true);
    expect(inventory.rootConstructionNames).toEqual([
      'AgentService',
      'AuditService',
      'BoardService',
      'CardAccessPolicy',
      'CardLanePolicy',
      'CardService',
      'ColumnService',
      'CommentService',
      'DeviceGrantService',
      'DocumentService',
      'EventService',
      'InvitationService',
      'KBService',
      'McpOAuthService',
      'OidcService',
      'ProjectService',
      'RoleService',
      'SessionService',
      'TokenService',
      'UserService',
    ]);
    expect(() => assertCleanArchitecture(inventory)).not.toThrow();
  });

  it.each([
    ['static import', 'import { mcp } from "../mcp/server.js"; void mcp;', 'ts'],
    ['side-effect import', 'import "../mcp/server.js";', 'ts'],
    ['dynamic import', 'void import("../mcp/server.js");', 'ts'],
    ['require', 'require("../mcp/server.js");', 'ts'],
    ['tsx source', 'import { mcp } from "../mcp/server.js"; export const View = () => <div>{mcp}</div>;', 'tsx'],
  ])('rejects API to MCP through %s', (_name, source, extension) => {
    const root = fixture({ [`src/api/probe.${extension}`]: source });
    expect(kinds(root)).toContain('api-to-mcp');
  });

  it('resolves aliases and transitive barrels before checking transport direction', () => {
    const root = fixture({
      'src/api/probe.ts': 'import { mcp } from "@transport/barrel"; void mcp;',
      'src/transport/barrel.ts': 'export { mcp } from "../mcp/server.js";',
    }, {
      paths: { '@transport/*': ['src/transport/*'] },
    });
    expect(kinds(root)).toContain('api-to-mcp');
  });

  it('resolves constructor aliases and rejects service or policy construction outside the root', () => {
    const root = fixture({
      'src/services/audit.service.ts': 'export class AuditService {}',
      'src/api/probe.ts': [
        'import { AuditService as LocalAudit } from "../services/audit.service.js";',
        'new LocalAudit();',
      ].join('\n'),
    });
    const inventory = inspectArchitecture({ projectRoot: root });
    expect(inventory.constructions).toContainEqual({
      file: 'src/api/probe.ts',
      name: 'AuditService',
      line: 2,
    });
    expect(kinds(root)).toContain('construction-outside-root');
  });

  it.each([
    ['non-literal dynamic import', 'const target = "../mcp/server.js"; void import(target);'],
    ['non-literal require', 'const target = "../mcp/server.js"; require(target);'],
  ])('fails closed for %s', (_name, source) => {
    const root = fixture({ 'src/api/probe.ts': source });
    expect(kinds(root)).toContain('unknown-dependency');
  });

  it('fails closed on syntax errors and unresolved internal aliases', () => {
    const parseRoot = fixture({ 'src/api/probe.ts': 'export const broken = ;' });
    expect(kinds(parseRoot)).toContain('parse-error');

    const unresolvedRoot = fixture({
      'src/api/probe.ts': 'import "@internal/missing";',
    }, {
      paths: { '@internal/*': ['src/internal/*'] },
    });
    expect(kinds(unresolvedRoot)).toContain('unresolved-internal-dependency');
  });
});
