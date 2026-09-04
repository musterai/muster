// Exercise the actual office proxy configs against a disposable synthetic upstream.
// No Muster database, host trust-store changes, engine socket mount, or published ports.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode === 'upstream') {
  http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/events' || req.url === '/mcp') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Mcp-Session-Id': 'probe-session' });
      res.write(`id: 1\ndata: ${JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers })}\n\n`);
      const timer = setTimeout(() => res.end('id: 2\ndata: complete\n\n'), 1500);
      res.on('close', () => clearTimeout(timer));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'probe=value; HttpOnly; Secure; SameSite=Lax' });
      const body = Buffer.concat(chunks);
      res.end(JSON.stringify({ headers: req.headers, method: req.method, url: req.url,
        bodyBytes: body.length, bodySha256: crypto.createHash('sha256').update(body).digest('hex') }));
    }
  }).listen(6878, '0.0.0.0');
} else if (mode === 'probe') {
  const hostname = process.env.PROXY_HOST;
  const ca = fs.readFileSync('/certs/ca.crt');
  const spoofedHeaders = {
    Host: 'muster.office.example', 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'attacker.example',
    'X-Forwarded-Port': '81', 'X-Forwarded-For': '198.51.100.71', 'X-Real-IP': '198.51.100.72',
    Forwarded: 'for=198.51.100.73;proto=http;host=attacker.example',
    Authorization: 'Bearer disposable-probe', Cookie: 'probe=value', Origin: 'https://muster.office.example',
    'Last-Event-ID': 'previous-event', 'Mcp-Session-Id': 'existing-session',
  };
  function request(route = '/headers', options = {}) {
    const { body: requestBody, ...requestOptions } = options;
    return new Promise((resolve, reject) => {
      const started = performance.now();
      let firstByteMs;
      const req = https.request({ hostname, port: 443, servername: 'muster.office.example', ca,
        path: route, method: 'GET', headers: spoofedHeaders, ...requestOptions }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { firstByteMs ??= performance.now() - started; body += chunk; });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, firstByteMs, totalMs: performance.now() - started }));
      });
      req.on('error', reject);
      req.setTimeout(6000, () => req.destroy(new Error('Proxy probe timed out')));
      req.end(requestBody ?? (options.method === 'POST' ? '{"jsonrpc":"2.0","id":1,"method":"initialize"}' : undefined));
    });
  }
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if ((await request()).status === 200) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(ready, 'Proxy must become ready with a verified certificate');
  await assert.rejects(request('/headers', { ca: undefined }), error => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code));
  // Keep SNI on the configured certificate while testing an incorrect expected
  // identity; an unknown SNI may select Traefik's unrelated default certificate.
  await assert.rejects(request('/headers', { checkServerIdentity: (_host, cert) => tls.checkServerIdentity('wrong.office.example', cert) }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  const response = await request('/api/v1/health/ready?probe=1');
  assert.equal(response.status, 200);
  const upstream = JSON.parse(response.body);
  assert.equal(upstream.url, '/api/v1/health/ready?probe=1');
  const headers = upstream.headers;
  assert.equal(headers.host, 'muster.office.example');
  assert.equal(headers['x-forwarded-host'], 'muster.office.example');
  assert.equal(headers['x-forwarded-proto'], 'https');
  assert.equal(headers['x-forwarded-port'], '443');
  assert.equal(headers.forwarded, undefined);
  const ownIPs = Object.values(os.networkInterfaces()).flat().filter(Boolean).map(address => address.address);
  assert(ownIPs.includes(headers['x-forwarded-for']), 'Forwarded client address must be the actual client, with spoofed chain removed');
  assert(ownIPs.includes(headers['x-real-ip']), 'Real client address must replace the spoofed value');
  for (const name of ['authorization', 'cookie', 'origin', 'last-event-id', 'mcp-session-id']) {
    const expected = Object.entries(spoofedHeaders).find(([key]) => key.toLowerCase() === name)[1];
    assert.equal(headers[name], expected, `${name} must pass through unchanged`);
  }
  assert.equal(response.headers['set-cookie'][0], 'probe=value; HttpOnly; Secure; SameSite=Lax');
  // Larger than NGINX's default 1 MiB, within Muster's 5 MiB transport ceiling.
  const largeBody = JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024) });
  const largeResponse = await request('/api/v1/documents', { method: 'POST', body: largeBody,
    headers: { ...spoofedHeaders, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(largeBody)) } });
  assert.equal(largeResponse.status, 200, 'A document body between 1 MiB and 5 MiB must reach Muster');
  const largeUpstream = JSON.parse(largeResponse.body);
  assert.equal(largeUpstream.method, 'POST');
  assert.equal(largeUpstream.bodyBytes, Buffer.byteLength(largeBody));
  assert.equal(largeUpstream.bodySha256, crypto.createHash('sha256').update(largeBody).digest('hex'), 'Large request body must arrive intact');
  const streams = [];
  for (const [route, method] of [['/events', 'GET'], ['/mcp', 'POST']]) {
    const stream = await request(route, { method });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers['mcp-session-id'], 'probe-session');
    assert.match(stream.headers['content-type'], /text\/event-stream/);
    assert.match(stream.body, /id: 1\ndata: .*\n\nid: 2\ndata: complete\n\n/);
    assert(stream.firstByteMs < 1000, `${route} must deliver its first event before the delayed second event`);
    assert(stream.totalMs >= 1400, 'The upstream must actually delay its second event');
    const event = JSON.parse(stream.body.split('\n')[1].slice(6));
    assert.equal(event.method, method);
    if (method === 'POST') assert.equal(JSON.parse(event.body).method, 'initialize');
    streams.push({ route, firstByteMs: Math.round(stream.firstByteMs), totalMs: Math.round(stream.totalMs) });
  }
  console.log(JSON.stringify({ proxy: hostname, passed: true, checks: ['trusted CA accepted', 'untrusted CA rejected', 'wrong hostname rejected', 'canonical forwarding headers', 'spoofed client IP removed', 'auth/cookie/MCP headers preserved', 'POST body above 1 MiB preserved', 'GET SSE streaming', 'POST MCP streaming'], largeBodyBytes: Buffer.byteLength(largeBody), streams }));
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const engine = process.env.MUSTER_TEST_ENGINE || 'docker';
  assert(['docker', 'podman'].includes(engine), 'MUSTER_TEST_ENGINE must be docker or podman');
  const run = `office-proxy-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(root, 'scratch', run);
  const network = `${run}-network`;
  const names = [];
  const results = { run, startedAt: new Date().toISOString(), proxies: [] };
  const images = { nginx: 'docker.io/library/nginx:1.30.4-alpine', traefik: 'docker.io/library/traefik:v3.7.10', node: 'docker.io/library/node:24.18.1-alpine3.23' };
  const invoke = (program, args, options = {}) => execFileSync(program, args, { cwd: root, stdio: 'pipe', timeout: 180_000, ...options });
  const cli = (...args) => invoke(engine, args).toString().trim();
  const mount = (source, target) => ['-v', `${source}:${target}:ro`];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  function start(name, args) {
    const container = `${run}-${name}`;
    names.push(container);
    cli('run', '-d', '--name', container, '--network', network, '--network-alias', name, ...args);
  }
  try {
    for (const image of Object.values(images)) cli('pull', image);
    const openssl = (...args) => invoke('openssl', args, { cwd: dir });
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=Disposable office proxy test CA', '-addext', 'basicConstraints=critical,CA:TRUE');
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'privkey.pem', '-out', 'server.csr', '-subj', '/CN=muster.office.example');
    fs.writeFileSync(path.join(dir, 'extensions'), 'subjectAltName=DNS:muster.office.example\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'fullchain.pem', '-days', '2', '-extfile', 'extensions');
    for (const file of ['ca.key', 'privkey.pem']) fs.chmodSync(path.join(dir, file), 0o600);
    fs.mkdirSync(path.join(dir, 'dynamic'));
    fs.copyFileSync(path.join(root, 'deploy/office/traefik-dynamic.yml'), path.join(dir, 'dynamic/muster.yml'));
    cli('network', 'create', '--internal', network);
    const scriptMount = mount(fileURLToPath(import.meta.url), '/test/proxy-smoke.mjs');
    start('muster-server', [...scriptMount, images.node, 'node', '/test/proxy-smoke.mjs', 'upstream']);
    const certMounts = [...mount(path.join(dir, 'fullchain.pem'), '/certs/fullchain.pem'), ...mount(path.join(dir, 'privkey.pem'), '/certs/privkey.pem')];
    start('nginx', [...mount(path.join(root, 'deploy/office/nginx.conf'), '/etc/nginx/conf.d/default.conf'), ...certMounts, images.nginx]);
    cli('exec', `${run}-nginx`, 'nginx', '-t');
    start('traefik', [...mount(path.join(root, 'deploy/office/traefik.yml'), '/etc/traefik/traefik.yml'), ...mount(path.join(dir, 'dynamic'), '/etc/traefik/dynamic'), ...certMounts, images.traefik]);
    for (const proxy of ['nginx', 'traefik']) {
      const probeName = `${run}-${proxy}-probe`;
      names.push(probeName);
      const output = cli('run', '--rm', '--name', probeName, '--network', network, '-e', `PROXY_HOST=${proxy}`, ...scriptMount,
        ...mount(path.join(dir, 'ca.crt'), '/certs/ca.crt'), images.node, 'node', '/test/proxy-smoke.mjs', 'probe');
      const result = { ...JSON.parse(output), image: images[proxy], imageId: cli('image', 'inspect', images[proxy], '--format', '{{.Id}}') };
      results.proxies.push(result);
      console.log(`${proxy}: ${result.checks.length} checks passed; stream first bytes ${result.streams.map(stream => `${stream.route} ${stream.firstByteMs}ms`).join(', ')}`);
    }
    results.passed = true;
  } catch (error) {
    results.passed = false;
    results.error = error.message;
    if (error.stderr) console.error(error.stderr.toString());
    process.exitCode = 1;
  } finally {
    for (const name of names.reverse()) { try { cli('rm', '-f', name); } catch {} }
    try { cli('network', 'rm', network); } catch {}
    for (const file of ['ca.key', 'privkey.pem']) fs.rmSync(path.join(dir, file), { force: true });
    results.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(results, null, 2));
    console.log(`Office proxy report: ${path.join(dir, 'report.json')}`);
  }
}
