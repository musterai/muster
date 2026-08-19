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

type BuiltinValue = 'require' | 'Reflect' | 'Reflect.construct';

type ResolvedValue =
  | { kind: 'builtin'; name: BuiltinValue }
  | { kind: 'symbol'; symbol: ts.Symbol }
  | { kind: 'expression'; expression: ts.Expression };

interface ResolutionIssue {
  reason: string;
  conditional: boolean;
}

interface ValueResolution {
  values: ResolvedValue[];
  issues: ResolutionIssue[];
}

interface ResolutionState {
  symbols: Set<ts.Symbol>;
  members: Set<ts.Node>;
}

function emptyResolution(): ValueResolution {
  return { values: [], issues: [] };
}

function mergeResolutions(resolutions: ValueResolution[]): ValueResolution {
  return {
    values: resolutions.flatMap(resolution => resolution.values),
    issues: resolutions.flatMap(resolution => resolution.issues),
  };
}

function propertySelector(name: ts.PropertyName | ts.Expression | undefined): {
  text?: string;
  issue?: ResolutionIssue;
} {
  if (!name) return { issue: { reason: 'Property selector is missing', conditional: false } };
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return { text: name.text };
  }
  if (ts.isComputedPropertyName(name)) {
    const text = moduleText(name.expression);
    return text === undefined
      ? {
          issue: {
            reason: `Computed property selector "${name.expression.getText()}" is not literal`,
            conditional: false,
          },
        }
      : { text };
  }
  return {
    issue: {
      reason: `Cannot classify property selector "${name.getText()}"`,
      conditional: false,
    },
  };
}

function resolveBindingElement(
  declaration: ts.BindingElement,
  checker: ts.TypeChecker,
  state: ResolutionState,
): ValueResolution {
  const selectorName = declaration.propertyName
    ?? (ts.isIdentifier(declaration.name) ? declaration.name : undefined);
  const selector = propertySelector(selectorName);
  if (selector.issue || selector.text === undefined) {
    return { values: [], issues: selector.issue ? [selector.issue] : [] };
  }
  const pattern = declaration.parent;
  if (!ts.isObjectBindingPattern(pattern)) return emptyResolution();

  const owner = pattern.parent;
  let source: ValueResolution;
  if (ts.isVariableDeclaration(owner) || ts.isParameter(owner)) {
    source = owner.initializer
      ? resolveValue(owner.initializer, checker, state)
      : emptyResolution();
  } else if (ts.isBindingElement(owner)) {
    source = resolveBindingElement(owner, checker, state);
  } else {
    source = emptyResolution();
  }
  const selected = selectProperty(source, selector.text, checker, state);
  return declaration.initializer && selected.values.length === 0
    ? mergeResolutions([selected, resolveValue(declaration.initializer, checker, state)])
    : selected;
}

function resolveSymbolValue(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  state: ResolutionState,
): ValueResolution {
  if (state.symbols.has(symbol)) {
    return {
      values: [],
      issues: [{ reason: `Alias cycle reaches "${symbol.getName()}"`, conditional: false }],
    };
  }
  const nextState = { ...state, symbols: new Set(state.symbols).add(symbol) };
  const declarations = symbol.declarations ?? [];
  const initializers = declarations.flatMap((declaration): ValueResolution[] => {
    if (
      (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration))
      && declaration.initializer
    ) {
      return [resolveValue(declaration.initializer, checker, nextState)];
    }
    if (ts.isPropertyAssignment(declaration)) {
      return [resolveValue(declaration.initializer, checker, nextState)];
    }
    if (ts.isBindingElement(declaration)) {
      return [resolveBindingElement(declaration, checker, nextState)];
    }
    return [];
  });
  if (initializers.length === 0) return { values: [{ kind: 'symbol', symbol }], issues: [] };
  const resolution = mergeResolutions(initializers);
  return resolution.values.length === 0 && resolution.issues.length === 0
    ? { values: [{ kind: 'symbol', symbol }], issues: [] }
    : resolution;
}

function objectPropertyValues(
  object: ts.ObjectLiteralExpression,
  property: string,
  checker: ts.TypeChecker,
  state: ResolutionState,
): ValueResolution {
  const resolutions: ValueResolution[] = [];
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      const spread = selectProperty(resolveValue(member.expression, checker, state), property, checker, state);
      resolutions.push({
        ...spread,
        issues: [
          ...spread.issues,
          { reason: `Property "${property}" may be supplied by an object spread`, conditional: true },
        ],
      });
      continue;
    }
    if (!('name' in member) || !member.name) continue;
    const selector = propertySelector(member.name);
    if (selector.issue) return { values: [], issues: [selector.issue] };
    if (selector.text !== property) continue;
    if (ts.isPropertyAssignment(member)) {
      resolutions.push(resolveValue(member.initializer, checker, state));
    } else if (ts.isShorthandPropertyAssignment(member)) {
      const valueSymbol = checker.getShorthandAssignmentValueSymbol(member);
      resolutions.push(valueSymbol
        ? resolveSymbolValue(valueSymbol, checker, state)
        : resolveValue(member.name, checker, state));
    } else {
      resolutions.push({
        values: [],
        issues: [{ reason: `Property "${property}" is not a value assignment`, conditional: false }],
      });
    }
  }
  return resolutions.length > 0 ? mergeResolutions(resolutions) : emptyResolution();
}

