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

type AliasMatch =
  | { kind: 'match' }
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string };

interface InitializerLookup {
  expressions: ts.Expression[];
  unknown?: string;
}

function propertyNameText(name: ts.PropertyName | ts.Expression | undefined): InitializerLookup & { text?: string } {
  if (!name) return { expressions: [], unknown: 'Property selector is missing' };
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return { expressions: [], text: name.text };
  }
  if (ts.isComputedPropertyName(name)) {
    const text = moduleText(name.expression);
    return text === undefined
      ? { expressions: [], unknown: `Computed property selector "${name.expression.getText()}" is not literal` }
      : { expressions: [], text };
  }
  return { expressions: [], unknown: `Cannot classify property selector "${name.getText()}"` };
}

function mergeLookups(lookups: InitializerLookup[]): InitializerLookup {
  const unknown = lookups.map(lookup => lookup.unknown).find(Boolean);
  return {
    expressions: lookups.flatMap(lookup => lookup.expressions),
    ...(unknown ? { unknown } : {}),
  };
}

function propertyInitializers(
  expression: ts.Expression,
  property: string,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): InitializerLookup {
  const current = unwrappedExpression(expression);
  if (ts.isObjectLiteralExpression(current)) {
    const matches: ts.Expression[] = [];
    for (const member of current.properties) {
      if (ts.isSpreadAssignment(member)) {
        return {
          expressions: [],
          unknown: `Cannot normalize property "${property}" through an object spread`,
        };
      }
      if (!('name' in member) || !member.name) continue;
      const key = propertyNameText(member.name);
      if (key.unknown) return { expressions: [], unknown: key.unknown };
      if (key.text !== property) continue;
      if (ts.isPropertyAssignment(member)) matches.push(member.initializer);
      else if (ts.isShorthandPropertyAssignment(member)) matches.push(member.name);
      else {
        return {
          expressions: [],
          unknown: `Property "${property}" is not a value assignment`,
        };
      }
    }
    if (matches.length === 1) return { expressions: matches };
    if (matches.length === 0) return { expressions: [] };
    return { expressions: [], unknown: `Property "${property}" has multiple assignments` };
  }

  const symbol = resolvedSymbol(current, checker);
  if (!symbol) return { expressions: [] };
  if (seen.has(symbol)) {
    return {
      expressions: [],
      unknown: `Alias cycle reaches "${symbol.getName()}"`,
    };
  }
  const nextSeen = new Set(seen).add(symbol);
  const lookup = symbolInitializers(symbol, checker, nextSeen);
  if (lookup.unknown) return lookup;
  if (lookup.expressions.length === 0) return { expressions: [] };
  return mergeLookups(lookup.expressions.map(initializer => (
    propertyInitializers(initializer, property, checker, nextSeen)
  )));
}

function bindingElementInitializers(
  declaration: ts.BindingElement,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): InitializerLookup {
  const selectorName = declaration.propertyName
    ?? (ts.isIdentifier(declaration.name) ? declaration.name : undefined);
  const key = propertyNameText(selectorName);
  if (key.unknown || key.text === undefined) return key;
  const pattern = declaration.parent;
  if (!ts.isObjectBindingPattern(pattern)) {
    return { expressions: [] };
  }

  const owner = pattern.parent;
  let sources: InitializerLookup;
  if (ts.isVariableDeclaration(owner) || ts.isParameter(owner)) {
    sources = owner.initializer
      ? { expressions: [owner.initializer] }
      : { expressions: [] };
  } else if (ts.isBindingElement(owner)) {
    sources = bindingElementInitializers(owner, checker, seen);
  } else {
    sources = { expressions: [] };
  }
  if (sources.unknown) return sources;

  const selected = mergeLookups(sources.expressions.map(source => (
    propertyInitializers(source, key.text!, checker, seen)
  )));
  if (declaration.initializer) selected.expressions.push(declaration.initializer);
  return selected;
}

function symbolInitializers(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): InitializerLookup {
  if (!symbol) return { expressions: [] };
  const lookups = (symbol.declarations ?? []).map((declaration): InitializerLookup => {
    if (ts.isVariableDeclaration(declaration)) {
      return declaration.initializer ? { expressions: [declaration.initializer] } : { expressions: [] };
    }
    if (ts.isPropertyAssignment(declaration)) return { expressions: [declaration.initializer] };
    if (ts.isBindingElement(declaration)) {
      return bindingElementInitializers(declaration, checker, seen);
    }
    return { expressions: [] };
  });
  return mergeLookups(lookups);
}

