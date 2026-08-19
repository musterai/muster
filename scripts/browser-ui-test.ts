// File: scripts/browser-ui-test.ts
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fork, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLOR_PROFILES, type AppearanceMode } from '../src/web/theme.js';

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

async function assertAccessibleDialog(page: any, accessibleName: string | RegExp) {
  const dialog = page.getByRole('dialog', { name: accessibleName });
  try {
    await dialog.waitFor({ timeout: 5000 });
  } catch (error) {
    const rawDialogs = await page.locator('[role="dialog"]').evaluateAll((dialogs: HTMLElement[]) => dialogs.map((element) => ({
      labelledBy: element.getAttribute('aria-labelledby'),
      labelText: document.getElementById(element.getAttribute('aria-labelledby') || '')?.textContent,
      inert: Boolean(element.closest<HTMLElement>('.muster-scrim')?.inert),
      hidden: element.closest<HTMLElement>('.muster-scrim')?.getAttribute('aria-hidden'),
      focusInside: element.contains(document.activeElement),
    })));
    throw new Error(`Unable to locate accessible dialog "${accessibleName}"; raw state: ${JSON.stringify(rawDialogs)}; ${error}`);
  }
  const state = await dialog.evaluate((element: HTMLElement) => {
    const root = document.getElementById('root');
    return {
      ariaModal: element.getAttribute('aria-modal'),
      labelledBy: element.getAttribute('aria-labelledby'),
      focusInside: element.contains(document.activeElement),
      rootInert: Boolean(root?.inert),
      rootHidden: root?.getAttribute('aria-hidden'),
      bodyOverflow: document.body.style.overflow,
    };
  });
  if (state.ariaModal !== 'true' || !state.labelledBy) {
    throw new Error(`Dialog "${accessibleName}" is missing its modal name contract`);
  }
  if (!state.focusInside || !state.rootInert || state.rootHidden !== 'true' || state.bodyOverflow !== 'hidden') {
    throw new Error(`Dialog "${accessibleName}" did not isolate its background and initial focus`);
  }
  return dialog;
}

async function assertPendingDialogIsolation(page: any, label: string) {
  const status = page.getByRole('status').filter({ hasText: `Loading ${label}` });
  await status.waitFor();
  const state = await status.evaluate((element: HTMLElement) => {
    const root = document.getElementById('root');
    const scrim = element.closest<HTMLElement>('.muster-scrim');
    const dialog = element.closest<HTMLElement>('[role="dialog"]');
    return {
      rootInert: Boolean(root?.inert),
      rootHidden: root?.getAttribute('aria-hidden'),
      bodyOverflow: document.body.style.overflow,
      ariaModal: dialog?.getAttribute('aria-modal'),
      topInteractive: Boolean(scrim && !scrim.inert && scrim.getAttribute('aria-hidden') !== 'true'),
      focusInside: Boolean(scrim?.contains(document.activeElement)),
    };
  });
  if (
    !state.rootInert
    || state.rootHidden !== 'true'
    || state.bodyOverflow !== 'hidden'
    || state.ariaModal !== 'true'
    || !state.topInteractive
    || !state.focusInside
  ) {
    throw new Error(`Pending ${label} did not own the modal layer: ${JSON.stringify(state)}`);
  }
  return status;
}

async function assertNestedDialogIsolation(page: any, topDialog: any) {
  const state = await topDialog.evaluate((element: HTMLElement) => {
    const scrims = Array.from(document.querySelectorAll<HTMLElement>('.muster-scrim'));
    const topScrim = element.closest<HTMLElement>('.muster-scrim');
    const lowerLayers = scrims.filter((scrim) => scrim !== topScrim);
    return {
      dialogCount: document.querySelectorAll('[role="dialog"][aria-modal="true"]').length,
      lowerLayersIsolated: lowerLayers.every((scrim) => scrim.inert && scrim.getAttribute('aria-hidden') === 'true'),
      topLayerInteractive: topScrim ? !topScrim.inert && topScrim.getAttribute('aria-hidden') !== 'true' : false,
      focusInsideTop: element.contains(document.activeElement),
    };
  });
  if (state.dialogCount < 2 || !state.lowerLayersIsolated || !state.topLayerInteractive || !state.focusInsideTop) {
    throw new Error(`Nested dialog stack did not isolate only the top layer: ${JSON.stringify(state)}`);
  }
}

async function assertNoSeriousAxeViolations(page: any, state: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const blockers = results.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  if (blockers.length > 0) {
    const summary = blockers.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.slice(0, 5).map((node) => node.target),
    }));
    throw new Error(`axe serious/critical violations in ${state}: ${JSON.stringify(summary)}`);
  }
  console.log(`  ✓ axe: ${state} has no serious/critical violations.`);
}

type ContrastKind = 'text' | 'non-text' | 'focus';

async function measureRenderedContrast(locator: any, label: string, kind: ContrastKind) {
  return locator.evaluate((element: HTMLElement, { label, kind }: { label: string; kind: ContrastKind }) => {
    type Rgba = { r: number; g: number; b: number; a: number };
    const parse = (value: string): Rgba => {
      const channels = value.match(/[\d.]+/g)?.map(Number) || [];
      return { r: channels[0] || 0, g: channels[1] || 0, b: channels[2] || 0, a: channels[3] ?? 1 };
    };
    const composite = (foreground: Rgba, background: Rgba): Rgba => {
      const alpha = foreground.a + background.a * (1 - foreground.a);
      if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
        g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
        b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
        a: alpha,
      };
    };
    const effectiveBackground = (start: HTMLElement | null): Rgba => {
      const layers: Rgba[] = [];
      for (let current = start; current; current = current.parentElement) {
        layers.push(parse(getComputedStyle(current).backgroundColor));
      }
      let result: Rgba = { r: 255, g: 255, b: 255, a: 1 };
      for (const layer of layers.reverse()) result = composite(layer, result);
      return result;
    };
    const linear = (channel: number) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: Rgba) => 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
    const ratio = (first: Rgba, second: Rgba) => {
      const firstLuminance = luminance(first);
      const secondLuminance = luminance(second);
      return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
    };
    const style = getComputedStyle(element);
    const background = effectiveBackground(kind === 'focus' ? element.parentElement : element);
    const foreground = composite(parse(kind === 'focus' ? style.outlineColor : style.color), background);
    const fontSize = Number.parseFloat(style.fontSize);
    const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
    const largeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    const threshold = kind === 'text' ? (largeText ? 3 : 4.5) : 3;
    return { label, kind, ratio: ratio(foreground, background), threshold, foreground: style.color, background: style.backgroundColor };
  }, { label, kind });
}

