import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type ArchitectureViolationKind =
  | 'parse-error'
  | 'unknown-dependency'
  | 'unknown-construction'
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

function unwrappedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolvedSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function symbolInitializers(symbol: ts.Symbol | undefined): ts.Expression[] {
  if (!symbol) return [];
  return (symbol.declarations ?? []).flatMap(declaration => {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) return [declaration.initializer];
    if (ts.isPropertyAssignment(declaration)) return [declaration.initializer];
    if (ts.isBindingElement(declaration) && declaration.initializer) return [declaration.initializer];
    return [];
  });
}

function isAliasedIdentifier(
  expression: ts.Expression,
  expected: 'require' | 'Reflect',
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  const current = unwrappedExpression(expression);
  if (ts.isIdentifier(current) && current.text === expected) return true;
  const symbol = resolvedSymbol(current, checker);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return symbolInitializers(symbol).some(initializer => (
    isAliasedIdentifier(initializer, expected, checker, seen)
  ));
}

function isRequireLoader(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  return isAliasedIdentifier(expression, 'require', checker);
}

function isReflectConstruct(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  const current = unwrappedExpression(expression);
  if (
    ts.isPropertyAccessExpression(current)
    && current.name.text === 'construct'
    && isAliasedIdentifier(current.expression, 'Reflect', checker)
  ) return true;
  const symbol = resolvedSymbol(current, checker);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return symbolInitializers(symbol).some(initializer => isReflectConstruct(initializer, checker, seen));
}

function importedSelectors(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
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
      && isRequireLoader(node.expression, checker)
    ) {
      recordCall(node, 'require');
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return selectors;
}

function constructionName(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): string {
  const current = unwrappedExpression(expression);
  const symbol = resolvedSymbol(current, checker);
  const symbolName = symbol?.getName();
  if (symbolName && symbolName !== '__type' && symbolName !== '__class') return symbolName;
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  return current.getText();
}

const DEPENDENCY_NAME = /(?:Service|Policy|Operations|Queries|Factory)$/;
const FACTORY_HELPER_NAME = /^(?:create|make|build|provide|construct|instantiate|factory)/i;

function dependencyTypeName(type: ts.Type, checker: ts.TypeChecker): string | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const name = symbol?.getName();
  if (name && DEPENDENCY_NAME.test(name)) return name;
  if (type.isUnionOrIntersection()) {
    return type.types.map(candidate => dependencyTypeName(candidate, checker)).find(Boolean);
  }
  const text = checker.typeToString(type).replace(/\s*\|\s*(?:undefined|null)/g, '');
  return DEPENDENCY_NAME.test(text) ? text : undefined;
}

function parameterConstructionIndexes(
  declaration: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
): number[] {
  if (!declaration.body) return [];
  const parameterIndexes = new Map<ts.Symbol, number>();
  declaration.parameters.forEach((parameter, index) => {
    const symbol = resolvedSymbol(parameter.name, checker);
    if (symbol) parameterIndexes.set(symbol, index);
  });
  const indexes = new Set<number>();
  const visit = (node: ts.Node): void => {
    let target: ts.Expression | undefined;
    if (ts.isNewExpression(node)) target = node.expression;
    else if (ts.isCallExpression(node) && isReflectConstruct(node.expression, checker)) {
      target = node.arguments[0];
    }
    if (target) {
      const symbol = resolvedSymbol(unwrappedExpression(target), checker);
      const index = symbol ? parameterIndexes.get(symbol) : undefined;
      if (index !== undefined) indexes.add(index);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return [...indexes];
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

    for (const selector of importedSelectors(sourceFile, checker, violations, displayFile)) {
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

    const recordConstruction = (name: string, node: ts.Node): void => {
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
    };

    const visitConstructions = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const name = constructionName(node.expression, checker);
        if (DEPENDENCY_NAME.test(name)) recordConstruction(name, node);
      } else if (ts.isCallExpression(node) && isReflectConstruct(node.expression, checker)) {
        const target = node.arguments[0];
        if (!target) {
          violations.push({
            kind: 'unknown-construction',
            file: displayFile,
            message: 'Reflect.construct must declare its constructor target',
          });
        } else {
          const name = constructionName(target, checker);
          if (DEPENDENCY_NAME.test(name)) {
            recordConstruction(name, node);
          } else {
            const type = checker.getTypeAtLocation(target);
            if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
              violations.push({
                kind: 'unknown-construction',
                file: displayFile,
                message: `Cannot classify Reflect.construct target "${target.getText(sourceFile)}"`,
              });
            }
          }
        }
      } else if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const declaration = signature?.getDeclaration();
        if (signature && declaration) {
          const declarationFile = normalized(declaration.getSourceFile().fileName);
          const allowedFactoryDeclaration = declarationFile === allowedCompositionRoot
            || declarationFile === normalized(path.join(sourceRoot, 'services/transaction-service.factory.ts'));
          const parameterIndexes = parameterConstructionIndexes(declaration, checker);
          for (const index of parameterIndexes) {
            const argument = node.arguments[index];
            if (!argument) {
              violations.push({
                kind: 'unknown-construction',
                file: displayFile,
                message: `Factory call omits constructor argument ${index + 1}`,
              });
              continue;
            }
            const name = constructionName(argument, checker);
            if (DEPENDENCY_NAME.test(name)) recordConstruction(name, node);
            else {
              violations.push({
                kind: 'unknown-construction',
                file: displayFile,
                message: `Cannot classify factory constructor argument "${argument.getText(sourceFile)}"`,
              });
            }
          }

          const factoryName = constructionName(node.expression, checker);
          const returnName = dependencyTypeName(checker.getReturnTypeOfSignature(signature), checker);
          if (
            returnName
            && FACTORY_HELPER_NAME.test(factoryName)
            && !allowedFactoryDeclaration
            && parameterIndexes.length === 0
          ) {
            recordConstruction(returnName, node);
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