function symbolPropertyValue(
  symbol: ts.Symbol,
  property: string,
  checker: ts.TypeChecker,
  state: ResolutionState,
): ValueResolution {
  const exported = symbol.exports?.get(ts.escapeLeadingUnderscores(property));
  if (exported) {
    const target = (exported.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(exported)
      : exported;
    return resolveSymbolValue(target, checker, state);
  }

  const location = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!location) return emptyResolution();
  const propertySymbol = checker.getTypeOfSymbolAtLocation(symbol, location).getProperty(property);
  return propertySymbol ? resolveSymbolValue(propertySymbol, checker, state) : emptyResolution();
}

function selectProperty(
  source: ValueResolution,
  property: string,
  checker: ts.TypeChecker,
  state: ResolutionState,
): ValueResolution {
  const selected = source.values.map((value): ValueResolution => {
    if (value.kind === 'builtin') {
      return value.name === 'Reflect' && property === 'construct'
        ? { values: [{ kind: 'builtin', name: 'Reflect.construct' }], issues: [] }
        : emptyResolution();
    }
    if (value.kind === 'symbol') {
      return symbolPropertyValue(value.symbol, property, checker, state);
    }
    const expression = unwrappedExpression(value.expression);
    if (ts.isObjectLiteralExpression(expression)) {
      return objectPropertyValues(expression, property, checker, state);
    }
    const propertySymbol = checker.getTypeAtLocation(expression).getProperty(property);
    return propertySymbol ? resolveSymbolValue(propertySymbol, checker, state) : emptyResolution();
  });
  return mergeResolutions([{ values: [], issues: source.issues }, ...selected]);
}

function enumerateProperties(
  source: ValueResolution,
  checker: ts.TypeChecker,
  state: ResolutionState,
): ValueResolution {
  const enumerated = source.values.map((value): ValueResolution => {
    if (value.kind === 'builtin') {
      return value.name === 'Reflect'
        ? { values: [{ kind: 'builtin', name: 'Reflect.construct' }], issues: [] }
        : emptyResolution();
    }
    if (value.kind === 'symbol') {
      if (!value.symbol.exports) return emptyResolution();
      return mergeResolutions([...value.symbol.exports.values()].map(exported => (
        resolveSymbolValue(exported, checker, state)
      )));
    }
    const expression = unwrappedExpression(value.expression);
    if (!ts.isObjectLiteralExpression(expression)) return emptyResolution();
    return mergeResolutions(expression.properties.map((member): ValueResolution => {
      if (ts.isSpreadAssignment(member)) {
        return enumerateProperties(resolveValue(member.expression, checker, state), checker, state);
      }
      if (ts.isPropertyAssignment(member)) return resolveValue(member.initializer, checker, state);
      if (ts.isShorthandPropertyAssignment(member)) {
        const valueSymbol = checker.getShorthandAssignmentValueSymbol(member);
        return valueSymbol ? resolveSymbolValue(valueSymbol, checker, state) : emptyResolution();
      }
      return emptyResolution();
    }));
  });
  return mergeResolutions([{ values: [], issues: source.issues }, ...enumerated]);
}

function resolvePropertyExpression(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
  state: ResolutionState,
): ValueResolution {
  if (state.members.has(expression)) {
    return {
      values: [],
      issues: [{
        reason: `Property alias cycle reaches "${expression.getText()}"`,
        conditional: false,
      }],
    };
  }
  const nextState = { ...state, members: new Set(state.members).add(expression) };
  const source = resolveValue(expression.expression, checker, nextState);
  const reflectSource = source.values.some(value => (
    value.kind === 'builtin' && value.name === 'Reflect'
  ));
  if (ts.isPropertyAccessExpression(expression)) {
    if (!reflectSource) {
      const memberSymbol = resolvedSymbol(expression.name, checker);
      if (memberSymbol) return resolveSymbolValue(memberSymbol, checker, nextState);
    }
    return selectProperty(source, expression.name.text, checker, nextState);
  }
  const selector = moduleText(expression.argumentExpression);
  if (selector !== undefined) {
    if (!reflectSource) {
      const memberSymbol = resolvedSymbol(expression.argumentExpression, checker);
      if (memberSymbol) return resolveSymbolValue(memberSymbol, checker, nextState);
    }
    return selectProperty(source, selector, checker, nextState);
  }
  const possible = enumerateProperties(source, checker, nextState);
  return {
    values: possible.values,
    issues: [
      ...possible.issues,
      {
        reason: `Computed selector "${expression.argumentExpression.getText()}" is not literal`,
        conditional: true,
      },
    ],
  };
}

