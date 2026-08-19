import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {
  browserDbFiles,
  BrowserUiRunSummary,
  BrowserUiTestRunError,
  runBrowserUiTest,
} from './browser-ui-test.js';

async function assertPortClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out proving browser E2E port ${port} was closed`));
    }, 1_500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`Browser E2E listener remained active on port ${port}`));
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assertProcessExited(pid: number | undefined): void {
  assert.ok(pid, 'Browser E2E server did not expose a PID');
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  assert.fail(`Browser E2E server PID ${pid} remained alive after cleanup`);
}

async function assertRunClean(summary: BrowserUiRunSummary): Promise<void> {
  assert.ok(
    summary.serverExitCode !== null || summary.serverSignal !== null,
    'Browser E2E server did not report an exit status',
  );
  assertProcessExited(summary.serverPid);
  await assertPortClosed(summary.port);
  for (const file of browserDbFiles(summary.dbPath)) {
    assert.equal(fs.existsSync(file), false, `Browser E2E sidecar remained after cleanup: ${file}`);
  }
}

async function main() {
  let failedRun: BrowserUiRunSummary | undefined;
  try {
    await runBrowserUiTest({ forceFailureAfterReady: true });
    assert.fail('Forced browser E2E failure unexpectedly succeeded');
  } catch (error) {
    assert.ok(
      error instanceof BrowserUiTestRunError,
      `Unexpected forced-failure result: ${String(error)}`,
    );
    failedRun = error.summary;
  }

  await assertRunClean(failedRun!);
  console.log('  ✓ Forced failure left no child process, listener, database, WAL, or SHM file.');

  const nextRun = await runBrowserUiTest({ lifecycleOnly: true });
  await assertRunClean(nextRun);
  console.log(
    '  ✓ The immediately subsequent isolated server lifecycle started and cleaned up successfully.',
  );
}

main().catch((error) => {
  console.error('❌ Browser E2E cleanup regression failed:', error);
  process.exitCode = 1;
});