function combineAliasMatches(matches: AliasMatch[], subject: string): AliasMatch {
  const unknown = matches.find(match => match.kind === 'unknown');
  if (unknown?.kind === 'unknown') return unknown;
  const matched = matches.filter(match => match.kind === 'match').length;
  if (matched === matches.length && matched > 0) return { kind: 'match' };
  if (matched === 0) return { kind: 'none' };
  return { kind: 'unknown', reason: `Alias "${subject}" has ambiguous initializers` };
}

function aliasedIdentifierMatch(
  expression: ts.Expression,
  expected: 'require' | 'Reflect',
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): AliasMatch {
  const current = unwrappedExpression(expression);
  if (ts.isIdentifier(current) && current.text === expected) return { kind: 'match' };
  const symbol = resolvedSymbol(current, checker);
  if (!symbol) return { kind: 'none' };
  if (seen.has(symbol)) {
    return { kind: 'unknown', reason: `Alias cycle reaches "${symbol.getName()}"` };
  }
  const nextSeen = new Set(seen).add(symbol);
  const lookup = symbolInitializers(symbol, checker, nextSeen);
  if (lookup.unknown) return { kind: 'unknown', reason: lookup.unknown };
  if (lookup.expressions.length === 0) return { kind: 'none' };
  return combineAliasMatches(
    lookup.expressions.map(initializer => aliasedIdentifierMatch(initializer, expected, checker, nextSeen)),
    current.getText(),
  );
}

function isRequireLoader(expression: ts.Expression, checker: ts.TypeChecker): AliasMatch {
  return aliasedIdentifierMatch(expression, 'require', checker);
}

function elementSelector(expression: ts.ElementAccessExpression): AliasMatch & { text?: string } {
  const text = moduleText(expression.argumentExpression);
  return text === undefined
    ? { kind: 'unknown', reason: `Computed selector "${expression.argumentExpression.getText()}" is not literal` }
    : { kind: 'match', text };
}

