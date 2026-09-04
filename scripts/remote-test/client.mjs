// Internal test driver: each container runs the real CLI with its own home.
// Never publish this driver's port. It is not part of the production image.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const upstream = 'https://muster.test';
const configPath = path.join(os.homedir(), '.muster', 'mcp.json');
let login, proxy, loginUrl, loginExit, mcp;
const streams = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('Client operation timed out');
}
function cli(...args) { return spawn(process.execPath, ['dist/cli.js', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); }
function connection() { return JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.muster; }
async function request(args) {
  const config = connection();
  const headers = { ...config.headers, ...args.headers };
  if (args.anonymous) delete headers.Authorization;
  if (args.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(args.path, config.url), { method: args.method || 'GET', headers,
    body: args.body === undefined ? undefined : JSON.stringify(args.body), signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, headers: Object.fromEntries(response.headers) };
}
async function stopProxy() {
  if (mcp) { await mcp.close(); mcp = undefined; }
  for (const stream of streams.values()) stream.controller.abort();
  streams.clear();
  if (proxy && proxy.exitCode === null) {
    const ended = new Promise(resolve => proxy.once('exit', resolve));
    proxy.kill('SIGTERM'); await ended;
  }
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
}
async function operate(args) {
  if (args.op === 'health') return { ready: true };
  if (args.op === 'login') {
    loginUrl = undefined; loginExit = undefined;
    login = cli('login', '--server', upstream);
    let output = '';
    login.stdout.on('data', chunk => {
      output = (output + chunk).slice(-8000);
      loginUrl = output.match(/https:\/\/muster\.test\/device\?user_code=[A-Z0-9%-]+/)?.[0];
    });
    login.stderr.resume();
    login.once('exit', code => { loginExit = code; });
    return { url: await until(() => { if (loginExit !== undefined) throw new Error(`CLI login exited ${loginExit}`); return loginUrl; }) };
  }
  if (args.op === 'login-status') {
    await until(() => loginExit !== undefined);
    if (loginExit !== 0) throw new Error(`CLI login failed (${loginExit})`);
    const file = path.join(os.homedir(), '.muster', 'credentials.json');
    const credential = JSON.parse(fs.readFileSync(file, 'utf8')).servers[upstream];
    return { loggedIn: true, tracked: Boolean(credential?.token_id), mode: fs.statSync(file).mode & 0o777 };
  }
  if (args.op === 'connect' || args.op === 'reconnect') {
    await stopProxy();
    proxy = cli('connect', '--server', upstream, '--write-config', configPath);
    proxy.stdout.resume(); proxy.stderr.resume();
    await until(() => fs.existsSync(configPath));
    return { mode: fs.statSync(configPath).mode & 0o777, me: await request({ path: '/api/v1/auth/me' }) };
  }
  if (args.op === 'request') return request(args);
  if (args.op === 'ui') {
    const nss = path.join(os.homedir(), '.pki', 'nssdb');
    fs.mkdirSync(nss, { recursive: true });
    if (!fs.existsSync(path.join(nss, 'cert9.db'))) {
      execFileSync('certutil', ['-N', '-d', `sql:${nss}`, '--empty-password']);
      execFileSync('certutil', ['-A', '-d', `sql:${nss}`, '-n', 'Muster test CA', '-t', 'C,,', '-i', '/certs/ca.crt']);
    }
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(new URL('/', connection().url).href);
      await until(async () => (await page.locator('select').first().locator('option').allTextContents()).includes(args.projectName));
      await page.locator('select').first().selectOption({ label: args.projectName });
      await page.getByLabel('Select board').waitFor();
      return { visible: true, board: await page.getByLabel('Select board').inputValue() };
    } finally { await browser.close(); }
  }
  if (args.op === 'mcp') {
    if (!mcp) {
      const config = connection();
      mcp = new Client({ name: 'remote-compose-client', version: '1.0.0' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    }
    return args.name ? await mcp.callTool({ name: args.name, arguments: args.arguments || {} }) : await mcp.listTools();
  }
  if (args.op === 'stream') {
    const config = connection();
    const controller = new AbortController();
    const url = new URL(`/api/v1/projects/${args.project}/events/stream`, config.url);
    const headers = { ...config.headers, ...(args.cursor ? { 'Last-Event-ID': args.cursor } : {}) };
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return { status: response.status, refusal: await response.json() };
    const id = String(streams.size + 1);
    const state = { controller, frames: [], closed: false };
    streams.set(id, state);
    (async () => {
      let buffer = '';
      try {
        for await (const chunk of response.body) {
          buffer += Buffer.from(chunk).toString('utf8');
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = frame.match(/^data: (.+)$/m)?.[1];
            if (data) state.frames.push({ id: frame.match(/^id: (.+)$/m)?.[1], data: JSON.parse(data) });
            if (state.frames.length > 100) state.frames.shift();
          }
        }
      } catch {} finally { state.closed = true; }
    })();
    return { id, status: response.status };
  }
  if (args.op === 'stream-state') {
    const state = streams.get(args.id);
    if (!state) throw new Error('Unknown stream');
    return { frames: state.frames, closed: state.closed };
  }
  if (args.op === 'stream-close') { streams.get(args.id)?.controller.abort(); return { closed: true }; }
  if (args.op === 'logout') {
    const child = cli('logout', '--server', upstream);
    child.stdout.resume(); child.stderr.resume();
    const code = await new Promise(resolve => child.once('exit', resolve));
    if (code !== 0) throw new Error(`CLI logout failed (${code})`);
    return { loggedOut: true, me: await request({ path: '/api/v1/auth/me' }), projects: await request({ path: '/api/v1/projects' }) };
  }
  throw new Error('Unknown operation');
}
const server = http.createServer(async (req, res) => {
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('Request too large'); }
    const result = await operate(body ? JSON.parse(body) : { op: 'health' });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(9100, '0.0.0.0');
process.on('SIGTERM', async () => { login?.kill(); await stopProxy(); server.close(); process.exit(0); });
