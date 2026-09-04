import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = 'https://muster.test';
const fixture = JSON.parse(fs.readFileSync('/test/fixture.json', 'utf8'));
const results = { backend: fixture.backend, clients: fixture.count, started: new Date().toISOString(), checks: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(250);
  }
  throw last || new Error('Condition timed out');
}
async function check(name, fn) {
  const start = Date.now();
  try { await fn(); results.checks.push({ name, passed: true, ms: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { results.checks.push({ name, passed: false, error: error.message, ms: Date.now() - start }); throw error; }
}
async function driver(index, args) {
  const response = await fetch(`http://client-${index}:9100`, { method: 'POST', body: JSON.stringify(args), signal: AbortSignal.timeout(45000) });
  const body = await response.json();
  assert.equal(response.status, 200, `Client ${index}: ${body.error || response.status}`);
  return body;
}
async function api(context, endpoint, method = 'GET', data, status = 200) {
  const response = await context.request.fetch(`${base}/api/v1${endpoint}`, { method, data });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  // Token endpoints can return credentials even when the expected status is
  // wrong. Keep response bodies out of the shareable verification report.
  assert.equal(response.status(), status, `${method} ${endpoint}: expected ${status}, got ${response.status()}`);
  return body;
}
function items(page) { assert.ok(Array.isArray(page.items), 'Expected paginated collection'); return page.items; }
async function fault(action) {
  const id = crypto.randomUUID();
  fs.writeFileSync('/control/request.tmp', JSON.stringify({ id, action }));
  fs.renameSync('/control/request.tmp', '/control/request.json');
  const response = await until(() => {
    if (!fs.existsSync('/control/response.json')) return false;
    const result = JSON.parse(fs.readFileSync('/control/response.json', 'utf8'));
    return result.id === id && result;
  }, 120000);
  assert.ok(!response.error, response.error);
}
const browsers = [];
let browser, owner, project, board, todo, progress, roles, workspace;
const contexts = [];
const agents = [];
const externalResources = new Set();
async function login(username, denied = false) {
  const context = await browser.newContext();
  context.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol === 'https:' && ![base, 'https://sso.muster.test'].includes(url.origin)) externalResources.add(url.origin);
  });
  browsers.push(context);
  const page = await context.newPage();
  const navigations = [];
  page.on('response', response => {
    if (response.request().isNavigationRequest()) {
      const url = new URL(response.url()); navigations.push({ origin: url.origin, path: url.pathname, status: response.status() });
    }
  });
  page.on('requestfailed', request => {
    if (request.isNavigationRequest()) navigations.push({ failure: request.failure()?.errorText });
  });
  await page.goto(`${base}/api/v1/auth/login`);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(fixture.password);
  await page.locator('#kc-login').click();
  try { await page.waitForURL(url => url.origin === base, { timeout: 30000 }); }
  catch { throw new Error(`Login did not return to Muster: ${JSON.stringify(navigations)} ${(await page.textContent('body'))?.replace(/\s+/g, ' ').slice(0, 800)}`); }
  if (denied) {
    assert.match(await page.textContent('body'), /forbidden/);
    const me = await api(context, '/auth/me'); assert.equal(me.authenticated, false);
  } else {
    const me = await api(context, '/auth/me'); assert.equal(me.authenticated, true, (await page.textContent('body'))?.slice(0, 800));
    assert.equal(me.user.email, `${username}@muster.test`);
  }
  return context;
}

async function connectClient(i) {
  const { url } = await driver(i, { op: 'login' });
  const page = await contexts[i - 1].newPage();
  await page.goto(url);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const loginResult = await driver(i, { op: 'login-status' }); assert.equal(loginResult.mode, 0o600);
  assert.equal(loginResult.tracked, true, 'CLI must retain the token ID for remote logout');
  const connection = await driver(i, { op: 'connect' }); assert.equal(connection.mode, 0o600);
  assert.equal(connection.me.body.user.email, `client-${i}@muster.test`);
  assert.equal((await driver(i, { op: 'request', path: '/api/v1/projects', anonymous: true })).status, 401);
  await page.close();
}

