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

function guarded(root: string): boolean {
  const violations = kinds(root);
  return violations.includes('construction-outside-root')
    || violations.includes('unknown-construction');
}

describe('resolved architecture and construction inventory', () => {
  afterEach(() => {
    for (const root of temporaryProjects.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Resolving the full TypeScript graph can exceed Vitest's five-second
  // default on shared CI runners; this checks architecture, not scan speed.
  it('holds the production graph to the exact root construction inventory', () => {
    const inventory = inspectArchitecture({ projectRoot: process.cwd() });
    expect(inventory.files.some(file => file.endsWith('.tsx'))).toBe(true);
    expect(inventory.rootConstructionNames).toEqual([
      'AgentService',
      'AuditService',
      'BoardService',
      'CardAccessPolicy',
      'CardAssignmentOperations',
      'CardLanePolicy',
      'CardMoveOperations',
      'CardRecordQueries',
      'CardRelationOperations',
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
      'TransactionServiceFactory',
      'UserService',
    ]);
    expect(() => assertCleanArchitecture(inventory)).not.toThrow();
  }, 30_000);

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

  it.each([
    ['identifier alias', 'const load = require; load("../mcp/server.js");'],
    ['property alias', 'const loaders = { load: require }; loaders.load("../mcp/server.js");'],
  ])('resolves an aliased require through %s', (_name, source) => {
    const root = fixture({ 'src/api/probe.ts': source });
    expect(kinds(root)).toContain('api-to-mcp');
  });

  it('fails closed when an aliased require selector is not literal', () => {
    const root = fixture({
      'src/api/probe.ts': 'const load = require; const target = "../mcp/server.js"; load(target);',
    });
    expect(kinds(root)).toContain('unknown-dependency');
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
    [
      'second-order identifier aliases',
      [
        'const Local = AuditService;',
        'const Again = Local;',
        'new Again();',
      ].join('\n'),
    ],
    [
      'multi-hop object-property aliases',
      [
        'const catalog = { Audit: AuditService };',
        'const Local = catalog.Audit;',
        'const Again = Local;',
        'new Again();',
      ].join('\n'),
    ],
  ])('recursively rejects dependency construction through %s', (_name, construction) => {
    const root = fixture({
      'src/services/audit.service.ts': 'export class AuditService {}',
      'src/api/probe.ts': [
        'import { AuditService } from "../services/audit.service.js";',
        construction,
      ].join('\n'),
    });
    const inventory = inspectArchitecture({ projectRoot: root });
    expect(inventory.constructions.map(site => site.name)).toContain('AuditService');
    expect(kinds(root)).toContain('construction-outside-root');
  });

  it('fails closed on cyclic and computed constructor aliases', () => {
    const cycleRoot = fixture({
      'src/api/probe.ts': [
        'const FirstService = SecondService;',
        'const SecondService = FirstService;',
        'new FirstService();',
      ].join('\n'),
    });
    expect(kinds(cycleRoot)).toContain('unknown-construction');

    const computedRoot = fixture({
      'src/services/audit.service.ts': 'export class AuditService {}',
      'src/api/probe.ts': [
        'import { AuditService } from "../services/audit.service.js";',
        'declare const dependency: string;',
        'const catalog = { AuditService };',
        'new catalog[dependency]();',
      ].join('\n'),
    });
    expect(kinds(computedRoot)).toContain('unknown-construction');
  });

  it.each([
    [
      'namespace alias',
      'const Runtime = Reflect; Runtime.construct(LocalAudit, []);',
    ],
    [
      'function alias',
      'const construct = Reflect.construct; construct(LocalAudit, []);',
    ],
  ])('rejects Reflect.construct through a %s', (_name, construction) => {
    const root = fixture({
      'src/services/audit.service.ts': 'export class AuditService {}',
      'src/api/probe.ts': [
        'import { AuditService as LocalAudit } from "../services/audit.service.js";',
        construction,
      ].join('\n'),
    });
    const inventory = inspectArchitecture({ projectRoot: root });
    expect(inventory.constructions.map(site => site.name)).toContain('AuditService');
    expect(kinds(root)).toContain('construction-outside-root');
  });

  it.each([
    ['string-literal property', 'Reflect["construct"](AuditService, []);'],
    ['no-substitution template property', 'Reflect[`construct`](AuditService, []);'],
    [
      'multi-hop function aliases',
      [
        'const construct = Reflect["construct"];',
        'const again = construct;',
        'again(AuditService, []);',
      ].join('\n'),
    ],
  ])('rejects canonical computed Reflect.construct through %s', (_name, construction) => {
    const root = fixture({
      'src/services/audit.service.ts': 'export class AuditService {}',
      'src/api/probe.ts': [
        'import { AuditService } from "../services/audit.service.js";',
        construction,
      ].join('\n'),
    });
    expect(kinds(root)).toContain('construction-outside-root');
  });

  it('fails closed on computed Reflect selectors', () => {
    const root = fixture({
      'src/services/audit.service.ts': 'export class AuditService {}',
      'src/api/probe.ts': [
        'import { AuditService } from "../services/audit.service.js";',
        'declare const operation: string;',
        'Reflect[operation](AuditService, []);',
      ].join('\n'),
    });
    expect(kinds(root)).toContain('unknown-construction');
  });

  it('fails closed when Reflect.construct receives an unknown target', () => {
    const root = fixture({
      'src/api/probe.ts': 'declare const target: any; Reflect.construct(target, []);',
    });
    expect(kinds(root)).toContain('unknown-construction');
  });

  it.each([
    ['string-literal constructor property', 'const catalog = { Audit: AuditService }; new catalog["Audit"]();'],
    ['template constructor property', 'const catalog = { Audit: AuditService }; new catalog[`Audit`]();'],
    [
      'nested string-literal constructor property',
      'const registry = { catalog: { Audit: AuditService } }; new registry.catalog["Audit"]();',
    ],
    [
      'nested template constructor property',
      'const registry = { catalog: { Audit: AuditService } }; new registry["catalog"][`Audit`]();',
    ],
    [
      'renamed namespace destructuring',
      'const { AuditService: LocalAudit } = Services; new LocalAudit();',
    ],
    [
      'direct namespace destructuring',
      'const { AuditService } = Services; new AuditService();',
    ],
    [
      'nested renamed destructuring',
      'const { services: { Audit: LocalAudit } } = { services: { Audit: Services.AuditService } }; new LocalAudit();',
    ],
    [
      'defaulted renamed destructuring',
      'const { Audit: LocalAudit = Date } = { Audit: Services.AuditService }; new LocalAudit();',
    ],
  ])('guards reviewed constructor resolution through %s', (_name, source) => {
    const root = fixture({
      'src/services/audit.service.ts': 'export class AuditService {}',
      'src/api/probe.ts': [
        'import * as Services from "../services/audit.service.js";',
        source,
      ].join('\n'),
    });
    expect(guarded(root)).toBe(true);
  });

  it.each([
    [
      'property constructor cycle',
      [
        'const first = { AuditService: second.AuditService };',
        'const second = { AuditService: first.AuditService };',
        'new first.AuditService();',
      ].join('\n'),
      'cycle',
    ],
    [
      'ambiguous conditional constructor',
      'const Local = Math.random() > 0.5 ? AuditService : Date; new Local();',
      'ambiguous',
    ],
    [
      'nonliteral computed constructor',
      'declare const key: string; const catalog = { AuditService }; new catalog[key]();',
      'Computed selector',
    ],
  ])('fails closed with an actionable diagnostic for %s', (_name, source, diagnostic) => {
    const root = fixture({
      'src/services/audit.service.ts': 'export class AuditService {}',
      'src/api/probe.ts': [
        'import { AuditService } from "../services/audit.service.js";',
        source,
      ].join('\n'),
    });
    const violations = inspectArchitecture({ projectRoot: root }).violations;
    expect(violations.some(violation => (
      violation.kind === 'unknown-construction'
      && violation.message.toLowerCase().includes(diagnostic.toLowerCase())
    ))).toBe(true);
  });

  it.each([
    [
      'direct destructuring',
      'const { load } = { load: require }; load("../mcp/server.js");',
    ],
    [
      'renamed and multi-hop destructuring',
      [
        'const loaders = { load: require };',
        'const { load: localLoad } = loaders;',
        'const again = localLoad;',
        'again("../mcp/server.js");',
      ].join('\n'),
    ],
    [
      'nested object-property chain',
      [
        'const loaders = { load: require };',
        'const aliases = { invoke: loaders.load };',
        'const { invoke } = aliases;',
        'invoke("../mcp/server.js");',
      ].join('\n'),
    ],
  ])('resolves a require loader through %s', (_name, source) => {
    const root = fixture({ 'src/api/probe.ts': source });
    expect(kinds(root)).toContain('api-to-mcp');
  });

  it('fails closed on cyclic and computed destructured loader aliases', () => {
    const cycleRoot = fixture({
      'src/api/probe.ts': [
        'const load = again;',
        'const again = load;',
        'load("../mcp/server.js");',
      ].join('\n'),
    });
    expect(kinds(cycleRoot)).toContain('unknown-dependency');

    const computedRoot = fixture({
      'src/api/probe.ts': [
        'declare const property: string;',
        'const { [property]: load } = { load: require };',
        'load("../mcp/server.js");',
      ].join('\n'),
    });
    expect(kinds(computedRoot)).toContain('unknown-dependency');
  });

  it.each([
    ['string-literal loader property', 'const loaders = { load: require }; loaders["load"]("../mcp/server.js");', 'api-to-mcp'],
    ['template loader property', 'const loaders = { load: require }; loaders[`load`]("../mcp/server.js");', 'api-to-mcp'],
    [
      'nested string-literal loader property',
      'const runtime = { loaders: { load: require } }; runtime.loaders["load"]("../mcp/server.js");',
      'api-to-mcp',
    ],
    [
      'nested destructured loader property',
      'const { runtime: { load } } = { runtime: { load: require } }; load("../mcp/server.js");',
      'api-to-mcp',
    ],
    [
      'direct nonliteral loader property',
      'declare const key: string; const loaders = { load: require }; loaders[key]("../mcp/server.js");',
      'unknown-dependency',
    ],
    [
      'nested nonliteral loader property',
      'declare const key: string; const runtime = { loaders: { load: require } }; runtime.loaders[key]("../mcp/server.js");',
      'unknown-dependency',
    ],
    [
      'conditional loader alias',
      'const load = Math.random() > 0.5 ? require : JSON.parse; load("../mcp/server.js");',
      'unknown-dependency',
    ],
    [
      'logical-or loader alias',
      'const load = require || JSON.parse; load("../mcp/server.js");',
      'unknown-dependency',
    ],
    [
      'logical-and loader alias',
      'const load = require && JSON.parse; load("../mcp/server.js");',
      'unknown-dependency',
    ],
    [
      'nullish loader alias',
      'const load = require ?? JSON.parse; load("../mcp/server.js");',
      'unknown-dependency',
    ],
    [
      'cyclic property loader alias',
      [
        'const first = { load: second.load };',
        'const second = { load: first.load };',
        'first.load("../mcp/server.js");',
      ].join('\n'),
      'unknown-dependency',
    ],
  ])('guards reviewed loader resolution through %s', (_name, source, expectedKind) => {
    const root = fixture({ 'src/api/probe.ts': source });
    expect(kinds(root)).toContain(expectedKind as ArchitectureViolationKind);
  });

  it.each([
    [
      'object-held computed Reflect function',
      'const operations = { construct: Reflect.construct }; operations["construct"](AuditService, []);',
    ],
    [
      'object-held template Reflect function',
      'const operations = { construct: Reflect.construct }; operations[`construct`](AuditService, []);',
    ],
    [
      'nested object-held Reflect function',
      'const runtime = { operations: { construct: Reflect.construct } }; runtime.operations.construct(AuditService, []);',
    ],
  ])('rejects reviewed Reflect construction through %s', (_name, source) => {
    const root = fixture({
      'src/services/audit.service.ts': 'export class AuditService {}',
      'src/api/probe.ts': [
        'import { AuditService } from "../services/audit.service.js";',
        source,
      ].join('\n'),
    });
    expect(kinds(root)).toContain('construction-outside-root');
  });

  it.each([
    ['conditional Reflect alias', 'const construct = Math.random() > 0.5 ? Reflect.construct : JSON.parse;'],
    ['logical-or Reflect alias', 'const construct = Reflect.construct || JSON.parse;'],
    ['logical-and Reflect alias', 'const construct = Reflect.construct && JSON.parse;'],
    ['nullish Reflect alias', 'const construct = Reflect.construct ?? JSON.parse;'],
  ])('fails closed for %s', (_name, declaration) => {
    const root = fixture({
      'src/services/audit.service.ts': 'export class AuditService {}',
      'src/api/probe.ts': [
        'import { AuditService } from "../services/audit.service.js";',
        declaration,
        'construct(AuditService, []);',
      ].join('\n'),
    });
    const violations = inspectArchitecture({ projectRoot: root }).violations;
    expect(violations.some(violation => (
      violation.kind === 'unknown-construction'
      && violation.message.includes('ambiguous values')
    ))).toBe(true);
  });

  it.each([
    [
      'generic constructor parameter',
      [
        'const instantiate = <T>(Constructor: new () => T): T => new Constructor();',
        'instantiate(LocalAudit);',
      ].join('\n'),
    ],
    [
      'namespace factory alias',
      [
        'const factories = { instantiate: <T>(Constructor: new () => T): T => Reflect.construct(Constructor, []) };',
        'factories.instantiate(LocalAudit);',
      ].join('\n'),
    ],
    [
      'typed return helper',
      [
        'function provideAuditService(): AuditService { throw new Error("probe"); }',
        'provideAuditService();',
      ].join('\n'),
    ],
  ])('rejects an unowned dependency factory through %s', (_name, factory) => {
    const root = fixture({
      'src/services/audit.service.ts': 'export class AuditService {}',
      'src/api/probe.ts': [
        'import { AuditService as LocalAudit } from "../services/audit.service.js";',
        'type AuditService = LocalAudit;',
        factory,
      ].join('\n'),
    });
    expect(kinds(root)).toContain('construction-outside-root');
  });

  it('allows a root-owned and explicitly transaction-scoped dependency factory', () => {
    const root = fixture({
      'src/services/token.service.ts': 'export class TokenService {}',
      'src/services/transaction-service.factory.ts': [
        'import type { TokenService } from "./token.service.js";',
        'export interface TransactionServiceProviders { createToken(): TokenService; }',
      ].join('\n'),
      'src/services/consumer.ts': [
        'import type { TransactionServiceProviders } from "./transaction-service.factory.js";',
        'declare const providers: TransactionServiceProviders;',
        'providers.createToken();',
      ].join('\n'),
      'src/application/composition.ts': [
        'import { TokenService } from "../services/token.service.js";',
        'export function createTokenService(): TokenService { return new TokenService(); }',
      ].join('\n'),
      'src/api/probe.ts': [
        'import { createTokenService } from "../application/composition.js";',
        'void createTokenService();',
      ].join('\n'),
    });
    expect(kinds(root)).not.toContain('construction-outside-root');
  });

  it('does not flag legitimate multi-hop aliases or destructured non-loaders', () => {
    const root = fixture({
      'src/api/probe.ts': [
        'const LocalDate = Date;',
        'const Again = LocalDate;',
        'new Again();',
        'const parsers = { load: JSON.parse };',
        'const { load } = parsers;',
        'const parse = load;',
        'parse("{}");',
        'JSON["parse"]("{}");',
      ].join('\n'),
    });
    expect(kinds(root)).not.toContain('construction-outside-root');
    expect(kinds(root)).not.toContain('unknown-construction');
    expect(kinds(root)).not.toContain('unknown-dependency');
  });

  it.each([
    ['literal JSON property', 'const parsers = { load: JSON.parse }; parsers["load"]("{}");'],
    ['template JSON property', 'const parsers = { load: JSON.parse }; parsers[`load`]("{}");'],
    ['computed JSON property', 'declare const key: string; const parsers = { load: JSON.parse }; parsers[key]("{}");'],
    [
      'nested computed JSON property',
      'declare const key: string; const runtime = { parsers: { load: JSON.parse } }; runtime.parsers[key]("{}");',
    ],
    ['safe conditional function alias', 'const parse = Math.random() > 0.5 ? JSON.parse : Number; parse("1");'],
    ['safe logical function alias', 'const parse = JSON.parse || Number; parse("1");'],
    ['dynamic history method', 'declare const operation: "pushState" | "replaceState"; window.history[operation](null, "", "/");'],
    [
      'nested destructured JSON function',
      'const { runtime: { parse } } = { runtime: { parse: JSON.parse } }; parse("{}");',
    ],
  ])('does not report legitimate loader/Reflect behavior through %s', (_name, source) => {
    const root = fixture({ 'src/api/probe.ts': source });
    expect(kinds(root)).not.toContain('unknown-dependency');
    expect(kinds(root)).not.toContain('unknown-construction');
  });

  it.each([
    ['literal Date property', 'const catalog = { Date }; new catalog["Date"]();'],
    ['template Date property', 'const catalog = { Date }; new catalog[`Date`]();'],
    ['nested Date property', 'const registry = { catalog: { Date } }; new registry.catalog.Date();'],
    ['safe dynamic constructor alias', 'declare const vis: any; const Local = vis.Network || vis; new Local();'],
  ])('does not report legitimate constructor behavior through %s', (_name, source) => {
    const root = fixture({ 'src/api/probe.ts': source });
    expect(kinds(root)).not.toContain('construction-outside-root');
    expect(kinds(root)).not.toContain('unknown-construction');
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