function resolveValue(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  state: ResolutionState = { symbols: new Set(), members: new Set() },
): ValueResolution {
  const current = unwrappedExpression(expression);
  if (ts.isConditionalExpression(current)) {
    return mergeResolutions([
      resolveValue(current.whenTrue, checker, state),
      resolveValue(current.whenFalse, checker, state),
    ]);
  }
  if (
    ts.isBinaryExpression(current)
    && [
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(current.operatorToken.kind)
  ) {
    return mergeResolutions([
      resolveValue(current.left, checker, state),
      resolveValue(current.right, checker, state),
    ]);
  }
  if (ts.isIdentifier(current) && current.text === 'require') {
    return { values: [{ kind: 'builtin', name: 'require' }], issues: [] };
  }
  if (ts.isIdentifier(current) && current.text === 'Reflect') {
    return { values: [{ kind: 'builtin', name: 'Reflect' }], issues: [] };
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return resolvePropertyExpression(current, checker, state);
  }
  const symbol = resolvedSymbol(current, checker);
  if (symbol) return resolveSymbolValue(symbol, checker, state);
  return { values: [{ kind: 'expression', expression: current }], issues: [] };
}

function classifyResolvedValue(
  resolution: ValueResolution,
  matches: (value: ResolvedValue) => boolean,
  subject: string,
): AliasMatch {
  const matched = resolution.values.filter(matches).length;
  const unmatched = resolution.values.length - matched;
  const unconditional = resolution.issues.find(issue => !issue.conditional);
  if (unconditional) return { kind: 'unknown', reason: unconditional.reason };
  const conditional = resolution.issues.find(issue => issue.conditional);
  if (conditional && matched > 0) return { kind: 'unknown', reason: conditional.reason };
  if (matched > 0 && unmatched > 0) {
    return { kind: 'unknown', reason: `Alias "${subject}" has ambiguous values` };
  }
  return matched > 0 ? { kind: 'match' } : { kind: 'none' };
}

function isRequireLoader(expression: ts.Expression, checker: ts.TypeChecker): AliasMatch {
  return classifyResolvedValue(
    resolveValue(expression, checker),
    value => value.kind === 'builtin' && value.name === 'require',
    expression.getText(),
  );
}

function isReflectConstruct(expression: ts.Expression, checker: ts.TypeChecker): AliasMatch {
  return classifyResolvedValue(
    resolveValue(expression, checker),
    value => value.kind === 'builtin' && value.name === 'Reflect.construct',
    expression.getText(),
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
): ConstructionTarget {
  const current = unwrappedExpression(expression);
  const resolution = resolveValue(current, checker);
  const names = resolution.values.map((value): string => {
    if (value.kind === 'builtin') return value.name;
    if (value.kind === 'symbol') return value.symbol.getName();
    const candidate = unwrappedExpression(value.expression);
    if (ts.isIdentifier(candidate)) return candidate.text;
    if (ts.isPropertyAccessExpression(candidate)) return candidate.name.text;
    if (ts.isElementAccessExpression(candidate)) {
      return moduleText(candidate.argumentExpression) ?? candidate.getText();
    }
    return candidate.getText();
  }).filter(name => name !== '__type' && name !== '__class');
  const dependencyNames = [...new Set(names.filter(name => DEPENDENCY_NAME.test(name)))];
  const nonDependencyNames = names.filter(name => !DEPENDENCY_NAME.test(name));
  const unconditional = resolution.issues.find(issue => !issue.conditional);
  if (unconditional) return { unknown: unconditional.reason };
  const conditional = resolution.issues.find(issue => issue.conditional);
  if (conditional && dependencyNames.length > 0) return { unknown: conditional.reason };
  if (dependencyNames.length > 1 || (dependencyNames.length === 1 && nonDependencyNames.length > 0)) {
    return { unknown: `Constructor alias "${current.getText()}" has ambiguous values` };
  }
  if (dependencyNames.length === 1) return { name: dependencyNames[0] };
  if (ts.isIdentifier(current)) return { name: current.text };
  if (ts.isPropertyAccessExpression(current)) return { name: current.name.text };
  if (ts.isElementAccessExpression(current)) {
    return { name: moduleText(current.argumentExpression) ?? current.getText() };
  }
  return { name: current.getText() };
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
        else if (target.unknown) {
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
