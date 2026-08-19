import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const manifestPath = path.join(root, 'public', '.vite', 'manifest.json');
const budgetPath = path.join(root, 'config', 'frontend-bundle-budget.json');
const reportOnly = process.argv.includes('--report-only');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path.relative(root, filePath)}: ${error.message}`);
  }
}

const manifest = readJson(manifestPath, 'Vite manifest');
const budget = readJson(budgetPath, 'frontend bundle budget');
const records = Object.entries(manifest);
const entryRecord = records.find(([, record]) => record.isEntry && record.file.endsWith('.js'));

function assertLimits(label, limits) {
  for (const key of ['maxBytes', 'maxGzipBytes']) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] <= 0) {
      throw new Error(`${label}.${key} must be a positive integer`);
    }
  }
}

assertLimits('initialEntry', budget.initialEntry);
assertLimits('initialRoute', budget.initialRoute);
assertLimits('defaultChunk', budget.defaultChunk);
if (!Array.isArray(budget.initialRoute.sources) || budget.initialRoute.sources.length === 0) {
  throw new Error('initialRoute.sources must contain at least one manifest-source suffix');
}
for (const [name, override] of Object.entries(budget.chunkOverrides ?? {})) {
  assertLimits(`chunkOverrides.${name}`, override);
  if (typeof override.reason !== 'string' || override.reason.trim() === '') {
    throw new Error(`chunkOverrides.${name}.reason must document why the exception exists`);
  }
}

if (!entryRecord) {
  throw new Error('Vite manifest does not contain a JavaScript entry chunk');
}

const assetSize = (file) => {
  const contents = fs.readFileSync(path.join(root, 'public', file));
  return { bytes: contents.byteLength, gzipBytes: gzipSync(contents, { level: 9 }).byteLength };
};

const jsRecords = records
  .filter(([, record]) => record.file.endsWith('.js'))
  .map(([source, record]) => ({ source, ...record, ...assetSize(record.file) }))
  .sort((left, right) => left.file.localeCompare(right.file));

const bySource = new Map(jsRecords.map((record) => [record.source, record]));
const byFile = new Map(jsRecords.map((record) => [record.file, record]));

function staticClosure(seedSources) {
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
}

function sum(recordsToSum) {
  return recordsToSum.reduce(
    (total, record) => ({ bytes: total.bytes + record.bytes, gzipBytes: total.gzipBytes + record.gzipBytes }),
    { bytes: 0, gzipBytes: 0 },
  );
}

function format(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

const [entrySource] = entryRecord;
const initialEntry = staticClosure([entrySource]);
const initialRouteSources = budget.initialRoute.sources.map((suffix) => {
  const match = jsRecords.find((record) => record.source.endsWith(suffix));
  if (!match) throw new Error(`Initial-route source ending in ${suffix} is missing from the Vite manifest`);
  return match.source;
});
const initialRoute = staticClosure([entrySource, ...initialRouteSources]);

const failures = [];
const matchedOverrides = new Set();
function enforce(label, actual, limits) {
  if (actual.bytes > limits.maxBytes) {
    failures.push(`${label}: ${format(actual.bytes)} exceeds ${format(limits.maxBytes)} minified`);
  }
  if (actual.gzipBytes > limits.maxGzipBytes) {
    failures.push(`${label}: ${format(actual.gzipBytes)} exceeds ${format(limits.maxGzipBytes)} gzip`);
  }
}

enforce('initial entry', sum(initialEntry), budget.initialEntry);
enforce('default board startup', sum(initialRoute), budget.initialRoute);

for (const record of jsRecords) {
  const override = Object.entries(budget.chunkOverrides).find(([prefix]) =>
    path.basename(record.file).startsWith(`${prefix}-`),
  );
  if (override) matchedOverrides.add(override[0]);
  enforce(`chunk ${record.file}`, record, override?.[1] ?? budget.defaultChunk);
}
for (const overrideName of Object.keys(budget.chunkOverrides ?? {})) {
  if (!matchedOverrides.has(overrideName)) {
    failures.push(`configured chunk exception ${overrideName} did not match a generated chunk`);
  }
}

console.log('Frontend bundle report (minified / gzip)');
console.log(`  Initial entry: ${format(sum(initialEntry).bytes)} / ${format(sum(initialEntry).gzipBytes)}`);
console.log(`  Default board startup: ${format(sum(initialRoute).bytes)} / ${format(sum(initialRoute).gzipBytes)}`);
for (const record of [...jsRecords].sort((left, right) => right.bytes - left.bytes)) {
  const marker = byFile.get(record.file) === bySource.get(entrySource) ? ' [entry]' : '';
  console.log(`  ${record.file}: ${format(record.bytes)} / ${format(record.gzipBytes)}${marker}`);
}

if (failures.length > 0) {
  console.error('\nFrontend bundle budget exceeded:');
  for (const failure of failures) console.error(`  - ${failure}`);
  if (!reportOnly) process.exitCode = 1;
} else {
  console.log('\nFrontend bundle budget passed.');
}
