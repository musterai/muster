import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type ArchitectureViolationKind =
  | 'parse-error'
  | 'unknown-dependency'
  | 'unresolved-internal-dependency'
  | 'api-to-mcp'
  | 'composition-to-transport'
  | 'construction-outside-root';

export interface ArchitectureViolation {
  kind: ArchitectureViolationKind;
  file: string;
  message: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  selector: string;
}

export interface ConstructionSite {
  file: string;
  name: string;
  line: number;
}

export interface ArchitectureInventory {
  files: string[];
  edges: DependencyEdge[];
  constructions: ConstructionSite[];
  violations: ArchitectureViolation[];
  rootConstructionNames: string[];
}

export interface ArchitectureInventoryOptions {
  projectRoot: string;
  sourceDirectory?: string;
  compositionRoot?: string;
  tsconfig?: string;
}

function normalized(file: string): string {
  return path.resolve(file).replaceAll(path.sep, '/');
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function moduleText(node: ts.Expression | ts.ModuleReference | ts.TypeNode | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isExternalModuleReference(node)) return moduleText(node.expression);
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) return node.literal.text;
  return undefined;
}

function importedSelectors(
  sourceFile: ts.SourceFile,
  violations: ArchitectureViolation[],
  displayFile: string,
): string[] {
  const selectors: string[] = [];

  const recordCall = (node: ts.CallExpression, kind: 'dynamic import' | 'require') => {
    const selector = node.arguments.length === 1 ? moduleText(node.arguments[0]) : undefined;
    if (!selector) {
      violations.push({
        kind: 'unknown-dependency',
        file: displayFile,
        message: `${kind} must use exactly one string-literal module selector`,
      });
      return;
    }
    selectors.push(selector);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const selector = moduleText(node.moduleSpecifier);
      if (selector) selectors.push(selector);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const selector = moduleText(node.moduleReference);
      if (selector) selectors.push(selector);
    } else if (ts.isImportTypeNode(node)) {
      const selector = moduleText(node.argument);
      if (selector) selectors.push(selector);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      recordCall(node, 'dynamic import');
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
    ) {
      recordCall(node, 'require');
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return selectors;
}

function constructionName(
  node: ts.NewExpression,
  checker: ts.TypeChecker,
): string {
  let symbol = checker.getSymbolAtLocation(node.expression);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const symbolName = symbol?.getName();
  if (symbolName && symbolName !== '__type' && symbolName !== '__class') return symbolName;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return node.expression.getText();
}

function aliasSelector(selector: string, compilerOptions: ts.CompilerOptions): boolean {
  return Object.keys(compilerOptions.paths ?? {}).some((pattern) => {
    const prefix = pattern.replace(/\*.*$/, '');
    return selector.startsWith(prefix);
  });
}

function relativeDisplay(projectRoot: string, file: string): string {
  return path.relative(projectRoot, file).replaceAll(path.sep, '/');
}

export function inspectArchitecture({
  projectRoot,
  sourceDirectory = 'src',
  compositionRoot = 'src/application/composition.ts',
  tsconfig = 'tsconfig.json',
}: ArchitectureInventoryOptions): ArchitectureInventory {
  const root = path.resolve(projectRoot);
  const sourceRoot = path.resolve(root, sourceDirectory);
  const allowedCompositionRoot = normalized(path.resolve(root, compositionRoot));
  const configPath = path.resolve(root, tsconfig);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    const message = ts.flattenDiagnosticMessageText(config.error.messageText, '\n');
    return {
      files: [],
      edges: [],
      constructions: [],
      rootConstructionNames: [],
      violations: [{ kind: 'parse-error', file: relativeDisplay(root, configPath), message }],
    };
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const configViolations: ArchitectureViolation[] = parsed.errors.map(error => ({
    kind: 'parse-error',
    file: relativeDisplay(root, configPath),
    message: ts.flattenDiagnosticMessageText(error.messageText, '\n'),
  }));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const sourceFiles = program.getSourceFiles().filter(sourceFile => (
    isWithin(sourceRoot, sourceFile.fileName)
    && /\.tsx?$/.test(sourceFile.fileName)
  ));
  const sourceByName = new Map(sourceFiles.map(sourceFile => [normalized(sourceFile.fileName), sourceFile]));
  const sourceNames = new Set(sourceByName.keys());
  const edges: DependencyEdge[] = [];
  const constructions: ConstructionSite[] = [];
  const violations = [...configViolations];

  for (const sourceFile of sourceFiles) {
    const from = normalized(sourceFile.fileName);
    const displayFile = relativeDisplay(root, sourceFile.fileName);
    for (const diagnostic of program.getSyntacticDiagnostics(sourceFile)) {
      violations.push({
        kind: 'parse-error',
        file: displayFile,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      });
    }

    for (const selector of importedSelectors(sourceFile, violations, displayFile)) {
      const resolution = ts.resolveModuleName(
        selector,
        sourceFile.fileName,
        parsed.options,
        ts.sys,
      ).resolvedModule;
      if (!resolution) {
        const relativeAsset = selector.startsWith('.')
          ? path.resolve(path.dirname(sourceFile.fileName), selector)
          : undefined;
        if (
          relativeAsset
          && fs.existsSync(relativeAsset)
          && !/\.(?:[cm]?ts|tsx|js|jsx)$/.test(relativeAsset)
        ) {
          continue;
        }
        if (selector.startsWith('.') || selector.startsWith('/') || aliasSelector(selector, parsed.options)) {
          violations.push({
            kind: 'unresolved-internal-dependency',
            file: displayFile,
            message: `Cannot resolve internal module selector "${selector}"`,
          });
        }
        continue;
      }
      const to = normalized(resolution.resolvedFileName);
      if (sourceNames.has(to)) edges.push({ from, to, selector });
    }

    const visitConstructions = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const name = constructionName(node, checker);
        if (/(?:Service|Policy)$/.test(name)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const site = { file: displayFile, name, line };
          constructions.push(site);
          if (from !== allowedCompositionRoot) {
            violations.push({
              kind: 'construction-outside-root',
              file: displayFile,
              message: `${name} is constructed outside ${compositionRoot} at line ${line}`,
            });
          }
        }
      }
      ts.forEachChild(node, visitConstructions);
    };
    visitConstructions(sourceFile);
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const apiRoot = normalized(path.join(sourceRoot, 'api'));
  const mcpRoot = normalized(path.join(sourceRoot, 'mcp'));
  for (const apiFile of sourceNames) {
    if (!isWithin(apiRoot, apiFile)) continue;
    const queue: Array<{ file: string; route: string[] }> = [{ file: apiFile, route: [apiFile] }];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.file)) continue;
      visited.add(current.file);
      if (current.file !== apiFile && isWithin(mcpRoot, current.file)) {
        violations.push({
          kind: 'api-to-mcp',
          file: relativeDisplay(root, apiFile),
          message: current.route.map(file => relativeDisplay(root, file)).join(' -> '),
        });
        break;
      }
      for (const target of adjacency.get(current.file) ?? []) {
        queue.push({ file: target, route: [...current.route, target] });
      }
    }
  }

  const transportRoots = ['api', 'mcp', 'realtime', 'connect']
    .map(directory => normalized(path.join(sourceRoot, directory)));
  if (sourceNames.has(allowedCompositionRoot)) {
    const queue: Array<{ file: string; route: string[] }> = [{
      file: allowedCompositionRoot,
      route: [allowedCompositionRoot],
    }];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.file)) continue;
      visited.add(current.file);
      if (
        current.file !== allowedCompositionRoot
        && transportRoots.some(transportRoot => isWithin(transportRoot, current.file))
      ) {
        violations.push({
          kind: 'composition-to-transport',
          file: compositionRoot,
          message: current.route.map(file => relativeDisplay(root, file)).join(' -> '),
        });
        break;
      }
      for (const target of adjacency.get(current.file) ?? []) {
        queue.push({ file: target, route: [...current.route, target] });
      }
    }
  }

  return {
    files: [...sourceNames].map(file => relativeDisplay(root, file)).sort(),
    edges,
    constructions,
    violations,
    rootConstructionNames: [...new Set(
      constructions
        .filter(site => normalized(path.resolve(root, site.file)) === allowedCompositionRoot)
        .map(site => site.name),
    )].sort(),
  };
}

export function assertCleanArchitecture(inventory: ArchitectureInventory): void {
  if (inventory.violations.length === 0) return;
  throw new Error(inventory.violations
    .map(violation => `[${violation.kind}] ${violation.file}: ${violation.message}`)
    .join('\n'));
}
