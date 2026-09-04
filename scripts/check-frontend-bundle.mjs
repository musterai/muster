import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

function assertLimits(label, limits) {
  for (const key of ['maxBytes', 'maxGzipBytes']) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] <= 0) {
      throw new Error(`${label}.${key} must be a positive integer`);
    }
  }
}

function assertStringArray(label, values, { allowEmpty = false } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  if (values.some((value) => typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`${label} must contain only non-empty strings`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
}

function canonicalRelativePath(label, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`${label} must be a canonical relative POSIX path: ${value}`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`${label} contains an invalid path escape: ${value}`);
  }
  if (decoded !== value) {
    throw new Error(`${label} must not contain escaped path characters: ${value}`);
  }
  if (path.posix.normalize(value) !== value || value.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`${label} must not contain non-canonical or traversal segments: ${value}`);
  }
  return value;
}

function canonicalModulePrefix(label, prefix) {
  if (typeof prefix !== 'string' || !prefix.endsWith('/')) {
    throw new Error(`${label} must be a canonical directory prefix ending in /`);
  }
  canonicalRelativePath(label, prefix.slice(0, -1));
  return prefix;
}

function assertBudget(budget) {
  assertLimits('initialEntry', budget.initialEntry);
  assertLimits('initialRoute', budget.initialRoute);
  assertLimits('defaultChunk', budget.defaultChunk);
  assertStringArray('initialRoute.sources', budget.initialRoute?.sources);
  const overrides = budget.chunkOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('chunkOverrides must be an object');
  }
  for (const [policyName, override] of Object.entries(overrides)) {
    assertLimits(`chunkOverrides.${policyName}`, override);
    if (typeof override.chunkName !== 'string' || override.chunkName.trim() === '') {
      throw new Error(`chunkOverrides.${policyName}.chunkName must be a non-empty string`);
    }
    if (typeof override.reason !== 'string' || override.reason.trim() === '') {
      throw new Error(`chunkOverrides.${policyName}.reason must document why the exception exists`);
    }
    assertStringArray(`chunkOverrides.${policyName}.allowedModulePrefixes`, override.allowedModulePrefixes);
    assertStringArray(`chunkOverrides.${policyName}.requiredModulePrefixes`, override.requiredModulePrefixes);
    assertStringArray(`chunkOverrides.${policyName}.allowedImporterFacades`, override.allowedImporterFacades);
    override.allowedModulePrefixes.forEach((prefix, index) =>
      canonicalModulePrefix(`chunkOverrides.${policyName}.allowedModulePrefixes[${index}]`, prefix),
    );
    override.requiredModulePrefixes.forEach((prefix, index) =>
      canonicalModulePrefix(`chunkOverrides.${policyName}.requiredModulePrefixes[${index}]`, prefix),
    );
    override.allowedImporterFacades.forEach((facade, index) =>
      canonicalRelativePath(`chunkOverrides.${policyName}.allowedImporterFacades[${index}]`, facade),
    );
    for (const prefix of override.requiredModulePrefixes) {
      if (!override.allowedModulePrefixes.includes(prefix)) {
        throw new Error(`chunkOverrides.${policyName}.requiredModulePrefixes contains non-allowed prefix ${prefix}`);
      }
    }
  }
}

function assertMetadata(metadata) {
  if (metadata?.version !== 1 || !Array.isArray(metadata.chunks)) {
    throw new Error('bundle metadata must have version 1 and a chunks array');
  }
  for (const [index, chunk] of metadata.chunks.entries()) {
    const label = `bundle metadata chunk ${index}`;
    if (typeof chunk.file !== 'string' || !chunk.file.endsWith('.js')) {
      throw new Error(`${label}.file must identify a JavaScript asset`);
    }
    if (typeof chunk.name !== 'string' || chunk.name.trim() === '') {
      throw new Error(`${label}.name must be a non-empty string`);
    }
    if (chunk.facadeModuleId !== null && typeof chunk.facadeModuleId !== 'string') {
      throw new Error(`${label}.facadeModuleId must be a string or null`);
    }
    if (chunk.facadeModuleId !== null) canonicalRelativePath(`${label}.facadeModuleId`, chunk.facadeModuleId);
    assertStringArray(`${label}.moduleIds`, chunk.moduleIds);
    assertStringArray(`${label}.imports`, chunk.imports, { allowEmpty: true });
    assertStringArray(`${label}.dynamicImports`, chunk.dynamicImports, { allowEmpty: true });
    if (typeof chunk.isEntry !== 'boolean' || typeof chunk.isDynamicEntry !== 'boolean') {
      throw new Error(`${label} must declare boolean isEntry and isDynamicEntry flags`);
    }
    canonicalRelativePath(`${label}.file`, chunk.file);
    chunk.imports.forEach((file, edgeIndex) => canonicalRelativePath(`${label}.imports[${edgeIndex}]`, file));
    chunk.dynamicImports.forEach((file, edgeIndex) =>
      canonicalRelativePath(`${label}.dynamicImports[${edgeIndex}]`, file),
    );
  }
}

