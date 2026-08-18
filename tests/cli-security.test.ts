import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('MUS-71 CLI secret and process isolation', () => {
  it('rejects argv token input, redacts its value, and exits only the child process', () => {
    const secret = 'muster_pat_should_never_be_logged';
    const result = spawnSync(
      path.resolve('node_modules/.bin/tsx'),
      ['src/cli.ts', 'login', '--server', 'https://muster.example.com', '--token', secret],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain('Unknown option "--token"');
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });
});
