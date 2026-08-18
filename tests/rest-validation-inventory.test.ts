import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const routesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'api', 'routes');
const routeFiles = fs.readdirSync(routesDir)
  .filter(file => file.endsWith('.routes.ts'))
  .sort();

describe('REST route validation inventory', () => {
  it('keeps every route, including mutations, behind validateRequest()', () => {
    const missing: string[] = [];
    let routeCount = 0;
    let mutationCount = 0;

    for (const file of routeFiles) {
      const lines = fs.readFileSync(path.join(routesDir, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        const match = line.match(/^\s*router\.(get|post|put|patch|delete)\s*\(/);
        if (!match) return;
        routeCount += 1;
        if (['post', 'put', 'patch', 'delete'].includes(match[1])) mutationCount += 1;
        if (!line.includes('validateRequest(')) missing.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }

    expect(routeCount).toBeGreaterThan(0);
    expect(mutationCount).toBeGreaterThan(0);
    expect(missing, `Unvalidated REST route declarations:\n${missing.join('\n')}`).toEqual([]);
  });
});