function uniqueByFile(records, label) {
  const byFile = new Map();
  for (const record of records) {
    if (byFile.has(record.file)) throw new Error(`${label} maps ${record.file} more than once`);
    byFile.set(record.file, record);
  }
  return byFile;
}

function format(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function sum(records) {
  return records.reduce(
    (total, record) => ({ bytes: total.bytes + record.bytes, gzipBytes: total.gzipBytes + record.gzipBytes }),
    { bytes: 0, gzipBytes: 0 },
  );
}

/**
 * The manifest proves source-to-file reachability. Rollup metadata proves
 * module membership and importers. A filename or hash never grants an
 * exception by itself.
 */
export function checkBundleBudget({ manifest, metadata, budget, sizeOf }) {
  assertBudget(budget);
  assertMetadata(metadata);

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Vite manifest must be an object');
  }

  const manifestRecords = Object.entries(manifest).map(([source, record]) => {
    if (source.trim() === '' || !record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Vite manifest source ${source || '<empty>'} must map to an object`);
    }
    for (const edgeType of ['imports', 'dynamicImports']) {
      if (record[edgeType] !== undefined) {
        assertStringArray(`Vite manifest ${source}.${edgeType}`, record[edgeType], { allowEmpty: true });
      }
    }
    if (record.src !== undefined) {
      // Vite's root is src/web, so dependency font asset identifiers are
      // relative to that root. They are provenance labels, never paths read
      // from disk. Output filenames and all JavaScript sources stay strict.
      const dependencyFont = typeof record.file === 'string' && record.file.endsWith('.woff2')
        && typeof record.src === 'string' && record.src.startsWith('../../node_modules/');
      canonicalRelativePath(`Vite manifest ${source}.src`, dependencyFont ? record.src.slice(6) : record.src);
      if (record.src !== source) {
        throw new Error(`Vite manifest source ${source} must equal its normalized src ${record.src}`);
      }
    }
    if (record.isEntry !== undefined && typeof record.isEntry !== 'boolean') {
      throw new Error(`Vite manifest ${source}.isEntry must be a boolean`);
    }
    if (record.isDynamicEntry !== undefined && typeof record.isDynamicEntry !== 'boolean') {
      throw new Error(`Vite manifest ${source}.isDynamicEntry must be a boolean`);
    }
    if (typeof record.file === 'string') canonicalRelativePath(`Vite manifest ${source}.file`, record.file);
    return { source, ...record };
  });
  const manifestFiles = manifestRecords.filter((record) => typeof record.file === 'string');
  uniqueByFile(manifestFiles, 'Vite manifest');
  const jsRecords = manifestFiles
    .filter((record) => record.file.endsWith('.js'))
    .map((record) => ({ ...record, ...sizeOf(record.file) }))
    .sort((left, right) => left.file.localeCompare(right.file));
  const manifestByFile = uniqueByFile(jsRecords, 'Vite JavaScript manifest');
  const metadataByFile = uniqueByFile(metadata.chunks, 'Rollup bundle metadata');

  if (JSON.stringify([...manifestByFile.keys()].sort()) !== JSON.stringify([...metadataByFile.keys()].sort())) {
    throw new Error('Vite JavaScript manifest files must exactly match Rollup bundle metadata files');
  }

  const metadataByFacade = new Map();
  for (const chunk of metadata.chunks) {
    if (chunk.facadeModuleId === null) continue;
    if (metadataByFacade.has(chunk.facadeModuleId)) {
      throw new Error(`Rollup facade ${chunk.facadeModuleId} maps to more than one output file`);
    }
    metadataByFacade.set(chunk.facadeModuleId, chunk);
  }

  const bySource = new Map(jsRecords.map((record) => [record.source, record]));
  for (const record of jsRecords) {
    const chunk = metadataByFile.get(record.file);
    if (Boolean(record.isEntry) !== chunk.isEntry || Boolean(record.isDynamicEntry) !== chunk.isDynamicEntry) {
      throw new Error(`Vite and Rollup entry flags disagree for ${record.file}`);
    }
    if (record.src !== undefined && chunk.facadeModuleId !== record.src) {
      throw new Error(
        `Vite source ${record.src} and Rollup facade ${chunk.facadeModuleId ?? 'null'} disagree for ${record.file}`,
      );
    }
    if (record.src === undefined && chunk.facadeModuleId !== null) {
      throw new Error(`Rollup facade ${chunk.facadeModuleId} has no matching Vite source for ${record.file}`);
    }
  }
  for (const [facade, chunk] of metadataByFacade) {
    const record = bySource.get(facade);
    if (!record || record.src !== facade || record.file !== chunk.file) {
      throw new Error(`Rollup facade ${facade} must map to the same unique Vite source and output file`);
    }
  }

  const convertedEdges = (record, edgeType) =>
    (record[edgeType] ?? [])
      .map((importedSource) => {
        const imported = bySource.get(importedSource);
        if (!imported) {
          throw new Error(`Vite manifest ${record.source}.${edgeType} references missing JavaScript source ${importedSource}`);
        }
        return imported.file;
      })
      .sort();
  for (const record of jsRecords) {
    const chunk = metadataByFile.get(record.file);
    for (const edgeType of ['imports', 'dynamicImports']) {
      const manifestEdges = convertedEdges(record, edgeType);
      const rollupEdges = [...chunk[edgeType]].sort();
      if (JSON.stringify(manifestEdges) !== JSON.stringify(rollupEdges)) {
        throw new Error(
          `Vite and Rollup ${edgeType} disagree for ${record.file}: ` +
            `manifest has [${manifestEdges.join(', ')}], metadata has [${rollupEdges.join(', ')}]`,
        );
      }
    }
  }

  const entryRecords = jsRecords.filter((record) => record.isEntry);
  if (entryRecords.length !== 1) {
    throw new Error(`Vite manifest must contain exactly one JavaScript entry (found ${entryRecords.length})`);
  }

  const staticClosure = (seedSources) => {
    const seen = new Set();
    const visit = (source) => {
      if (seen.has(source)) return;
      const record = bySource.get(source);
      if (!record) throw new Error(`Budget source ${source} is missing from the Vite manifest`);
      seen.add(source);
      for (const importedSource of record.imports ?? []) visit(importedSource);
    };
    for (const source of seedSources) visit(source);
    return [...seen].map((source) => bySource.get(source));
  };

  const entryRecord = entryRecords[0];
  const initialEntry = staticClosure([entryRecord.source]);
  const initialRouteSources = budget.initialRoute.sources.map((suffix) => {
    const matches = jsRecords.filter((record) => record.source.endsWith(suffix));
    if (matches.length !== 1) {
      throw new Error(`Initial-route source ending in ${suffix} must match exactly once (found ${matches.length})`);
    }
    return matches[0].source;
  });
  const initialRoute = staticClosure([entryRecord.source, ...initialRouteSources]);
  const initialRouteFiles = new Set(initialRoute.map((record) => record.file));

  const failures = [];
  const exceptionByFile = new Map();
  for (const [policyName, override] of Object.entries(budget.chunkOverrides)) {
    const matchingChunks = metadata.chunks.filter((chunk) => chunk.name === override.chunkName);
    if (matchingChunks.length !== 1) {
      failures.push(`exception ${policyName} must match exactly one Rollup chunk named ${override.chunkName} (found ${matchingChunks.length})`);
      continue;
    }
    const chunk = matchingChunks[0];
    if (exceptionByFile.has(chunk.file)) {
      failures.push(`Rollup chunk ${chunk.file} is targeted by more than one exception`);
      continue;
    }
    exceptionByFile.set(chunk.file, { policyName, override });

    if (chunk.isEntry) failures.push(`exception ${policyName} must not target an entry chunk`);
    const canonicalModuleIds = [];
    for (const [index, moduleId] of chunk.moduleIds.entries()) {
      try {
        canonicalModuleIds.push(canonicalRelativePath(`exception ${policyName} moduleIds[${index}]`, moduleId));
      } catch (error) {
        failures.push(error.message);
      }
    }
    const unrelatedModules = canonicalModuleIds.filter(
      (moduleId) => !override.allowedModulePrefixes.some((prefix) => moduleId.startsWith(prefix)),
    );
    if (unrelatedModules.length > 0) {
      failures.push(`exception ${policyName} contains non-allowlisted modules: ${unrelatedModules.join(', ')}`);
    }
    for (const prefix of override.requiredModulePrefixes) {
      if (!canonicalModuleIds.some((moduleId) => moduleId.startsWith(prefix))) {
        failures.push(`exception ${policyName} is stale: required module prefix ${prefix} is absent`);
      }
    }

    const importers = metadata.chunks.filter((candidate) =>
      candidate.imports.includes(chunk.file) || candidate.dynamicImports.includes(chunk.file),
    );
    const importerFacades = importers.map((candidate) => candidate.facadeModuleId).sort();
    const allowedFacades = [...override.allowedImporterFacades].sort();
    if (JSON.stringify(importerFacades) !== JSON.stringify(allowedFacades)) {
      failures.push(
        `exception ${policyName} importers must be exactly ${allowedFacades.join(', ')} (found ${importerFacades.join(', ') || 'none'})`,
      );
    }
    if (initialRouteFiles.has(chunk.file)) {
      failures.push(`exception ${policyName} is reachable from the default startup route`);
    }
  }

  const enforce = (label, actual, limits) => {
    if (actual.bytes > limits.maxBytes) {
      failures.push(`${label}: ${format(actual.bytes)} exceeds ${format(limits.maxBytes)} minified`);
    }
    if (actual.gzipBytes > limits.maxGzipBytes) {
      failures.push(`${label}: ${format(actual.gzipBytes)} exceeds ${format(limits.maxGzipBytes)} gzip`);
    }
  };

  enforce('initial entry', sum(initialEntry), budget.initialEntry);
  enforce('default board startup', sum(initialRoute), budget.initialRoute);
  for (const record of jsRecords) {
    const exception = exceptionByFile.get(record.file);
    enforce(`chunk ${record.file}`, record, exception?.override ?? budget.defaultChunk);
  }

  return {
    failures,
    entryFile: entryRecord.file,
    initialEntry: sum(initialEntry),
    initialRoute: sum(initialRoute),
    chunks: [...jsRecords].sort((left, right) => right.bytes - left.bytes),
  };
}

export function formatBundleReport(result) {
  const lines = [
    'Frontend bundle report (minified / gzip)',
    `  Initial entry: ${format(result.initialEntry.bytes)} / ${format(result.initialEntry.gzipBytes)}`,
    `  Default board startup: ${format(result.initialRoute.bytes)} / ${format(result.initialRoute.gzipBytes)}`,
  ];
  for (const record of result.chunks) {
    lines.push(
      `  ${record.file}: ${format(record.bytes)} / ${format(record.gzipBytes)}${record.file === result.entryFile ? ' [entry]' : ''}`,
    );
  }
  return lines.join('\n');
}

function readJson(root, filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path.relative(root, filePath)}: ${error.message}`);
  }
}

function runCli() {
  const root = process.cwd();
  const manifest = readJson(root, path.join(root, 'public', '.vite', 'manifest.json'), 'Vite manifest');
  const metadata = readJson(root, path.join(root, 'public', '.vite', 'bundle-metadata.json'), 'Rollup bundle metadata');
  const budget = readJson(root, path.join(root, 'config', 'frontend-bundle-budget.json'), 'frontend bundle budget');
  const sizeOf = (file) => {
    const contents = fs.readFileSync(path.join(root, 'public', file));
    return { bytes: contents.byteLength, gzipBytes: gzipSync(contents, { level: 9 }).byteLength };
  };
  const result = checkBundleBudget({ manifest, metadata, budget, sizeOf });
  console.log(formatBundleReport(result));
  if (result.failures.length > 0) {
    console.error('\nFrontend bundle budget exceeded:');
    for (const failure of result.failures) console.error(`  - ${failure}`);
    if (!process.argv.includes('--report-only')) process.exitCode = 1;
  } else {
    console.log('\nFrontend bundle budget passed.');
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runCli();