function isReflectConstruct(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): AliasMatch {
  const current = unwrappedExpression(expression);
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const reflect = aliasedIdentifierMatch(current.expression, 'Reflect', checker, seen);
    if (reflect.kind === 'unknown') return reflect;
    if (reflect.kind === 'match') {
      if (ts.isPropertyAccessExpression(current)) {
        return current.name.text === 'construct' ? { kind: 'match' } : { kind: 'none' };
      }
      const selector = elementSelector(current);
      if (selector.kind === 'unknown') return selector;
      return selector.text === 'construct' ? { kind: 'match' } : { kind: 'none' };
    }
  }
  const symbol = resolvedSymbol(current, checker);
  if (!symbol) return { kind: 'none' };
  if (seen.has(symbol)) {
    return { kind: 'unknown', reason: `Reflect.construct alias cycle reaches "${symbol.getName()}"` };
  }
  const nextSeen = new Set(seen).add(symbol);
  const lookup = symbolInitializers(symbol, checker, nextSeen);
  if (lookup.unknown) return { kind: 'unknown', reason: lookup.unknown };
  if (lookup.expressions.length === 0) return { kind: 'none' };
  return combineAliasMatches(
    lookup.expressions.map(initializer => isReflectConstruct(initializer, checker, nextSeen)),
    current.getText(),
  );
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
    } else if (ts.isCallExpression(node)) {
      const loader = isRequireLoader(node.expression, checker);
      if (loader.kind === 'match') recordCall(node, 'require');
      else if (loader.kind === 'unknown') {
        violations.push({
          kind: 'unknown-dependency',
          file: displayFile,
          message: `Cannot classify loader alias "${node.expression.getText(sourceFile)}": ${loader.reason}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return selectors;
}

interface ConstructionTarget {
  name?: string;
  unknown?: string;
}

function constructionTarget(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
  strictAlias = false,
): ConstructionTarget {
  const current = unwrappedExpression(expression);
  if (ts.isElementAccessExpression(current)) {
    const selector = elementSelector(current);
    if (selector.kind === 'unknown') return { unknown: selector.reason };
  }
  const symbol = resolvedSymbol(current, checker);
  const symbolName = symbol?.getName();
  const hasAliasDeclaration = symbol?.declarations?.some(declaration => (
    ts.isVariableDeclaration(declaration)
    || ts.isPropertyAssignment(declaration)
    || ts.isBindingElement(declaration)
  )) ?? false;
  if (symbolName && DEPENDENCY_NAME.test(symbolName) && !hasAliasDeclaration) {
    return { name: symbolName };
  }
  if (symbol) {
    if (seen.has(symbol)) {
      return { unknown: `Constructor alias cycle reaches "${symbolName ?? current.getText()}"` };
    }
    const nextSeen = new Set(seen).add(symbol);
    const lookup = symbolInitializers(symbol, checker, nextSeen);
    if (lookup.unknown) return { unknown: lookup.unknown };
    if (lookup.expressions.length > 0) {
      const targets = lookup.expressions.map(initializer => (
        constructionTarget(initializer, checker, nextSeen, true)
      ));
      const unknown = targets.map(target => target.unknown).find(Boolean);
      if (unknown) return { unknown };
      const names = [...new Set(targets.map(target => target.name).filter(Boolean))] as string[];
      if (names.length === 1) return { name: names[0] };
      if (names.length > 1) {
        return { unknown: `Constructor alias "${current.getText()}" has ambiguous initializers` };
      }
    }
  }
  if (symbolName && symbolName !== '__type' && symbolName !== '__class') return { name: symbolName };
  if (ts.isIdentifier(current)) return { name: current.text };
  if (ts.isPropertyAccessExpression(current)) return { name: current.name.text };
  if (ts.isElementAccessExpression(current)) {
    const selector = elementSelector(current);
    if (selector.kind === 'match') return { name: selector.text };
  }
  return strictAlias
    ? { unknown: `Cannot normalize constructor alias expression "${current.getText()}"` }
    : { name: current.getText() };
}

function constructionName(expression: ts.Expression, checker: ts.TypeChecker): string {
  const target = constructionTarget(expression, checker);
  return target.name ?? unwrappedExpression(expression).getText();
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
    else if (
      ts.isCallExpression(node)
      && isReflectConstruct(node.expression, checker).kind === 'match'
    ) {
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
        const target = constructionTarget(node.expression, checker);
        if (target.name && DEPENDENCY_NAME.test(target.name)) recordConstruction(target.name, node);
        else if (
          target.unknown
          && (
            ts.isElementAccessExpression(unwrappedExpression(node.expression))
            || DEPENDENCY_NAME.test(constructionName(node.expression, checker))
          )
        ) {
          violations.push({
            kind: 'unknown-construction',
            file: displayFile,
            message: `Cannot classify constructor target "${node.expression.getText(sourceFile)}": ${target.unknown}`,
          });
        }
      } else if (ts.isCallExpression(node)) {
        const reflectConstruct = isReflectConstruct(node.expression, checker);
        if (reflectConstruct.kind === 'unknown') {
          violations.push({
            kind: 'unknown-construction',
            file: displayFile,
            message: `Cannot classify reflective constructor call "${node.expression.getText(sourceFile)}": ${reflectConstruct.reason}`,
          });
          ts.forEachChild(node, visitConstructions);
          return;
        }
        if (reflectConstruct.kind === 'match') {
          const target = node.arguments[0];
          if (!target) {
            violations.push({
              kind: 'unknown-construction',
              file: displayFile,
              message: 'Reflect.construct must declare its constructor target',
            });
          } else {
            const resolved = constructionTarget(target, checker);
            if (resolved.name && DEPENDENCY_NAME.test(resolved.name)) {
              recordConstruction(resolved.name, node);
            } else if (resolved.unknown) {
              violations.push({
                kind: 'unknown-construction',
                file: displayFile,
                message: `Cannot classify Reflect.construct target "${target.getText(sourceFile)}": ${resolved.unknown}`,
              });
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
          ts.forEachChild(node, visitConstructions);
          return;
        }

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
            const target = constructionTarget(argument, checker);
            if (target.name && DEPENDENCY_NAME.test(target.name)) recordConstruction(target.name, node);
            else {
              violations.push({
                kind: 'unknown-construction',
                file: displayFile,
                message: `Cannot classify factory constructor argument "${argument.getText(sourceFile)}"${target.unknown ? `: ${target.unknown}` : ''}`,
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