async function assertRenderedAppearanceContrast(page: any, accountDialog: any) {
  await page.evaluate('globalThis.__name = function (target) { return target; };');
  const modes: AppearanceMode[] = ['dark', 'light'];
  const matrix: Array<{ profile: string; mode: AppearanceMode; samples: Awaited<ReturnType<typeof measureRenderedContrast>>[] }> = [];
  const appearanceTab = accountDialog.getByRole('tab', { name: 'Appearance & Theme' });
  const tokensTab = accountDialog.getByRole('tab', { name: 'API Tokens' });
  for (const profile of COLOR_PROFILES) {
    for (const mode of modes) {
      await appearanceTab.click();
      await accountDialog.getByRole('button', { name: mode === 'dark' ? 'Dark Mode' : 'Light Mode', exact: true }).click();
      const profileControl = accountDialog.getByRole('radio', { name: new RegExp(profile.name) });
      await profileControl.click();
      await page.waitForFunction(({ profile, mode }) => {
        const root = document.documentElement;
        return root.dataset.profile === profile && root.classList.contains(mode);
      }, { profile: profile.id, mode });
      const primary = accountDialog.locator('.muster-text-primary:visible').first();
      const muted = accountDialog.locator('.muster-text-muted:visible').first();
      await tokensTab.focus();
      await page.keyboard.press('ArrowLeft');
      if (!await appearanceTab.evaluate((element: HTMLElement) => element.matches(':focus-visible'))) {
        throw new Error(`Appearance tab did not expose a keyboard focus-visible ring for ${profile.id}/${mode}`);
      }
      const samples = await Promise.all([
        measureRenderedContrast(primary, 'primary text', 'text'),
        measureRenderedContrast(muted, 'muted text', 'text'),
        measureRenderedContrast(appearanceTab, 'account-tab focus ring', 'focus'),
      ]);
      await tokensTab.click();
      const tokenRow = accountDialog.locator('tbody tr').filter({ hasText: 'Browser nested token' });
      await tokenRow.waitFor();
      const dangerControl = tokenRow.getByTitle('Revoke token');
      await dangerControl.hover();
      await page.waitForTimeout(200);
      samples.push(
        await measureRenderedContrast(accountDialog.getByRole('button', { name: 'New Token' }).first(), 'primary control', 'text'),
        await measureRenderedContrast(tokenRow.locator('.muster-badge-success'), 'success status', 'text'),
        await measureRenderedContrast(dangerControl, 'danger control', 'non-text'),
      );
      const failures = samples.filter((sample) => sample.ratio + 0.001 < sample.threshold);
      if (failures.length > 0) {
        throw new Error(`Rendered WCAG AA contrast failed for ${profile.id}/${mode}: ${JSON.stringify(failures)}`);
      }
      matrix.push({ profile: profile.id, mode, samples });
    }
  }
  if (matrix.length !== COLOR_PROFILES.length * modes.length) {
    throw new Error(`Rendered appearance matrix is incomplete: ${matrix.length} combinations`);
  }
  console.log(`  ✓ Rendered contrast: ${matrix.length} profile/mode combinations × 6 real UI surfaces meet WCAG AA.`);
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
      await nameInput.waitFor();
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
    await assertAccessibleDialog(page, 'Create New Project');

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
    const createBoardDialog = await assertAccessibleDialog(page, 'Create New Board');
    await page.fill('input[placeholder*="Sprint 2"]', 'Release Board');
    await page.click('button[type="submit"]:has-text("Create Board")');
    await createBoardDialog.waitFor({ state: 'detached' });

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

    // Lazy-view contract: delay the first Knowledge Base chunk, prove the
    // polite loading state is visible, navigate by keyboard, focus the
    // resolved region, and return through browser history without resetting
    // the selected project/board state held above the boundary.
    const knowledgeChunkPattern = '**/assets/KnowledgeBase-*.js';
    await page.route(knowledgeChunkPattern, async (route) => {
      await sleep(750);
      await route.continue();
    });
    const knowledgeTab = page.getByRole('button', { name: /Knowledge Base/ }).first();
    await knowledgeTab.focus();
    await knowledgeTab.press('Enter');
    await page.getByRole('status').filter({ hasText: 'Loading Knowledge Base' }).waitFor();
    const knowledgeRegion = page.locator('[data-lazy-view="knowledge-base"]');
    await knowledgeRegion.waitFor();
    const focusedLazyView = await page.evaluate(() => document.activeElement?.getAttribute('data-lazy-view'));
    if (focusedLazyView !== 'knowledge-base') {
      throw new Error(`Resolved lazy Knowledge Base view did not receive focus: ${focusedLazyView}`);
    }
    await page.unroute(knowledgeChunkPattern);
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-lazy-view="kanban-board"]').waitFor();
    const restoredBoardName = await boardSelector.locator('option:checked').textContent();
    if (restoredBoardName !== 'Release Board') {
      throw new Error(`Lazy back navigation lost selected board state: ${restoredBoardName}`);
    }
    console.log('  ✓ Lazy loading, keyboard focus, and back-navigation state verified.');

    // A failed dynamic import must become an actionable, non-secret-bearing
    // alert instead of a blank view. A separate page keeps this deliberate
    // failure from poisoning the main page's React.lazy module cache.
    const failurePage = await context.newPage();
    await failurePage.route('**/assets/WorkspaceAdmin-*.js', (route) => route.abort('failed'));
    await failurePage.goto(`${appUrl}/projects/e2e-isolated-test-project/admin`, { waitUntil: 'domcontentloaded' });
    await failurePage.getByRole('alert').filter({ hasText: 'Workspace Admin could not be loaded' }).waitFor();
    await failurePage.getByRole('button', { name: 'Reload Workspace Admin', exact: true }).waitFor();
    await failurePage.close();
    console.log('  ✓ Failed lazy chunk rendered an accessible recovery action.');

    // Step 3: Test Board View & Column Creation
    console.log('\n[3/8] Testing Kanban Board & Column Creation (+ Add Column)...');
    await page.getByRole('button', { name: 'Board settings' }).click();
    await assertAccessibleDialog(page, 'Board Settings');
    await page.getByRole('button', { name: 'Add New Column', exact: true }).click();
    const addColumnDialog = await assertAccessibleDialog(page, 'Add Column');

    await page.fill('input[placeholder*="In Testing"]', 'Quality Assurance');
    await page.fill('input[placeholder*="leave empty"]', '3');
    await addColumnDialog.getByLabel('Workflow role').selectOption('review');
    await page.click('button[type="submit"]:has-text("Add Column")');
    await page.waitForSelector('h3:has-text("QUALITY ASSURANCE")');
    await page.getByRole('button', { name: 'Board settings' }).click();
    const updatedBoardSettings = await assertAccessibleDialog(page, 'Board Settings');
    const qualityAssuranceLane = updatedBoardSettings
      .getByRole('listitem')
      .filter({ hasText: 'Quality Assurance' });
    await qualityAssuranceLane.getByText('review', { exact: true }).waitFor();
    await qualityAssuranceLane.getByRole('button', { name: 'Edit role' }).click();
    const editColumnDialog = await assertAccessibleDialog(page, 'Edit Column Settings');
    if (await editColumnDialog.getByLabel('Workflow role').inputValue() !== 'review') {
      throw new Error('Workflow role did not persist through the board settings editor.');
    }
    await page.keyboard.press('Escape');
    await editColumnDialog.waitFor({ state: 'detached' });
    console.log('  ✓ Custom column rendered with its persisted review workflow role.');

    // Step 4: Create Card
    console.log('\n[4/8] Testing Card Creation (+ Add Card / + Card)...');
    await page.getByTitle('Add card to column').first().click();
    await assertAccessibleDialog(page, 'Create card');

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
    await assertAccessibleDialog(page, /Implement Playwright E2E UI Tests/);
    await page.waitForSelector('text=Comments');
    await assertNoSeriousAxeViolations(page, 'card details dialog');

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
    await assertAccessibleDialog(page, 'Register Agent');

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
    await assertAccessibleDialog(page, 'Create Design Document');
    await assertNoSeriousAxeViolations(page, 'create document dialog');

    await page.fill('input[placeholder*="Architecture Overview"]', 'Frontend UI Architecture & E2E Verification');
    await page.fill('textarea', '# Frontend Specification\n\n- React 19 SPA\n- Lucide Icons\n- Tailwind CSS');
    await page.click('button[type="submit"]:has-text("Create Document")');
    await page.waitForSelector('h2:has-text("Frontend UI Architecture & E2E Verification")');
    const documentDeepLink = page.url();
    console.log('  ✓ Document created and rendered with Markdown preview.');

    // Workflow status progression
    await page.click('button:has-text("Submit for Review")');
    await page.waitForSelector('text=In Review');
    console.log('  ✓ Status transitioned: Draft → In Review');

    await page.click('button:has-text("Approve")');
    await page.waitForSelector('text=Approved');
    console.log('  ✓ Status transitioned: In Review → Approved');

    // Direct navigation must resolve the same lazy document surface and
    // selected document, rather than falling back to the board or losing the
    // deep-link identifier during project hydration.
    await page.goto(documentDeepLink, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h2:has-text("Frontend UI Architecture & E2E Verification")');
    if (!new URL(page.url()).pathname.includes('/docs/')) {
      throw new Error(`Document deep link was not preserved: ${new URL(page.url()).pathname}`);
    }
    console.log('  ✓ Direct document deep navigation restored the selected lazy view.');

    // Step 8: Real-Time Activity Log
    console.log('\n[8/8] Testing Activity Log View (Real-Time Feed)...');
    await page.click('button:has-text("Activity Log")');
    await page.waitForSelector('text=events');
    console.log('  ✓ Activity Log rendered cleanly.');

    console.log('\n[A11y] Testing dialog focus, semantics, touch targets and motion preferences...');
    const overlayInventory = [
      ['src/web/components/TokensView.tsx', 2],
      ['src/web/components/KnowledgeBase.tsx', 5],
      ['src/web/components/admin/RolesPanel.tsx', 1],
      ['src/web/components/admin/InvitationsPanel.tsx', 1],
      ['src/web/components/AgentGrid.tsx', 1],
    ] as const;
    for (const [relativePath, expectedDialogs] of overlayInventory) {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      const accessibleDialogs = source.match(/<AccessibleDialog\b/g)?.length || 0;
      const rawScrims = source.match(/className="muster-scrim"/g)?.length || 0;
      if (accessibleDialogs !== expectedDialogs || rawScrims !== 0) {
        throw new Error(`Overlay migration inventory failed for ${relativePath}: ${JSON.stringify({ accessibleDialogs, expectedDialogs, rawScrims })}`);
      }
    }

    await page.getByRole('button', { name: /Agents/ }).click();
    await assertNoSeriousAxeViolations(page, 'agents view');
    await page.getByTitle('Edit Agent Attributes').first().click();
    const editAgentDialog = await assertAccessibleDialog(page, 'Edit Agent Attributes');
    await assertNoSeriousAxeViolations(page, 'agent edit dialog');
    await page.keyboard.press('Escape');
    await editAgentDialog.waitFor({ state: 'detached' });

    await page.locator('header button[title*="Account"]').click();
    const accountDialog = await assertAccessibleDialog(page, /Operator|Browser UI Tester/);
    await assertNoSeriousAxeViolations(page, 'account appearance dialog');
    const accountTabs = accountDialog.getByRole('tab');
    const initialTabStops = await accountTabs.evaluateAll((tabs: HTMLElement[]) => tabs.map((tab) => ({
      text: tab.textContent?.trim(),
      tabIndex: tab.tabIndex,
      selected: tab.getAttribute('aria-selected'),
    })));
    if (initialTabStops.filter(({ tabIndex }: { tabIndex: number }) => tabIndex === 0).length !== 1) {
      throw new Error(`Account tablist does not have exactly one tab stop: ${JSON.stringify(initialTabStops)}`);
    }
    const appearanceTab = accountDialog.getByRole('tab', { name: 'Appearance & Theme' });
    await appearanceTab.focus();
    await page.keyboard.press('ArrowRight');
    const arrowState = await accountDialog.getByRole('tab', { name: 'API Tokens' }).evaluate((tab: HTMLElement) => ({
      focused: document.activeElement === tab,
      selected: tab.getAttribute('aria-selected'),
      tabIndex: tab.tabIndex,
    }));
    if (!arrowState.focused || arrowState.selected !== 'true' || arrowState.tabIndex !== 0) {
      throw new Error(`Account ArrowRight activation failed: ${JSON.stringify(arrowState)}`);
    }
    await page.keyboard.press('End');
    await page.waitForTimeout(50);
    if (!await accountTabs.last().evaluate((tab: HTMLElement) => document.activeElement === tab && tab.tabIndex === 0)) {
      throw new Error('Account End key did not activate and focus the last tab');
    }
    await page.keyboard.press('Home');
    await page.waitForTimeout(50);
    if (!await accountTabs.first().evaluate((tab: HTMLElement) => document.activeElement === tab && tab.tabIndex === 0)) {
      throw new Error('Account Home key did not activate and focus the first tab');
    }

    await accountDialog.getByRole('tab', { name: 'API Tokens' }).click();
    const newTokenTrigger = accountDialog.getByRole('button', { name: 'New Token' }).first();
    await newTokenTrigger.click();
    let newTokenDialog = await assertAccessibleDialog(page, 'New Token');
    await assertNestedDialogIsolation(page, newTokenDialog);
    await assertNoSeriousAxeViolations(page, 'nested token dialog');
    await page.keyboard.press('Escape');
    await newTokenDialog.waitFor({ state: 'detached' });
    if (!await accountDialog.isVisible() || !await newTokenTrigger.evaluate((button: HTMLElement) => document.activeElement === button)) {
      throw new Error('Nested token Escape closed the wrong layer or failed to restore trigger focus');
    }
    await newTokenTrigger.click();
    newTokenDialog = await assertAccessibleDialog(page, 'New Token');
    await newTokenDialog.getByLabel('Name').fill('Browser nested token');
    await newTokenDialog.getByRole('button', { name: 'Create Token' }).click();
    const tokenCreatedDialog = await assertAccessibleDialog(page, 'Token Created');
    await assertNestedDialogIsolation(page, tokenCreatedDialog);
    await tokenCreatedDialog.getByRole('button', { name: /Done/ }).click();
    await tokenCreatedDialog.waitFor({ state: 'detached' });
    await assertRenderedAppearanceContrast(page, accountDialog);

    await accountDialog.getByRole('tab', { name: 'Workspace Admin' }).click();
    await accountDialog.getByRole('button', { name: /^Roles \(/ }).click();
    await accountDialog.getByRole('button', { name: 'New Role' }).click();
    const roleDialog = await assertAccessibleDialog(page, 'New Role');
    await assertNestedDialogIsolation(page, roleDialog);
    await assertNoSeriousAxeViolations(page, 'nested role dialog');
    await page.keyboard.press('Escape');
    await roleDialog.waitFor({ state: 'detached' });

    await accountDialog.getByRole('button', { name: /^Invitations \(/ }).click();
    const invitationForm = accountDialog.locator('input[type="email"]').locator('xpath=ancestor::form');
    await invitationForm.locator('input[type="email"]').fill('browser-invite@example.com');
    await invitationForm.locator('select').selectOption({ index: 1 });
    await invitationForm.getByRole('button', { name: 'Invite' }).click();
    const invitationDialog = await assertAccessibleDialog(page, 'Invitation Created');
    await assertNestedDialogIsolation(page, invitationDialog);
    await assertNoSeriousAxeViolations(page, 'nested invitation dialog');
    await page.keyboard.press('Escape');
    await invitationDialog.waitFor({ state: 'detached' });
    if (!await accountDialog.isVisible()) throw new Error('Invitation Escape closed the parent account dialog');
    await page.keyboard.press('Escape');
    await accountDialog.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: /Knowledge Base/ }).click();
    await page.getByRole('button', { name: 'New KB' }).click();
    const createKbDialog = await assertAccessibleDialog(page, 'Create New Knowledge Base');
    await assertNoSeriousAxeViolations(page, 'knowledge-base dialog');
    await createKbDialog.getByLabel('KB Name').fill('Browser Accessibility KB');
    await createKbDialog.getByRole('button', { name: 'Create KB' }).click();
    await createKbDialog.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Add Knowledge' }).click();
    const addKnowledgeDialog = await assertAccessibleDialog(page, 'Add Gained Knowledge');
    await addKnowledgeDialog.getByLabel('Title').fill('Accessible overlay inventory');
    await addKnowledgeDialog.getByLabel('Content / Learning').fill('Every knowledge overlay uses the shared dialog boundary.');
    await addKnowledgeDialog.getByLabel('Entity Name (Optional)').fill('browser-node');
    await addKnowledgeDialog.getByLabel('Entity Identifier / IP / Email (Optional)').fill('browser-node.local');
    await addKnowledgeDialog.getByRole('button', { name: 'Save Knowledge' }).click();
    await addKnowledgeDialog.waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: /Facts \(/ }).click();
    await page.getByText('Accessible overlay inventory', { exact: true }).waitFor();
    await page.getByTitle('Edit Fact').first().click();
    const editFactDialog = await assertAccessibleDialog(page, 'Edit Gained Knowledge Fact');
    await page.keyboard.press('Escape');
    await editFactDialog.waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: /Graph \(/ }).click();
    const graphCanvas = page.locator('.vis-network canvas').first();
    await graphCanvas.waitFor();
    await page.waitForTimeout(800);
    const graphBox = await graphCanvas.boundingBox();
    if (!graphBox) throw new Error('Knowledge graph canvas has no rendered bounds');
    await page.mouse.click(graphBox.x + graphBox.width / 2, graphBox.y + graphBox.height / 2);
    await page.getByTitle('Edit Entity Node').waitFor();
    await page.getByTitle('Edit Entity Node').click();
    const editEntityDialog = await assertAccessibleDialog(page, 'Edit Knowledge Graph Entity Node');
    await page.keyboard.press('Escape');
    await editEntityDialog.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '+ Edge' }).click();
    const relationDialog = await assertAccessibleDialog(page, 'Link Graph Relation');
    await page.keyboard.press('Escape');
    await relationDialog.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: /Kanban Board/ }).click();
    // The direct document deep-link check above deliberately performs a full
    // reload on a route with no board slug, so the app reopens its default
    // board. Restore the board that owns the first card before exercising the
    // two-card keyboard reorder contract.
    await boardSelector.selectOption({ label: 'Release Board' });
    await page.getByRole('heading', { name: 'Implement Playwright E2E UI Tests' }).waitFor();
    await assertNoSeriousAxeViolations(page, 'kanban board');
    await page.locator('button[title="Add card to column"]').first().click();
    const secondCardDialog = await assertAccessibleDialog(page, 'Create card');
    const secondCardForm = secondCardDialog.locator('form');
    await secondCardForm.locator('input[type="text"]').fill('Keyboard reorder companion');
    await secondCardForm.getByRole('button', { name: /Create/ }).click();
    await page.getByRole('dialog', { name: /Keyboard reorder companion/ }).waitFor();
    await page.getByTitle('Close Task').click();
    await page.getByRole('dialog', { name: /Keyboard reorder companion/ }).waitFor({ state: 'detached' });
    const cardOpeners = page.locator('[data-card-open]');
    const rovingStops = await cardOpeners.evaluateAll((openers: HTMLElement[]) => openers.map((opener) => opener.tabIndex));
    if (rovingStops.filter((tabIndex: number) => tabIndex === 0).length !== 1 || rovingStops.some((tabIndex: number) => tabIndex < -1)) {
      throw new Error(`Card openers did not initialize one roving tab stop: ${JSON.stringify(rovingStops)}`);
    }

    await page.getByTitle(/Sort cards:/).click();
    const dragHandles = page.getByRole('button', { name: /^Drag .*Press Space to lift/ });
    const beforeOrder = await page.locator('[data-rfd-draggable-id]').evaluateAll((cards: HTMLElement[]) => cards
      .filter((card) => card.id.startsWith('kanban-card-'))
      .map((card) => card.getAttribute('data-rfd-draggable-id')));
    await dragHandles.first().focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[aria-live]')).some((region) => region.textContent?.trim()), null, { timeout: 2000 });
    const liftAnnouncements = await page.locator('[aria-live]').evaluateAll((regions: HTMLElement[]) => regions.map((region) => region.textContent?.trim()).filter(Boolean));
    if (!liftAnnouncements.length) throw new Error('Keyboard drag lift produced no screen-reader announcement');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await page.waitForTimeout(700);
    const afterOrder = await page.locator('[data-rfd-draggable-id]').evaluateAll((cards: HTMLElement[]) => cards
      .filter((card) => card.id.startsWith('kanban-card-'))
      .map((card) => card.getAttribute('data-rfd-draggable-id')));
    if (beforeOrder.length < 2 || beforeOrder.join(',') === afterOrder.join(',')) {
      throw new Error(`Keyboard drag did not reorder cards: ${JSON.stringify({ beforeOrder, afterOrder })}`);
    }
    await dragHandles.first().focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    const cancelOrder = await page.locator('[data-rfd-draggable-id]').evaluateAll((cards: HTMLElement[]) => cards
      .filter((card) => card.id.startsWith('kanban-card-'))
      .map((card) => card.getAttribute('data-rfd-draggable-id')));
    if (cancelOrder.join(',') !== afterOrder.join(',')) throw new Error('Keyboard drag cancel mutated card order');

    const shortcutsChunkPattern = '**/assets/ShortcutsHelpModal-*.js';
    const accountChunkPattern = '**/assets/UserAccountModal-*.js';

    // A lazy dialog owns a real modal layer before its chunk resolves. Toggling
    // that pending invocation off must release isolation and restore the exact
    // trigger; a disconnected trigger must be ignored safely on a later abort.
    const cancelContext = await browser.newContext();
    const cancelPage = await cancelContext.newPage();
    let releaseCancelledChunk!: () => void;
    const cancelledChunkGate = new Promise<void>((resolve) => { releaseCancelledChunk = resolve; });
    await cancelPage.route(shortcutsChunkPattern, async (route) => {
      await cancelledChunkGate;
      await route.continue();
    });
    await cancelPage.goto(appUrl, { waitUntil: 'domcontentloaded' });
    const cancelTrigger = cancelPage.getByRole('button', { name: 'Keyboard shortcuts' });
    await cancelTrigger.focus();
    await cancelTrigger.click();
    let cancelledStatus = await assertPendingDialogIsolation(cancelPage, 'Keyboard Shortcuts dialog');
    await cancelPage.keyboard.press('Shift+/');
    await cancelledStatus.waitFor({ state: 'detached' });
    const cancelledState = await cancelPage.evaluate((trigger: HTMLElement) => {
      const root = document.getElementById('root');
      return {
        exactFocus: document.activeElement === trigger,
        activeTag: document.activeElement?.tagName,
        activeLabel: document.activeElement instanceof HTMLElement
          ? document.activeElement.getAttribute('aria-label') || document.activeElement.getAttribute('placeholder') || document.activeElement.textContent?.trim().slice(0, 80)
          : null,
        triggerConnected: trigger.isConnected,
        rootInert: Boolean(root?.inert),
        rootHidden: root?.getAttribute('aria-hidden'),
        bodyOverflow: document.body.style.overflow,
      };
    }, await cancelTrigger.elementHandle());
    if (
      !cancelledState.exactFocus
      || cancelledState.rootInert
      || cancelledState.rootHidden === 'true'
      || cancelledState.bodyOverflow === 'hidden'
    ) {
      throw new Error(`Pending lazy cancel did not restore its trigger/root state: ${JSON.stringify(cancelledState)}`);
    }
    const removedTriggerHandle = await cancelTrigger.elementHandle();
    if (!removedTriggerHandle) throw new Error('Unable to retain the shortcuts trigger for removal probe');
    await cancelTrigger.click();
    cancelledStatus = await assertPendingDialogIsolation(cancelPage, 'Keyboard Shortcuts dialog');
    await removedTriggerHandle.evaluate((element: HTMLElement) => element.remove());
    await cancelPage.keyboard.press('Escape');
    await cancelledStatus.waitFor({ state: 'detached' });
    const removedTriggerState = await cancelPage.evaluate(() => {
      const root = document.getElementById('root');
      return {
        activeConnected: document.activeElement instanceof HTMLElement && document.activeElement.isConnected,
        rootInert: Boolean(root?.inert),
        rootHidden: root?.getAttribute('aria-hidden'),
        bodyOverflow: document.body.style.overflow,
      };
    });
    if (
      !removedTriggerState.activeConnected
      || removedTriggerState.rootInert
      || removedTriggerState.rootHidden === 'true'
      || removedTriggerState.bodyOverflow === 'hidden'
    ) {
      throw new Error(`Removed lazy-dialog trigger left stale focus/isolation: ${JSON.stringify(removedTriggerState)}`);
    }
    releaseCancelledChunk();
    await cancelPage.unroute(shortcutsChunkPattern, { behavior: 'wait' });
    await cancelContext.close();

    // Invocation order, not chunk completion order, defines modal ownership.
    // Account is invoked first, Shortcuts second, then their chunks resolve in
    // reverse. Shortcuts must remain top and close first.
    const concurrencyContext = await browser.newContext();
    const concurrencyPage = await concurrencyContext.newPage();
    let releaseAccountChunk!: () => void;
    let releaseShortcutChunk!: () => void;
    const accountChunkGate = new Promise<void>((resolve) => { releaseAccountChunk = resolve; });
    const shortcutChunkGate = new Promise<void>((resolve) => { releaseShortcutChunk = resolve; });
    await concurrencyPage.route(accountChunkPattern, async (route) => {
      await accountChunkGate;
      await route.continue();
    });
    await concurrencyPage.route(shortcutsChunkPattern, async (route) => {
      await shortcutChunkGate;
      await route.continue();
    });
    await concurrencyPage.goto(appUrl, { waitUntil: 'domcontentloaded' });
    const concurrencyAccountTrigger = concurrencyPage.locator('header button[title*="Account"]');
    await concurrencyAccountTrigger.click();
    await assertPendingDialogIsolation(concurrencyPage, 'User Account dialog');
    await concurrencyPage.getByRole('button', { name: 'Keyboard shortcuts', includeHidden: true })
      .evaluate((trigger: HTMLButtonElement) => trigger.click());
    await assertPendingDialogIsolation(concurrencyPage, 'Keyboard Shortcuts dialog');
    releaseShortcutChunk();
    const concurrentShortcuts = await assertAccessibleDialog(concurrencyPage, 'Keyboard Shortcuts');
    releaseAccountChunk();
    const concurrentAccount = concurrencyPage.locator('[role="dialog"]', {
      has: concurrencyPage.locator('#account-dialog-title'),
    });
    await concurrentAccount.waitFor({ state: 'attached' });
    const inverseResolutionState = await concurrencyPage.evaluate(() => {
      const account = document.getElementById('account-dialog-title')?.closest<HTMLElement>('[role="dialog"]');
      const shortcuts = document.getElementById('shortcuts-dialog-title')?.closest<HTMLElement>('[role="dialog"]');
      const accountScrim = account?.closest<HTMLElement>('.muster-scrim');
      const shortcutsScrim = shortcuts?.closest<HTMLElement>('.muster-scrim');
      return {
        accountHidden: accountScrim?.getAttribute('aria-hidden'),
        accountInert: Boolean(accountScrim?.inert),
        shortcutsHidden: shortcutsScrim?.getAttribute('aria-hidden'),
        shortcutsInert: Boolean(shortcutsScrim?.inert),
        focusInsideShortcuts: Boolean(shortcuts?.contains(document.activeElement)),
      };
    });
    if (
      inverseResolutionState.accountHidden !== 'true'
      || !inverseResolutionState.accountInert
      || inverseResolutionState.shortcutsHidden === 'true'
      || inverseResolutionState.shortcutsInert
      || !inverseResolutionState.focusInsideShortcuts
    ) {
      throw new Error(`Inverse lazy resolution reordered the modal stack: ${JSON.stringify(inverseResolutionState)}`);
    }
    await concurrencyPage.keyboard.press('Escape');
    await concurrentShortcuts.waitFor({ state: 'detached' });
    if (!await concurrentAccount.isVisible() || !await concurrentAccount.evaluate((dialog: HTMLElement) => dialog.contains(document.activeElement))) {
      throw new Error('First Escape after inverse resolution did not reveal/focus the older Account dialog');
    }
    await concurrencyPage.keyboard.press('Escape');
    await concurrentAccount.waitFor({ state: 'detached' });
    if (!await concurrencyAccountTrigger.evaluate((trigger: HTMLElement) => document.activeElement === trigger)) {
      throw new Error('Inverse-resolution stack did not restore the original Account trigger');
    }
    await concurrencyContext.close();

    // A newer pending layer above an already-resolved dialog must consume
    // Escape itself and reveal the underlying dialog without closing it.
    const pendingOverResolvedContext = await browser.newContext();
    const pendingOverResolvedPage = await pendingOverResolvedContext.newPage();
    let releaseOverlayShortcut!: () => void;
    const overlayShortcutGate = new Promise<void>((resolve) => { releaseOverlayShortcut = resolve; });
    await pendingOverResolvedPage.route(shortcutsChunkPattern, async (route) => {
      await overlayShortcutGate;
      await route.continue();
    });
    await pendingOverResolvedPage.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await pendingOverResolvedPage.locator('header button[title*="Account"]').click();
    const resolvedAccount = await assertAccessibleDialog(pendingOverResolvedPage, /Account|Operator/);
    await pendingOverResolvedPage.getByRole('button', { name: 'Keyboard shortcuts', includeHidden: true })
      .evaluate((trigger: HTMLButtonElement) => trigger.click());
    const overlayPendingStatus = await assertPendingDialogIsolation(pendingOverResolvedPage, 'Keyboard Shortcuts dialog');
    await pendingOverResolvedPage.keyboard.press('Escape');
    await overlayPendingStatus.waitFor({ state: 'detached' });
    if (!await resolvedAccount.isVisible() || !await resolvedAccount.evaluate((dialog: HTMLElement) => dialog.contains(document.activeElement))) {
      throw new Error('Pending dialog Escape leaked through to its resolved underlying dialog');
    }
    releaseOverlayShortcut();
    await pendingOverResolvedPage.unroute(shortcutsChunkPattern, { behavior: 'wait' });
    await pendingOverResolvedPage.keyboard.press('Escape');
    await resolvedAccount.waitFor({ state: 'detached' });
    const overlayCleanupState = await pendingOverResolvedPage.evaluate(() => {
      const root = document.getElementById('root');
      return {
        rootInert: Boolean(root?.inert),
        rootHidden: root?.getAttribute('aria-hidden'),
        bodyOverflow: document.body.style.overflow,
      };
    });
    if (overlayCleanupState.rootInert || overlayCleanupState.rootHidden === 'true' || overlayCleanupState.bodyOverflow === 'hidden') {
      throw new Error(`Pending-over-resolved cleanup left isolation behind: ${JSON.stringify(overlayCleanupState)}`);
    }
    await pendingOverResolvedContext.close();

    const shortcutTrigger = page.getByRole('button', { name: 'Keyboard shortcuts' });
    await page.route(shortcutsChunkPattern, async (route) => {
      await sleep(400);
      await route.continue();
    });
    await shortcutTrigger.focus();
    await shortcutTrigger.click();
    await page.getByRole('status').filter({ hasText: 'Loading Keyboard Shortcuts dialog' }).waitFor();
    const shortcutDialog = await assertAccessibleDialog(page, 'Keyboard Shortcuts');
    await page.unroute(shortcutsChunkPattern);
    await assertNoSeriousAxeViolations(page, 'keyboard shortcuts dialog');
    for (let index = 0; index < 12; index += 1) await page.keyboard.press('Tab');
    if (!await shortcutDialog.evaluate((element: HTMLElement) => element.contains(document.activeElement))) {
      throw new Error('Keyboard focus escaped the shortcuts dialog');
    }
    await page.keyboard.press('Escape');
    await shortcutDialog.waitFor({ state: 'detached' });
    const restored = await shortcutTrigger.evaluate((element: HTMLElement) => document.activeElement === element);
    const unlocked = await page.evaluate(() => {
      const root = document.getElementById('root');
      return !root?.inert && root?.getAttribute('aria-hidden') !== 'true' && document.body.style.overflow !== 'hidden';
    });
    if (!restored || !unlocked) {
      throw new Error(`Dialog close did not restore focus and background state: ${JSON.stringify({ restored, unlocked })}`);
    }

    // Closing unmounts the lazy boundary, so a second activation must capture
    // this activation's opener rather than reusing the first handoff.
    await shortcutTrigger.focus();
    await shortcutTrigger.click();
    const reopenedShortcutDialog = await assertAccessibleDialog(page, 'Keyboard Shortcuts');
    await page.keyboard.press('Escape');
    await reopenedShortcutDialog.waitFor({ state: 'detached' });
    if (!await shortcutTrigger.evaluate((element: HTMLElement) => document.activeElement === element)) {
      throw new Error('Repeated lazy shortcuts close did not restore its current opener');
    }

    // A top non-Shortcuts layer must consume the global shortcuts chord without
    // letting App toggle the hidden lower Shortcuts boundary. Once Account
    // closes, the revealed Shortcuts layer owns the next chord and closes.
    await shortcutTrigger.focus();
    await shortcutTrigger.click();
    const lowerShortcutDialog = await assertAccessibleDialog(page, 'Keyboard Shortcuts');
    const accountTriggerUnderShortcuts = page.locator('header button[title*="Account"]');
    await accountTriggerUnderShortcuts.evaluate((trigger: HTMLButtonElement) => trigger.click());
    const topAccountDialog = await assertAccessibleDialog(page, /Operator|Browser UI Tester/);
    const assertAccountAboveShortcuts = async (phase: string) => {
      const state = await page.evaluate(() => {
        const shortcuts = document.getElementById('shortcuts-dialog-title')?.closest<HTMLElement>('[role="dialog"]');
        const account = document.getElementById('account-dialog-title')?.closest<HTMLElement>('[role="dialog"]');
        const shortcutsScrim = shortcuts?.closest<HTMLElement>('.muster-scrim');
        const accountScrim = account?.closest<HTMLElement>('.muster-scrim');
        return {
          shortcutsMounted: Boolean(shortcuts),
          shortcutsInert: Boolean(shortcutsScrim?.inert),
          shortcutsHidden: shortcutsScrim?.getAttribute('aria-hidden'),
          accountMounted: Boolean(account),
          accountInert: Boolean(accountScrim?.inert),
          accountHidden: accountScrim?.getAttribute('aria-hidden'),
          focusInsideAccount: Boolean(account?.contains(document.activeElement)),
        };
      });
      if (
        !state.shortcutsMounted
        || !state.shortcutsInert
        || state.shortcutsHidden !== 'true'
        || !state.accountMounted
        || state.accountInert
        || state.accountHidden === 'true'
        || !state.focusInsideAccount
      ) {
        throw new Error(`${phase}: top Account did not retain ownership above Shortcuts: ${JSON.stringify(state)}`);
      }
    };
    await assertAccountAboveShortcuts('before Shift+?');
    await page.keyboard.press('Shift+/');
    await page.waitForTimeout(50);
    await assertAccountAboveShortcuts('after Shift+?');
    await page.keyboard.press('Escape');
    await topAccountDialog.waitFor({ state: 'detached' });
    if (!await lowerShortcutDialog.isVisible() || !await lowerShortcutDialog.evaluate((dialog: HTMLElement) => dialog.contains(document.activeElement))) {
      throw new Error('Closing Account did not reveal and focus the still-mounted Shortcuts dialog');
    }
    await page.keyboard.press('Shift+/');
    await lowerShortcutDialog.waitFor({ state: 'detached' });
    const shortcutOwnershipCleanup = await shortcutTrigger.evaluate((trigger: HTMLElement) => {
      const root = document.getElementById('root');
      return {
        exactFocus: document.activeElement === trigger,
        rootInert: Boolean(root?.inert),
        rootHidden: root?.getAttribute('aria-hidden'),
        bodyOverflow: document.body.style.overflow,
      };
    });
    if (
      !shortcutOwnershipCleanup.exactFocus
      || shortcutOwnershipCleanup.rootInert
      || shortcutOwnershipCleanup.rootHidden === 'true'
      || shortcutOwnershipCleanup.bodyOverflow === 'hidden'
    ) {
      throw new Error(`Shortcut ownership cleanup failed: ${JSON.stringify(shortcutOwnershipCleanup)}`);
    }

    // A failed lazy chunk recovers through the explicit reload action. Prove a
    // fresh runtime can then open and close the dialog without inheriting the
    // failed activation's focus handoff.
    const retryPage = await context.newPage();
    await retryPage.route(shortcutsChunkPattern, (route) => route.abort('failed'));
    await retryPage.goto(appUrl, { waitUntil: 'domcontentloaded' });
    const retryTrigger = retryPage.getByRole('button', { name: 'Keyboard shortcuts' });
    await retryTrigger.focus();
    await retryTrigger.click();
    await retryPage.getByRole('alert').filter({ hasText: 'Keyboard Shortcuts dialog could not be loaded' }).waitFor();
    await retryPage.unroute(shortcutsChunkPattern);
    await retryPage.getByRole('button', { name: 'Reload Keyboard Shortcuts dialog' }).click();
    await retryPage.waitForLoadState('domcontentloaded');
    const recoveredTrigger = retryPage.getByRole('button', { name: 'Keyboard shortcuts' });
    await recoveredTrigger.focus();
    await recoveredTrigger.click();
    const recoveredDialog = await assertAccessibleDialog(retryPage, 'Keyboard Shortcuts');
    await retryPage.keyboard.press('Escape');
    await recoveredDialog.waitFor({ state: 'detached' });
    const retryRestored = await recoveredTrigger.evaluate((element: HTMLElement) => document.activeElement === element);
    const retryUnlocked = await retryPage.evaluate(() => {
      const root = document.getElementById('root');
      return !root?.inert && root?.getAttribute('aria-hidden') !== 'true' && document.body.style.overflow !== 'hidden';
    });
    if (!retryRestored || !retryUnlocked) {
      throw new Error(`Recovered lazy dialog did not restore focus/isolation: ${JSON.stringify({ retryRestored, retryUnlocked })}`);
    }
    await retryPage.close();
    const semanticRegressions = await page.evaluate(() => ({
      nestedInteractive: document.querySelectorAll('button button, button input, button select, button textarea, a button, a input, a select').length,
      unnamedButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .filter((button) => button.offsetParent !== null)
        .filter((button) => !button.getAttribute('aria-label') && !button.title && !button.textContent?.trim()).length,
      focusableCardContainers: document.querySelectorAll('[id^="kanban-card-"][tabindex]').length,
    }));
    if (semanticRegressions.nestedInteractive || semanticRegressions.unnamedButtons || semanticRegressions.focusableCardContainers) {
      throw new Error(`Interactive semantics regression: ${JSON.stringify(semanticRegressions)}`);
    }

    await cardOpeners.first().click();
    const mobileCardDialog = await assertAccessibleDialog(page, /Implement Playwright E2E UI Tests|Keyboard reorder companion/);
    for (const viewport of [{ width: 390, height: 844 }, { width: 412, height: 915 }]) {
      await page.setViewportSize(viewport);
      const drawerTargets = page.locator('.muster-card-detail-target:visible');
      if (await drawerTargets.count() < 5) throw new Error(`Card drawer target inventory is incomplete at ${viewport.width}px`);
      const undersizedTargets = await page.locator([
        'header button:visible', 'header select:visible', 'nav[aria-label="Mobile navigation bar"] button:visible',
        '.muster-card-action:visible', '.muster-card-move:visible', '.muster-touch-target:visible',
        '.muster-account-tab:visible', '.muster-card-detail-target:visible',
      ].join(',')).evaluateAll((elements: HTMLElement[]) => elements
        .map((element) => ({
          label: element.getAttribute('aria-label') || element.title || element.textContent?.trim(),
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        }))
        .filter(({ width, height }) => width < 43.5 || height < 43.5));
      if (undersizedTargets.length) throw new Error(`Undersized ${viewport.width}px mobile targets: ${JSON.stringify(undersizedTargets)}`);
    }
    await mobileCardDialog.getByTitle('Close Task').click();
    await mobileCardDialog.waitFor({ state: 'detached' });
    await assertNoSeriousAxeViolations(page, 'mobile navigation and board');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const transitionSeconds = await page.locator('.muster-btn').first().evaluate((element: HTMLElement) => {
      const duration = getComputedStyle(element).transitionDuration.split(',')[0];
      return duration.endsWith('ms') ? Number.parseFloat(duration) / 1000 : Number.parseFloat(duration);
    });
    if (transitionSeconds > 0.001) throw new Error(`Reduced-motion transition remains ${transitionSeconds}s`);
    console.log('  ✓ Dialog lifecycle, keyboard containment, semantic controls, two-width 44px targets, axe scans, rendered appearance contrast and reduced motion verified.');

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