try {
  const nss = path.join(os.homedir(), '.pki', 'nssdb');
  fs.mkdirSync(nss, { recursive: true });
  execFileSync('certutil', ['-N', '-d', `sql:${nss}`, '--empty-password']);
  execFileSync('certutil', ['-A', '-d', `sql:${nss}`, '-n', 'Muster test CA', '-t', 'C,,', '-i', '/certs/ca.crt']);
  browser = await chromium.launch({ headless: true });
  await check('HTTPS readiness and canonical Keycloak issuer', async () => {
    await until(async () => (await fetch(`${base}/api/v1/health/ready`)).ok, 180000);
    const metadata = await until(async () => {
      const response = await fetch('https://sso.muster.test/realms/muster/.well-known/openid-configuration');
      return response.ok && response.json();
    }, 180000);
    assert.equal(metadata.issuer, 'https://sso.muster.test/realms/muster');
    assert.ok(metadata.authorization_endpoint.startsWith(metadata.issuer));
    for (let i = 1; i <= fixture.count; i++) await until(() => driver(i, { op: 'health' }));
  });
  await check('Anonymous API/MCP denial and OAuth discovery', async () => {
    assert.equal((await fetch(`${base}/api/v1/projects`)).status, 401);
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /oauth-protected-resource/);
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(resource.resource, `${base}/mcp`);
  });
  await check('First-login discovery recovers after an identity-provider outage', async () => {
    await fault('restart-muster');
    await until(async () => (await fetch(`${base}/api/v1/health/ready`)).ok);
    await fault('stop-keycloak');
    try {
      const response = await fetch(`${base}/api/v1/auth/login`, { redirect: 'manual' });
      assert.equal(response.status, 500);
    } finally { await fault('start-keycloak'); }
    await until(async () => (await fetch('https://sso.muster.test/realms/muster/.well-known/openid-configuration')).ok, 180000);
    const response = await fetch(`${base}/api/v1/auth/login`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.ok(response.headers.get('location').startsWith('https://sso.muster.test/'));
  });
  await check('Real Keycloak owner login and secure session cookie', async () => {
    owner = await login('owner');
    const me = await api(owner, '/auth/me'); workspace = me.workspace.id;
    const cookie = (await owner.cookies()).find(value => value.name === 'muster_session');
    assert.ok(cookie); assert.equal(cookie.secure, true); assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Lax');
    roles = items(await api(owner, `/workspaces/${workspace}/roles`));
  });
  await check('Authenticated uninvited user cannot enter the workspace', () => login('outsider', true));
  await check('Invitations admit contributors and an observer through Keycloak', async () => {
    for (const username of ['observer', ...fixture.users.filter(name => name.startsWith('client-'))]) {
      const role = roles.find(value => value.key === (username === 'observer' ? 'observer' : 'senior_engineer'));
      assert.ok(role);
      await api(owner, `/workspaces/${workspace}/invitations`, 'POST', { email: `${username}@muster.test`, role_id: role.id }, 201);
      const context = await login(username);
      if (username === 'observer') {
        await api(context, '/projects', 'POST', { name: 'Forbidden observer project' }, 403);
      } else contexts.push(context);
    }
  });
  await check('Independent CLI device logins and private local proxy configuration', async () => {
    for (let i = 1; i <= fixture.count; i++) {
      await connectClient(i);
    }
  });
  await check('Denied device approval cannot mint a credential', async () => {
    const device = await api(owner, '/oauth/device/code', 'POST', {});
    const page = await owner.newPage();
    try {
      await page.goto(device.verification_uri_complete);
      await page.getByRole('button', { name: 'Deny', exact: true }).click();
      await page.getByText('Denied', { exact: true }).waitFor();
      const result = await api(owner, '/oauth/token', 'POST', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code }, 400);
      assert.equal(result.error, 'access_denied');
    } finally { await page.close(); }
  });
  await check('Real MCP initialization and tool calls through each local proxy', async () => {
    for (let i = 1; i <= fixture.count; i++) {
      const tools = await driver(i, { op: 'mcp' }); assert.ok(tools.tools.some(tool => tool.name === 'list_projects'));
      const response = await driver(i, { op: 'mcp', name: 'list_projects' }); assert.notEqual(response.isError, true);
    }
  });
  await check('Project creation is visible to all independent clients', async () => {
    project = await api(owner, '/projects', 'POST', { name: `Remote verification ${Date.now()}` }, 201);
    const boards = items(await api(owner, `/projects/${project.id}/boards`));
    board = await api(owner, `/boards/${boards[0].id}`);
    todo = board.columns.find(column => /to do/i.test(column.name)) || board.columns[0];
    progress = board.columns.find(column => /in progress/i.test(column.name)); assert.ok(progress);
    for (let i = 1; i <= fixture.count; i++) {
      const response = await driver(i, { op: 'request', path: `/api/v1/projects/${project.id}` });
      assert.equal(response.status, 200); assert.equal(response.body.name, project.name);
    }
  });
  await check('Concurrent exclusive claims have exactly one winner', async () => {
    for (let i = 1; i <= fixture.count; i++) {
      const agent = await driver(i, { op: 'request', path: '/api/v1/agents', method: 'POST', body: { name: `Client ${i} agent` } });
      assert.equal(agent.status, 201); agents.push(agent.body);
    }
    for (let round = 0; round < 10; round++) {
      const card = await api(owner, `/columns/${todo.id}/cards`, 'POST', { title: `Claim race ${round}` }, 201);
      const claims = await Promise.all(contexts.map((_, i) => driver(i + 1, { op: 'request', path: `/api/v1/cards/${card.id}/claim`, method: 'POST', body: { agent_id: agents[i].id } })));
      assert.equal(claims.filter(result => result.status === 200).length, 1, JSON.stringify(claims.map(result => ({ status: result.status, body: result.body }))));
      assert.ok(claims.filter(result => result.status !== 200).every(result => result.status === 409));
    }
  });
  await check('Browser UI served by each local proxy loads shared server state', async () => {
    for (let i = 1; i <= Math.min(2, fixture.count); i++) {
      const ui = await driver(i, { op: 'ui', projectName: project.name });
      assert.equal(ui.visible, true); assert.equal(ui.board, board.id);
    }
  });
  await check('Concurrent moves respect the final WIP slot', async () => {
    await api(owner, `/columns/${progress.id}`, 'PUT', { wip_limit: 1 });
    const cards = await Promise.all(contexts.map((_, i) => api(owner, `/columns/${todo.id}/cards`, 'POST', { title: `WIP contender ${i}` }, 201)));
    const moves = await Promise.all(cards.map((card, i) => driver(i + 1, { op: 'request', path: `/api/v1/cards/${card.id}/move`, method: 'PATCH', body: { target_column_id: progress.id } })));
    assert.equal(moves.filter(value => value.status === 200).length, 1, JSON.stringify(moves.map(value => ({ status: value.status, body: value.body }))));
    assert.ok(moves.filter(value => value.status !== 200).every(value => [409, 422].includes(value.status)));
  });
  await check('SSE delivery and persisted replay traverse Caddy and local proxy', async () => {
    const streams = await Promise.all(contexts.map((_, i) => driver(i + 1, { op: 'stream', project: project.id })));
    const card = await api(owner, `/columns/${todo.id}/cards`, 'POST', { title: 'Stream observation' }, 201);
    let cursor;
    for (let i = 1; i <= fixture.count; i++) {
      assert.equal(streams[i - 1].status, 200, `Client ${i} SSE admission: ${JSON.stringify(streams[i - 1])}`);
      const frame = await until(async () => (await driver(i, { op: 'stream-state', id: streams[i - 1].id })).frames.find(frame => frame.data.entity_id === card.id));
      assert.ok(frame.id); cursor = frame.id;
      await driver(i, { op: 'stream-close', id: streams[i - 1].id });
    }
    const missed = await api(owner, `/columns/${todo.id}/cards`, 'POST', { title: 'Replay after disconnect' }, 201);
    const replay = await driver(1, { op: 'stream', project: project.id, cursor });
    await until(async () => (await driver(1, { op: 'stream-state', id: replay.id })).frames.some(frame => frame.data.entity_id === missed.id));
    await driver(1, { op: 'stream-close', id: replay.id });
  });
  await check('SSE capacity refuses excess streams and releases capacity on close', async () => {
    // Wait for the earlier disconnects to be observed through both proxy hops.
    await delay(300);
    const streams = [];
    try {
      // The signed-in browser may already own a stream for this principal.
      // Count the additional capacity available through its local proxy.
      let refused = false;
      for (let i = 0; i < 5; i++) {
        const stream = await driver(1, { op: 'stream', project: project.id });
        if (stream.status === 429) { refused = true; break; }
        assert.equal(stream.status, 200); streams.push(stream.id);
      }
      assert.ok(refused); assert.ok(streams.length > 0 && streams.length <= 4);
    } finally { for (const id of streams) await driver(1, { op: 'stream-close', id }); }
    await delay(300);
    const stream = await driver(1, { op: 'stream', project: project.id });
    assert.equal(stream.status, 200); await driver(1, { op: 'stream-close', id: stream.id });
  });
  await check('Caller-supplied comment identity cannot override attribution', async () => {
    const card = await api(owner, `/columns/${todo.id}/cards`, 'POST', { title: 'Attribution verification' }, 201);
    const me = await api(contexts[0], '/auth/me'); const other = await api(contexts[1], '/auth/me');
    const comment = await driver(1, { op: 'request', path: `/api/v1/cards/${card.id}/comments`, method: 'POST', body: { content: 'Verified comment', agent_id: other.user.id } });
    assert.equal(comment.status, 201); assert.equal(comment.body.author_id, me.user.id);
  });
  await check('Concurrent document edits retain separate, ordered revisions', async () => {
    const document = await api(owner, `/projects/${project.id}/documents`, 'POST', { title: 'Concurrent document', content: 'Initial revision' }, 201);
    const edits = await Promise.all(contexts.map((_, i) => driver(i + 1, { op: 'request', path: `/api/v1/documents/${document.id}`, method: 'PUT', body: { content: `Client revision ${i + 1}`, change_summary: `Edit from client ${i + 1}` } })));
    assert.ok(edits.every(edit => edit.status === 200), JSON.stringify(edits.map(edit => edit.status)));
    const versions = items(await api(owner, `/documents/${document.id}/versions`));
    assert.equal(versions.length, fixture.count + 1);
    assert.equal(new Set(versions.map(version => version.version)).size, versions.length);
    const revisions = await Promise.all(versions.map(version => api(owner, `/documents/${document.id}?version=${version.version}`)));
    for (let i = 1; i <= fixture.count; i++) assert.ok(revisions.some(version => version.content === `Client revision ${i}`));
  });
  await check('MCP-native OAuth PKCE, consent, refresh, and replay rejection', async () => {
    const redirect = 'http://127.0.0.1:8765/callback';
    const registered = await api(owner, '/oauth/register', 'POST', { client_name: 'Compose OAuth verification', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, 201);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const params = { client_id: registered.client_id, redirect_uri: redirect, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${base}/mcp`, state: crypto.randomBytes(16).toString('hex') };
    const consentPage = await owner.newPage();
    let callback;
    try {
      await consentPage.route(`${redirect}**`, route => route.fulfill({ status: 200, contentType: 'text/html', body: 'OAuth callback received' }));
      await consentPage.goto(`${base}/api/v1/oauth/authorize?${new URLSearchParams({ ...params, response_type: 'code' })}`);
      await consentPage.getByPlaceholder('Compose OAuth verification').fill('Compose OAuth agent');
      await consentPage.locator('select').nth(1).selectOption(roles.find(role => role.key === 'observer').id);
      await consentPage.getByRole('button', { name: 'Approve', exact: true }).click();
      await consentPage.waitForURL(url => url.href.startsWith(redirect));
      callback = new URL(consentPage.url());
    } finally { await consentPage.close(); }
    assert.equal(callback.searchParams.get('state'), params.state);
    const exchange = { grant_type: 'authorization_code', code: callback.searchParams.get('code'), client_id: registered.client_id, redirect_uri: redirect, code_verifier: verifier, resource: `${base}/mcp` };
    const tokens = await api(owner, '/oauth/token', 'POST', exchange);
    const mcp = new Client({ name: 'native-oauth-test', version: '1.0.0' });
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
      assert.notEqual((await mcp.callTool({ name: 'list_projects', arguments: {} })).isError, true);
      assert.equal((await mcp.callTool({ name: 'create_project', arguments: { name: 'Forbidden OAuth project' } })).isError, true);
    } finally { await mcp.close(); }
    await api(owner, '/oauth/token', 'POST', exchange, 400);
    const refresh = { grant_type: 'refresh_token', client_id: registered.client_id, resource: `${base}/mcp`, refresh_token: tokens.refresh_token };
    const rotated = await api(owner, '/oauth/token', 'POST', refresh); assert.ok(rotated.access_token);
    await api(owner, '/oauth/token', 'POST', refresh, 400);
    assert.equal((await fetch(`${base}/api/v1/projects`, { headers: { Authorization: `Bearer ${rotated.access_token}` } })).status, 401);
  });
  await check('PAT creation and revocation against a live HTTPS server', async () => {
    const token = await api(owner, '/tokens', 'POST', { name: 'Compose PAT' }, 201);
    const headers = { Authorization: `Bearer ${token.token}` };
    assert.equal((await fetch(`${base}/api/v1/projects`, { headers })).status, 200);
    await api(owner, `/tokens/${token.id}`, 'DELETE');
    assert.equal((await fetch(`${base}/api/v1/projects`, { headers })).status, 401);
  });
  await check('Expiring PATs stop authorizing requests', async () => {
    const token = await api(owner, '/tokens', 'POST', { name: 'Expiring verification PAT', expires_at: new Date(Date.now() + 2000).toISOString() }, 201);
    const headers = { Authorization: `Bearer ${token.token}` };
    assert.equal((await fetch(`${base}/api/v1/projects`, { headers })).status, 200);
    await until(async () => (await fetch(`${base}/api/v1/projects`, { headers })).status === 401, 5000);
  });
  await check('Role changes revoke live credentials and enforce fresh admission', async () => {
    const me = await api(contexts[1], '/auth/me');
    await api(owner, `/workspaces/${workspace}/members/${me.user.id}`, 'PUT', { role_id: roles.find(role => role.key === 'observer').id });
    try {
      const denied = await driver(2, { op: 'request', path: `/api/v1/columns/${todo.id}/cards`, method: 'POST', body: { title: 'Forbidden after demotion' } });
      assert.equal(denied.status, 401);
      assert.equal((await api(contexts[1], '/auth/me')).authenticated, false);
      await contexts[1].close();
      contexts[1] = await login('client-2');
      await api(contexts[1], `/columns/${todo.id}/cards`, 'POST', { title: 'Forbidden observer write' }, 403);
    } finally { await api(owner, `/workspaces/${workspace}/members/${me.user.id}`, 'PUT', { role_id: roles.find(role => role.key === 'senior_engineer').id }); }
    await contexts[1].close();
    contexts[1] = await login('client-2');
    await connectClient(2);
  });
  await check('Proxy restart retains upstream login and recovers access', async () => {
    const result = await driver(1, { op: 'reconnect' }); assert.equal(result.me.body.authenticated, true);
    const response = await driver(1, { op: 'request', path: `/api/v1/projects/${project.id}` }); assert.equal(response.status, 200);
  });
  await check('Server and TLS edge restarts preserve sessions, data, and client access', async () => {
    for (const service of ['muster', 'caddy']) {
      await fault(`restart-${service}`);
      await until(async () => (await fetch(`${base}/api/v1/health/ready`)).ok);
      const restored = await api(owner, `/projects/${project.id}`); assert.equal(restored.name, project.name);
      for (let i = 1; i <= fixture.count; i++) {
        const response = await driver(i, { op: 'request', path: `/api/v1/projects/${project.id}` }); assert.equal(response.status, 200);
      }
    }
  });
  await check('Unavailable server produces a visible proxy error and recovers', async () => {
    await fault('stop-muster');
    try {
      const response = await driver(2, { op: 'request', path: '/api/v1/projects' });
      assert.equal(response.status, 502);
    } finally { await fault('start-muster'); }
    await until(async () => (await fetch(`${base}/api/v1/health/ready`)).ok);
    assert.equal((await driver(2, { op: 'request', path: `/api/v1/projects/${project.id}` })).status, 200);
  });
  await check('Backup and restore recover a consistent earlier database state', async () => {
    const before = await api(owner, `/columns/${todo.id}/cards`, 'POST', { title: 'Before backup' }, 201);
    await fault('backup');
    const after = await api(owner, `/columns/${todo.id}/cards`, 'POST', { title: 'After backup' }, 201);
    await fault('restore');
    await until(async () => (await fetch(`${base}/api/v1/health/ready`)).ok);
    assert.equal((await api(owner, `/cards/${before.id}`)).title, 'Before backup');
    await api(owner, `/cards/${after.id}`, 'GET', undefined, 404);
    const response = await driver(2, { op: 'request', path: `/api/v1/cards/${before.id}` }); assert.equal(response.status, 200);
  });
  if (fixture.backend === 'postgres') await check('Database outage fails readiness and recovers without a server restart', async () => {
    await fault('stop-postgres');
    try { assert.equal((await fetch(`${base}/api/v1/health/ready`, { signal: AbortSignal.timeout(20000) })).status, 503); }
    finally { await fault('start-postgres'); }
    await until(async () => (await fetch(`${base}/api/v1/health/ready`)).ok);
    assert.equal((await api(owner, `/projects/${project.id}`)).name, project.name);
  });
  const soakSeconds = Number(process.env.MUSTER_TEST_SOAK_SECONDS || 0);
  if (soakSeconds > 0) await check(`${soakSeconds}s mixed workload across ${fixture.count} clients`, async () => {
    const end = Date.now() + soakSeconds * 1000;
    const latencies = []; let rounds = 0;
    const streams = await Promise.all(contexts.map((_, i) => driver(i + 1, { op: 'stream', project: project.id })));
    while (Date.now() < end) {
      const card = await api(owner, `/columns/${todo.id}/cards`, 'POST', { title: `Soak ${rounds++}` }, 201);
      await Promise.all(contexts.map(async (_, i) => {
        const start = Date.now();
        const response = await driver(i + 1, { op: 'request', path: `/api/v1/cards/${card.id}` });
        assert.equal(response.status, 200); latencies.push(Date.now() - start);
        const mcp = await driver(i + 1, { op: 'mcp', name: 'get_card', arguments: { card_id: card.id } });
        assert.notEqual(mcp.isError, true);
        assert.equal(JSON.parse(mcp.content[0].text).id, card.id);
        const comment = await driver(i + 1, { op: 'request', path: `/api/v1/cards/${card.id}/comments`, method: 'POST', body: { content: `Soak round ${rounds}, client ${i + 1}` } });
        assert.equal(comment.status, 201);
        await until(async () => (await driver(i + 1, { op: 'stream-state', id: streams[i].id })).frames.some(frame => frame.data.entity_id === card.id));
      }));
      await api(owner, `/cards/${card.id}`, 'DELETE', undefined, 204);
      await delay(2000);
      if (rounds % 30 === 0) console.log(`Soak progress: ${rounds} rounds, ${latencies.length} verified reads plus comments and streamed events`);
    }
    for (let i = 1; i <= fixture.count; i++) await driver(i, { op: 'stream-close', id: streams[i - 1].id });
    latencies.sort((a, b) => a - b);
    results.soak = { rounds, requests: latencies.length, p95ms: latencies[Math.floor(latencies.length * 0.95)], maxMs: latencies.at(-1) };
  });
  await check('CLI logout revokes the credential used by the running proxy', async () => {
    const result = await driver(1, { op: 'logout' });
    assert.equal(result.me.status, 200);
    assert.equal(result.me.body.authenticated, false);
    assert.equal(result.projects.status, 401);
  });
  await check('Browser logout removes server-side session access', async () => {
    await api(owner, '/auth/logout', 'POST', {});
    assert.equal((await api(owner, '/auth/me')).authenticated, false);
    await api(owner, '/projects', 'GET', undefined, 401);
  });
  await check('Browser assets are served locally without public font/CDN dependencies', async () => {
    assert.deepEqual([...externalResources], []);
  });
} catch (error) {
  console.error(`FAIL ${error.message}`);
  results.error = error.message;
  process.exitCode = 1;
} finally {
  for (const context of browsers) await context.close().catch(() => {});
  await browser?.close();
  results.finished = new Date().toISOString();
  results.passed = !results.error;
  fs.writeFileSync('/results/report.json', JSON.stringify(results, null, 2), { mode: 0o644 });
}
