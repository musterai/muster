// A disposable Compose project. No operator credentials or production volumes.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const command = process.argv[2] || 'test';
const engine = process.env.MUSTER_TEST_ENGINE || 'docker';
if (!['docker', 'podman'].includes(engine)) throw new Error('MUSTER_TEST_ENGINE must be docker or podman');
const backend = process.env.MUSTER_TEST_BACKEND || 'sqlite';
if (!['sqlite', 'postgres'].includes(backend)) throw new Error('MUSTER_TEST_BACKEND must be sqlite or postgres');
const count = Number(process.env.MUSTER_TEST_CLIENTS || 2);
if (!Number.isInteger(count) || count < 2 || count > 10) throw new Error('Use 2–10 clients');
const soakSeconds = Number(process.env.MUSTER_TEST_SOAK_SECONDS || 0);
if (!Number.isInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 7200) throw new Error('Soak duration must be 0–7200 seconds');
const run = process.env.MUSTER_TEST_RUN || `remote-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
if (!/^remote-[a-z0-9-]+$/.test(run)) throw new Error('Run name must match remote-[a-z0-9-]+');
const dir = path.join(root, 'scratch', run);
const composePath = path.join(dir, 'compose.json');
const invoke = (program, args, options = {}) => execFileSync(program, args, { cwd: root, stdio: 'inherit', ...options });
const compose = (...args) => invoke(engine, ['compose', '-p', run, '-f', composePath, ...args]);
const write = (name, value, mode = 0o600) => fs.writeFileSync(path.join(dir, name), value, { mode });

function prepare() {
  if (fs.existsSync(dir)) throw new Error(`Refusing to overwrite an existing run: ${dir}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const openssl = args => invoke('openssl', args, { cwd: dir, stdio: 'pipe' });
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '7', '-subj', '/CN=Muster disposable test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=muster.test']);
  write('extensions', 'subjectAltName=DNS:muster.test,DNS:sso.muster.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '7', '-extfile', 'extensions']);
  for (const name of ['ca.key', 'server.key']) fs.chmodSync(path.join(dir, name), 0o600);
  const secret = crypto.randomBytes(24).toString('hex');
  const password = crypto.randomBytes(24).toString('hex');
  const dbPassword = crypto.randomBytes(24).toString('hex');
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const users = ['owner', 'observer', 'outsider', ...Array.from({ length: count }, (_, i) => `client-${i + 1}`)];
  write('oidc-secret', secret, 0o644); // read-only inside the unprivileged server; enclosing host directory is 0700
  write('fixture.json', JSON.stringify({ password, users, backend, run, count }), 0o644);
  write('realm.json', JSON.stringify({ realm: 'muster', enabled: true, sslRequired: 'external',
    clients: [{ clientId: 'muster', secret, publicClient: false, standardFlowEnabled: true, directAccessGrantsEnabled: false,
      redirectUris: ['https://muster.test/api/v1/auth/callback'], webOrigins: ['https://muster.test'] }],
    users: users.map(username => ({ ...(username === 'owner' ? { id: ownerId } : {}), username, enabled: true,
      email: `${username}@muster.test`, emailVerified: true, firstName: username, lastName: 'Test',
      credentials: [{ type: 'password', value: password, temporary: false }] })),
  }), 0o644);
  const mount = (file, target) => `${path.join(dir, file)}:${target}:ro`;
  const client = {
    image: 'localhost/muster-remote-client:test', build: { context: root, dockerfile: 'deploy/remote-test/Client.Dockerfile' },
    init: true, environment: { NODE_EXTRA_CA_CERTS: '/certs/ca.crt' },
    volumes: [mount('ca.crt', '/certs/ca.crt'), `${root}/scripts/remote-test:/app/scripts/remote-test:ro`], networks: ['clients'],
  };
  const services = {
    postgres: { image: 'docker.io/library/postgres:16.13', environment: { POSTGRES_USER: 'muster', POSTGRES_PASSWORD: dbPassword, POSTGRES_DB: 'muster_test' },
      volumes: ['postgres:/var/lib/postgresql/data'], networks: ['backend'],
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U muster -d muster_test'], interval: '2s', timeout: '3s', retries: 40 } },
    'keycloak-db': { image: 'docker.io/library/postgres:16.13', environment: { POSTGRES_USER: 'keycloak', POSTGRES_PASSWORD: dbPassword, POSTGRES_DB: 'keycloak' },
      volumes: ['keycloak-db:/var/lib/postgresql/data'], networks: ['identity'],
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U keycloak'], interval: '2s', timeout: '3s', retries: 40 } },
    keycloak: { image: 'quay.io/keycloak/keycloak:26.7.3', command: ['start', '--import-realm'],
      environment: { KC_DB: 'postgres', KC_DB_URL: 'jdbc:postgresql://keycloak-db/keycloak', KC_DB_USERNAME: 'keycloak', KC_DB_PASSWORD: dbPassword,
        KC_HOSTNAME: 'https://sso.muster.test', KC_HTTP_ENABLED: 'true', KC_PROXY_HEADERS: 'xforwarded', KC_HEALTH_ENABLED: 'true' },
      volumes: [mount('realm.json', '/opt/keycloak/data/import/muster-realm.json')], networks: ['identity'],
      depends_on: { 'keycloak-db': { condition: 'service_healthy' } } },
    muster: { image: 'localhost/muster-remote-server:test', build: { context: root, dockerfile: 'Dockerfile' },
      environment: { MUSTER_HOST: '0.0.0.0', MUSTER_AUTH_MODE: 'enforced', MUSTER_PUBLIC_URL: 'https://muster.test',
        MUSTER_OIDC_ISSUER: 'https://sso.muster.test/realms/muster', MUSTER_OIDC_CLIENT_ID: 'muster',
        MUSTER_OIDC_CLIENT_SECRET_FILE: '/run/secrets/oidc', MUSTER_BOOTSTRAP_OWNER_SUBJECT: ownerId,
        MUSTER_TRUST_PROXY: '172.29.87.2', MUSTER_DB_PATH: '/app/data/remote-test.db', MUSTER_DB_TYPE: backend,
        MUSTER_DATABASE_URL: `postgres://muster:${dbPassword}@postgres:5432/muster_test`, NODE_EXTRA_CA_CERTS: '/certs/ca.crt' },
      volumes: ['muster:/app/data', mount('oidc-secret', '/run/secrets/oidc'), mount('ca.crt', '/certs/ca.crt')],
      networks: { backend: {}, edge: { ipv4_address: '172.29.87.3', aliases: ['muster-backend'] }, clients: {} },
      depends_on: { postgres: { condition: 'service_healthy' } },
      healthcheck: { test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:6878/api/v1/health/ready'], interval: '2s', timeout: '3s', retries: 40 } },
    caddy: { image: 'docker.io/library/caddy:2.11.4-alpine',
      volumes: [`${root}/deploy/remote-test/Caddyfile:/etc/caddy/Caddyfile:ro`, mount('server.crt', '/certs/server.crt'), mount('server.key', '/certs/server.key')],
      ports: ['127.0.0.1::443'],
      networks: { edge: { ipv4_address: '172.29.87.2' }, identity: {}, clients: { aliases: ['muster.test', 'sso.muster.test'] } } },
    runner: { ...client, profiles: ['test'], command: ['node', 'scripts/remote-test/suite.mjs'],
      volumes: [...client.volumes, mount('fixture.json', '/test/fixture.json'), `${dir}/results:/results`, `${dir}/control:/control`],
      environment: { ...client.environment, MUSTER_TEST_CLIENTS: String(count), MUSTER_TEST_SOAK_SECONDS: String(soakSeconds) } },
  };
  for (let i = 1; i <= count; i++) services[`client-${i}`] = { ...client };
  for (const [name, service] of Object.entries(services)) {
    if (Array.isArray(service.networks)) service.networks = Object.fromEntries(service.networks.map(network => [network, {}]));
    for (const [network, endpoint] of Object.entries(service.networks)) {
      // Podman can assign a different random MAC on restart while preserving
      // the IP. Stable L2 identities prevent stale ARP entries from turning a
      // short process restart into an unrelated minute-long network outage.
      const suffix = crypto.createHash('sha256').update(`${name}:${network}`).digest('hex').slice(0, 10).match(/../g).join(':');
      endpoint.mac_address = `02:${suffix}`;
    }
  }
  fs.mkdirSync(path.join(dir, 'results'));
  fs.mkdirSync(path.join(dir, 'control'), { mode: 0o700 });
  write('compose.json', JSON.stringify({ services, networks: {
    edge: { internal: true, ipam: { config: [{ subnet: '172.29.87.0/29' }] } },
    backend: { internal: true }, identity: { internal: true }, clients: {},
  }, volumes: { muster: {}, postgres: {}, 'keycloak-db': {} } }, null, 2));
  write('run.json', JSON.stringify({ run, backend, count, engine }, null, 2));
  console.log(`Prepared ${run}: ${backend}, ${count} clients. Artifacts: ${dir}/results`);
}

// The browser runner can request only these scoped fault operations. It never
// receives the container engine socket or access to unrelated containers.
async function runSuite() {
  const requestPath = path.join(dir, 'control', 'request.json');
  const responsePath = path.join(dir, 'control', 'response.json');
  for (const file of [requestPath, responsePath]) if (fs.existsSync(file)) fs.unlinkSync(file);
  const child = spawn(engine, ['compose', '-p', run, '-f', composePath, 'run', '--rm', '--no-deps', 'runner'], { cwd: root, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const statsTimer = setInterval(() => {
    try {
      const ids = invoke(engine, ['compose', '-p', run, '-f', composePath, 'ps', '-q'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
      if (!ids.length) return;
      const stats = invoke(engine, ['stats', '--no-stream', '--format', 'json', ...ids], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
      fs.appendFileSync(path.join(dir, 'results', 'resources.jsonl'), JSON.stringify({ at: new Date().toISOString(), stats }) + '\n', { mode: 0o644 });
    } catch { /* A stopped fault-injection target can temporarily disappear. */ }
  }, 60000);
  let lastId;
  const timer = setInterval(() => {
    if (!fs.existsSync(requestPath)) return;
    let request; try { request = JSON.parse(fs.readFileSync(requestPath, 'utf8')); } catch { return; }
    if (request.id === lastId) return;
    lastId = request.id;
    const allowed = /^(stop|start|restart)-(keycloak|muster|caddy|postgres|client-2)$/;
    const match = allowed.exec(request.action);
    let error;
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
      if (request.action === 'backup') {
        if (metadata.backend === 'sqlite') compose('exec', '-T', 'muster', 'node', '--input-type=module', '-e', "import Database from 'better-sqlite3'; const db = new Database('/app/data/remote-test.db'); await db.backup('/app/data/remote-backup.db'); db.close();");
        else compose('exec', '-T', 'postgres', 'pg_dump', '-U', 'muster', '-d', 'muster_test', '-Fc', '-f', '/tmp/remote-backup.dump');
      } else if (request.action === 'restore') {
        compose('stop', 'muster');
        try {
          if (metadata.backend === 'sqlite') compose('run', '--rm', '--no-deps', '--entrypoint', 'node', 'muster', '--input-type=module', '-e', "import fs from 'node:fs'; fs.copyFileSync('/app/data/remote-backup.db', '/app/data/remote-test.db'); for (const suffix of ['-wal', '-shm']) fs.rmSync('/app/data/remote-test.db' + suffix, { force: true });");
          else compose('exec', '-T', 'postgres', 'pg_restore', '-U', 'muster', '-d', 'muster_test', '--clean', '--if-exists', '/tmp/remote-backup.dump');
        } finally { compose('start', 'muster'); }
      } else {
        if (!match) throw new Error('Unsupported fault action');
        compose(match[1], match[2]);
      }
    } catch (failure) { error = failure.message; }
    fs.writeFileSync(responsePath, JSON.stringify({ id: request.id, error }), { mode: 0o600 });
  }, 300);
  try {
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    if (code !== 0) throw new Error(`Remote suite exited ${code}`);
  } finally {
    clearInterval(timer); clearInterval(statsTimer);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}

async function test() {
  prepare();
  let failed = false;
  const cleanup = () => { try { compose('down', '--volumes', '--remove-orphans', '--timeout', '10'); } catch { process.exitCode = 1; } };
  try {
    compose('build', 'muster', 'runner');
    compose('up', '-d');
    await runSuite();
  } catch (error) {
    failed = true;
    console.error('Remote verification failed. See the result report and scoped container logs.');
    const report = path.join(dir, 'results', 'report.json');
    if (!fs.existsSync(report)) fs.writeFileSync(report, JSON.stringify({ backend, clients: count, passed: false, error: 'Stack build, startup, or runner launch failed. Inspect the private logs.' }, null, 2), { mode: 0o644 });
  } finally {
    // Logs can contain auth callback URLs: keep them private and out of CI stdout.
    try {
      const fd = fs.openSync(path.join(dir, 'results', 'containers.log'), 'w', 0o600);
      try { invoke(engine, ['compose', '-p', run, '-f', composePath, 'logs', '--no-color'], { stdio: ['ignore', fd, fd] }); } finally { fs.closeSync(fd); }
    } catch {
      failed = true;
      console.error('Could not collect container logs; continuing scoped cleanup.');
    }
    if (process.env.MUSTER_TEST_KEEP !== '1') cleanup();
    else console.log(`Retained isolated stack. Cleanup: MUSTER_TEST_RUN=${run} MUSTER_TEST_ENGINE=${engine} node scripts/remote-test/stack.mjs down`);
    if (failed) process.exitCode = 1;
  }
}

if (command === 'prepare') prepare();
else if (command === 'test') await test();
else if (['up', 'down', 'run', 'logs', 'build', 'restart', 'stop', 'start', 'ps'].includes(command)) {
  if (!fs.existsSync(composePath)) throw new Error('Select an existing run with MUSTER_TEST_RUN');
  if (command === 'down') compose('down', '--volumes', '--remove-orphans', '--timeout', '10');
  else if (command === 'up') compose('up', '-d');
  else if (command === 'run') await runSuite();
  else compose(command, ...process.argv.slice(3));
} else throw new Error('Use prepare, test, up, run, down, logs, build, restart, stop, start, or ps');
