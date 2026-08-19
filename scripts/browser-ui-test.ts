// File: scripts/browser-ui-test.ts
import { chromium } from 'playwright';
import { fork, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK_HOST = '127.0.0.1';
const SERVER_START_TIMEOUT_MS = 15_000;
const SERVER_STOP_TIMEOUT_MS = 3_000;
const SERVER_KILL_TIMEOUT_MS = 2_000;

export interface BrowserUiRunOptions {
  forceFailureAfterReady?: boolean;
  lifecycleOnly?: boolean;
}

export interface BrowserUiRunSummary {
  port: number;
  dbPath: string;
  serverPid: number | undefined;
  serverExitCode: number | null;
  serverSignal: NodeJS.Signals | null;
}

export class BrowserUiTestRunError extends Error {
  constructor(
    message: string,
    readonly summary: BrowserUiRunSummary,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BrowserUiTestRunError';
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function browserDbFiles(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

function removeDbFiles(dbPath: string) {
  const errors: unknown[] = [];
  for (const f of browserDbFiles(dbPath)) {
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to remove isolated browser database files for ${dbPath}`);
  }
}

async function reserveAvailablePort(): Promise<number> {
  const reservation = net.createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, LOOPBACK_HOST, () => resolve());
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') {
    reservation.close();
    throw new Error('Failed to allocate an isolated browser E2E port');
  }
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForOwnedServer(
  child: ChildProcess,
  url: string,
  ownershipMarker: string,
  getChildOutput: () => string,
  timeoutMs = SERVER_START_TIMEOUT_MS,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !getChildOutput().includes(ownershipMarker)) {
    if (childHasExited(child)) {
      throw new Error(
        `Isolated browser server exited before claiming its port (code=${child.exitCode}, signal=${child.signalCode}).\n${getChildOutput()}`,
      );
    }
    await sleep(25);
  }
  if (!getChildOutput().includes(ownershipMarker)) {
    throw new Error(`Isolated browser server did not emit its ownership marker within ${timeoutMs}ms.\n${getChildOutput()}`);
  }

  while (Date.now() - start < timeoutMs) {
    if (childHasExited(child)) {
      throw new Error(
        `Isolated browser server exited before health readiness (code=${child.exitCode}, signal=${child.signalCode}).\n${getChildOutput()}`,
      );
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        await res.text();
        return;
      }
    } catch {}
    await sleep(300);
  }
  throw new Error(`Server failed to start at ${url} within ${timeoutMs}ms`);
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return true;
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    // Close the small gap between the caller's first status check and listener
    // installation so a very fast child exit cannot consume the whole timeout.
    if (childHasExited(child)) {
      child.off('exit', onExit);
      clearTimeout(timer);
      resolve(true);
    }
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, SERVER_STOP_TIMEOUT_MS)) return;

  child.kill('SIGKILL');
  if (await waitForChildExit(child, SERVER_KILL_TIMEOUT_MS)) return;
  throw new Error(`Isolated browser server PID ${child.pid ?? 'unknown'} did not exit after SIGTERM/SIGKILL`);
}

export async function runBrowserUiTest(options: BrowserUiRunOptions = {}): Promise<BrowserUiRunSummary> {
  const testPort = await reserveAvailablePort();
  const testDbPath = path.join(
    process.cwd(),
    'data',
    `e2e-browser-${Date.now()}-${process.pid}-${randomUUID()}.db`,
  );
  const appUrl = `http://${LOOPBACK_HOST}:${testPort}`;

  console.log('===========================================================');
  console.log('   STARTING ISOLATED BROWSER E2E TEST (Temp DB File Mode)');
  console.log('   Target URL: ' + appUrl);
  console.log('   Test DB File: ' + testDbPath);
  console.log('===========================================================\n');

  removeDbFiles(testDbPath);

  console.log(`[Server Setup] Starting isolated Muster server process on port ${testPort}...`);
  const serverProcess: ChildProcess = fork(path.join(process.cwd(), 'dist', 'index.js'), [], {
    env: {
      ...process.env,
      MUSTER_PORT: String(testPort),
      MUSTER_HOST: LOOPBACK_HOST,
      MUSTER_DB_PATH: testDbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  let childOutput = '';
  const captureOutput = (data: Buffer) => {
    childOutput = `${childOutput}${data.toString()}`.slice(-32_768);
  };
  serverProcess.stdout?.on('data', captureOutput);
  serverProcess.stderr?.on('data', captureOutput);

  let browser: any = null;
  let page: any = null;
  let runFailure: unknown;
  let cleanupFailure: unknown;
  try {
    // Require the child process itself to claim the dynamically allocated port
    // before accepting health. A stale or unrelated listener can never satisfy
    // this ownership marker, and an early child exit rejects immediately.
    console.log('[Server Setup] Waiting for health endpoint readiness...');
    await waitForOwnedServer(
      serverProcess,
      `${appUrl}/api/v1/health`,
      `REST API: http://${LOOPBACK_HOST}:${testPort}/api/v1`,
      () => childOutput,
    );
    console.log('  ✓ Test server online and healthy!\n');

    if (options.forceFailureAfterReady) {
      throw new Error('Intentional browser E2E failure after owned-server readiness');
    }

    if (options.lifecycleOnly) {
      console.log('  ✓ Isolated browser server lifecycle completed without launching Playwright.');
    } else {
      browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();

    page.on('dialog', async (dialog) => {
      console.log(`  [Dialog] ${dialog.type()}: ${dialog.message()}`);
      await dialog.accept();
    });
    // Step 1: Load Web UI
    console.log('[1/8] Loading Web UI...');
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('header', { timeout: 10000 });
    const pageTitle = await page.title();
    console.log(`  ✓ Web UI Loaded! Title: "${pageTitle}"`);

    // Verify main brand heading
    const headerTitle = await page.locator('header').textContent();
    if (!headerTitle?.includes('Muster')) {
      throw new Error('Header title not found');
    }
    console.log('  ✓ Header rendered correctly.');

    // Establish an open-mode browser identity so the comment controls can be
    // exercised as the comment author rather than skipped on an empty DB.
    const setName = page.getByRole('button', { name: /Set Name|Who are you/i });
    if (await setName.isVisible()) {
      await setName.click();
      const nameInput = page.locator('input[placeholder="Your display name"], input[placeholder="Your name"]');
      if (await nameInput.isVisible()) {
        await nameInput.fill('Browser UI Tester');
        const [identityResponse] = await Promise.all([
          page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/local')),
          page.getByRole('button', { name: 'Save / Switch Name', exact: true }).click(),
        ]);
        if (!identityResponse.ok()) {
          throw new Error(`Local identity request failed (${identityResponse.status()}): ${await identityResponse.text()}`);
        }
        await page.waitForSelector('text=Browser UI Tester');
        console.log('  ✓ Open-mode browser identity established.');
      }
    }

    // Step 2: Create New Project via Modal
    console.log('\n[2/8] Testing Project Creation Modal (+ Project)...');
    await page.click('button:has-text("+ Project")');
    await page.waitForSelector('text=Create New Project');

    await page.fill('input[placeholder*="Collaborative Platform"]', 'E2E Isolated Test Project');
    await page.fill('textarea[placeholder*="Project goals"]', 'Automated test project created via Playwright');
    await page.click('button[type="submit"]:has-text("Create Project")');
    await page.waitForSelector('text=Create New Project', { state: 'detached' });
    console.log('  ✓ Project created and modal closed cleanly.');

    // Verify dropdown updated
    await page.waitForTimeout(500);
    const selectedProject = await page.locator('select').first().inputValue();
    console.log(`  ✓ Active Selected Project ID: ${selectedProject}`);

    // Create a second board and verify that selecting it survives the
    // three-second polling refresh. The default board uses five lanes while
    // this one uses three, so the missing Backlog lane proves its data loaded.
    const boardSelector = page.getByLabel('Select board');
    await boardSelector.selectOption('__NEW_BOARD__');
    const newBoardHeading = page.getByRole('heading', { name: 'Create New Board', exact: true });
    await newBoardHeading.waitFor();
    await page.fill('input[placeholder*="Sprint 2"]', 'Release Board');
    await page.click('button[type="submit"]:has-text("Create Board")');
    await newBoardHeading.waitFor({ state: 'detached' });

    await boardSelector.selectOption({ label: 'Release Board' });
    await page.waitForSelector('h3:has-text("BACKLOG")', { state: 'detached' });
    await page.waitForSelector('h3:has-text("TO DO")');
    const boardUrl = new URL(page.url());
    if (!boardUrl.pathname.endsWith('/board/release-board')) {
      throw new Error(`Selected board is not reflected in URL: ${boardUrl.pathname}`);
    }
    await page.waitForTimeout(3500);
    const selectedBoardName = await boardSelector.locator('option:checked').textContent();
    if (selectedBoardName !== 'Release Board') {
      throw new Error(`Board selection reset after polling refresh: ${selectedBoardName}`);
    }
    if (!new URL(page.url()).pathname.endsWith('/board/release-board')) {
      throw new Error(`Board URL changed during polling: ${new URL(page.url()).pathname}`);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h3:has-text("TO DO")');
    await boardSelector.waitFor();
    const reloadedBoardName = await boardSelector.locator('option:checked').textContent();
    if (reloadedBoardName !== 'Release Board') {
      throw new Error(`Board selection was not restored from URL after reload: ${reloadedBoardName}`);
    }
    if (!new URL(page.url()).pathname.endsWith('/board/release-board')) {
      throw new Error(`Board URL changed after reload: ${new URL(page.url()).pathname}`);
    }
    console.log('  ✓ Additional board selected and preserved across background refresh.');

    // Step 3: Test Board View & Column Creation
    console.log('\n[3/8] Testing Kanban Board & Column Creation (+ Add Column)...');
    await page.getByTitle('Board Settings').click();
    await page.getByRole('button', { name: 'Add New Column', exact: true }).click();
    await page.waitForSelector('text=Column Name');

    await page.fill('input[placeholder*="In Testing"]', 'Quality Assurance');
    await page.fill('input[placeholder*="leave empty"]', '3');
    await page.click('button[type="submit"]:has-text("Add Column")');
    await page.waitForSelector('h3:has-text("QUALITY ASSURANCE")');
    console.log('  ✓ Custom column "QUALITY ASSURANCE" rendered on the board.');

    // Step 4: Create Card
    console.log('\n[4/8] Testing Card Creation (+ Add Card / + Card)...');
    await page.getByTitle('Add card to column').first().click();
    await page.waitForSelector('text=Create Card');

    const cardForm = page.locator('form').filter({ hasText: 'Task Title' });
    await cardForm.locator('input[type="text"]').fill('Implement Playwright E2E UI Tests');
    await cardForm.locator('select').nth(1).selectOption('high');
    await cardForm.locator('textarea').fill('Verify DOM interaction and full feature parity.');
    await cardForm.locator('button[type="submit"]').click();
    await page.waitForSelector('h4:has-text("Implement Playwright E2E UI Tests")');
    console.log('  ✓ Card rendered on board with HIGH priority badge.');

    // Card creation opens the new card's details modal; close it before reopening
    // the card from the board for the detail-flow assertions below.
    await page.click('button[title="Close Task"]', { force: true });
    await page.waitForSelector('button[title="Close Task"]', { state: 'detached' });

    // Step 5: Card Modal, Assignment & Comments
    console.log('\n[5/8] Testing Card Details Modal, Assignment & Comments...');
    await page.click('h4:has-text("Implement Playwright E2E UI Tests")');
    await page.waitForSelector('text=Comments');

    // Assign and remove an agent from the card.
    const assigneeSelect = page.locator('select:has-text("Select Agent...")');
    const assigneeOptions = await assigneeSelect.locator('option').allInnerTexts();
    if (assigneeOptions.length > 1) {
      await assigneeSelect.selectOption({ index: 1 });
      await page.click('button:has-text("Assign")');
      const removeAssigneeButton = page.getByRole('button', {
        name: `Remove ${assigneeOptions[1]} from card`,
      });
      await removeAssigneeButton.waitFor();
      await removeAssigneeButton.click();
      await page.waitForSelector('text=Unassigned');
      console.log('  ✓ Agent assigned and removed from the card.');

      // Leave the card assigned so the board-tile summary can be verified.
      await assigneeSelect.selectOption({ index: 1 });
      await page.click('button:has-text("Assign")');
      await removeAssigneeButton.waitFor();
    }

    // Add comment
    const authorSelect = page.locator('form:has(textarea[placeholder*="Add comment"]) select');
    if (await authorSelect.isVisible()) {
      const firstValidOption = authorSelect.locator('option:not([value=""])').first();
      if (await firstValidOption.count() > 0) {
        const val = await firstValidOption.getAttribute('value');
        if (val) await authorSelect.selectOption(val);
      }
    }
    await page.fill('textarea[placeholder*="Add comment"]', 'Verified browser UI functionality.');
    await page.click('button[type="submit"]:has-text("Comment")');
    await page.waitForSelector('text=Verified browser UI functionality.');
    console.log('  ✓ Comment posted and rendered in modal.');

    await page.getByRole('button', { name: 'Edit comment' }).click();
    await page.locator('textarea:not([placeholder])').fill('Edited browser UI functionality.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForSelector('text=Edited browser UI functionality.');
    await page.waitForSelector('text=Verified browser UI functionality.', { state: 'detached' });
    console.log('  ✓ Comment edited and refreshed in modal.');

    await page.getByRole('button', { name: 'Delete comment' }).click();
    await page.waitForSelector('text=Edited browser UI functionality.', { state: 'detached' });
    console.log('  ✓ Comment deleted and refreshed in modal.');

    // Close card modal
    // Assignment/comment actions refresh board data asynchronously. Let the
    // final refresh settle so the close click cannot land on a transient node.
    await page.waitForTimeout(500);
    await page.click('button[title="Close Task"]', { force: true });
    await page.waitForSelector('.muster-scrim', { state: 'detached' });
    console.log('  ✓ Card details modal closed.');

    if (assigneeOptions.length > 1) {
      const boardCard = page.locator('[data-rfd-draggable-id]').filter({
        hasText: 'Implement Playwright E2E UI Tests',
      });
      await boardCard.getByText(assigneeOptions[1], { exact: true }).waitFor();
      await boardCard.locator('[data-agent-status="active"]').waitFor();
      console.log('  ✓ Assigned agent and active-status indicator rendered on the board card.');
    }

    // Step 6: Agent Management View & Agent Removal
    console.log('\n[6/8] Testing Agents View, Registration & Removal (+ Agent)...');
    await page.click('button:has-text("Agents")');
    await page.waitForSelector('text=Registered Agents');

    await page.click('button:has-text("+ User"), button:has-text("Register Agent")');
    await page.waitForSelector('text=Register Agent');

    await page.fill('input[placeholder*="my-agent"]', 'Browser-Testing-Bot');
    await page.fill('input[placeholder*="code, testing"]', 'testing');
    await page.click('button[type="submit"]:has-text("Add User")');
    await page.locator('h3').filter({ hasText: 'Browser-Testing-Bot' }).waitFor();
    console.log('  ✓ New agent "Browser-Testing-Bot" registered and displayed in grid.');

    // Heartbeat test
    const heartbeatBtn = page.locator('button:has-text("Ping")').first();
    if (await heartbeatBtn.isVisible()) {
      await heartbeatBtn.click();
      console.log('  ✓ Agent heartbeat triggered successfully.');
    }

    await page.waitForTimeout(500);

    // Step 7: Design Document Vault
    console.log('\n[7/8] Testing Design Documents View (+ Doc & Approval Workflow)...');
    await page.click('button:has-text("Design Documents")');
    await page.waitForSelector('text=Design Documents');

    await page.getByRole('button', { name: 'Create Document', exact: true }).first().click();
    await page.waitForSelector('text=Create Design Document');

    await page.fill('input[placeholder*="Architecture Overview"]', 'Frontend UI Architecture & E2E Verification');
    await page.fill('textarea', '# Frontend Specification\n\n- React 19 SPA\n- Lucide Icons\n- Tailwind CSS');
    await page.click('button[type="submit"]:has-text("Create Document")');
    await page.waitForSelector('h2:has-text("Frontend UI Architecture & E2E Verification")');
    console.log('  ✓ Document created and rendered with Markdown preview.');

    // Workflow status progression
    await page.click('button:has-text("Submit for Review")');
    await page.waitForSelector('text=In Review');
    console.log('  ✓ Status transitioned: Draft → In Review');

    await page.click('button:has-text("Approve")');
    await page.waitForSelector('text=Approved');
    console.log('  ✓ Status transitioned: In Review → Approved');

    // Step 8: Real-Time Activity Log
    console.log('\n[8/8] Testing Activity Log View (Real-Time Feed)...');
    await page.click('button:has-text("Activity Log")');
    await page.waitForSelector('text=events');
    console.log('  ✓ Activity Log rendered cleanly.');

    console.log('\n===========================================================');
    console.log('   🎉 ALL BROWSER E2E USER TESTS PASSED 100%!');
    console.log('===========================================================\n');
    }
  } catch (err) {
    runFailure = err;
    if (page) {
      await page.screenshot({ path: 'scratch/ui-error-screenshot.png' }).catch(() => {});
    }
  } finally {
    const cleanupErrors: unknown[] = [];
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    // The database must not be unlinked while its child still owns WAL/SHM
    // handles. Await graceful shutdown, escalate with a bounded SIGKILL, then
    // remove only the unique paths allocated for this run.
    try {
      await terminateChild(serverProcess);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (childHasExited(serverProcess)) {
      try {
        removeDbFiles(testDbPath);
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      cleanupErrors.push(
        new Error(
          `Retained ${testDbPath} because server PID ${serverProcess.pid ?? 'unknown'} is still alive`,
        ),
      );
    }
    if (cleanupErrors.length > 0) {
      cleanupFailure = new AggregateError(cleanupErrors, 'Browser E2E cleanup failed');
    }
    if (childHasExited(serverProcess)) {
      console.log(`  🧹 Deleted temporary test database files (${path.basename(testDbPath)}*).`);
    } else {
      console.error(`  ⚠ Retained temporary database files for live server PID ${serverProcess.pid}.`);
    }
  }

  const summary: BrowserUiRunSummary = {
    port: testPort,
    dbPath: testDbPath,
    serverPid: serverProcess.pid,
    serverExitCode: serverProcess.exitCode,
    serverSignal: serverProcess.signalCode,
  };
  if (runFailure || cleanupFailure) {
    const cause =
      runFailure && cleanupFailure
        ? new AggregateError([runFailure, cleanupFailure])
        : runFailure ?? cleanupFailure;
    throw new BrowserUiTestRunError('Browser UI E2E run failed', summary, { cause });
  }
  return summary;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runBrowserUiTest({
    forceFailureAfterReady: process.env.MUSTER_BROWSER_E2E_FORCE_FAILURE === 'after-server-ready',
    lifecycleOnly: process.env.MUSTER_BROWSER_E2E_LIFECYCLE_ONLY === '1',
  }).catch((error) => {
    console.error('\n❌ Browser UI Test Error:', error.cause ?? error);
    process.exitCode = 1;
  });
}
