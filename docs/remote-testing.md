# Remote deployment verification

This is the implementation of the testing plan approved on 2026-09-04:
one enforced Muster server, a real Keycloak provider, HTTPS, independent
`muster login` / `muster connect` clients, and browser/MCP verification.
The local project MCP service was unavailable during implementation; project
cards, approved-document lookup, and knowledge-base updates remain pending.

See the [dated verification report](remote-verification-2026-09-04.md) for
completed runs, the issues found, and the limits of the validation.

## Run the isolated stack

Requirements: Node.js (the repository-supported version), OpenSSL, and either
Docker with Compose or Podman with a Compose provider. No DNS changes, public
IP, public CA account, or operator login is required.

```sh
npm run test:remote
MUSTER_TEST_ENGINE=podman npm run test:remote
MUSTER_TEST_BACKEND=postgres npm run test:remote
MUSTER_TEST_CLIENTS=10 MUSTER_TEST_SOAK_SECONDS=1800 npm run test:remote
```

Each invocation generates a private `scratch/remote-<unique-id>/` directory
with an inspectable `compose.json`, seven-day test certificates, random
credentials, an imported Keycloak realm, and a private results directory.
The generated JSON is a standard Compose file. Both clients and the runner
use the same locally built image; each client container has its own home directory.
The CA is explicitly trusted by Node and Chromium; certificate verification
is never disabled and nothing is installed in the host trust store.

Only Caddy publishes a host port, on loopback with an automatically selected
port. `muster.test` and `sso.muster.test` resolve inside the Compose network.
The pinned `172.29.87.0/29` proxy network must be unused; conflicts fail
instead of silently broadening the proxy allowlist. The harness does not
mount any existing Muster data or credentials. Its database is named
`remote-test.db`, and all volumes belong to that run's Compose project.

The `test` command tears down the run's containers, networks,
and volumes. Reports and private logs remain in `scratch/`. Do not upload raw
logs or fixture directories: authentication redirects can contain temporary
authorization codes. Only the sanitized `results/report.json` is intended
as a CI artifact.

For an inspectable retained run:

```sh
MUSTER_TEST_KEEP=1 MUSTER_TEST_RUN=remote-investigation npm run test:remote
# Use the same engine on subsequent commands:
MUSTER_TEST_RUN=remote-investigation node scripts/remote-test/stack.mjs ps
MUSTER_TEST_RUN=remote-investigation node scripts/remote-test/stack.mjs down
```

`prepare`, `build muster runner`, `up`, and `run` are also available as separate
steps. A run name must begin with `remote-`. `prepare` refuses existing run
directories. `down` affects only the selected Compose project. Shared image
caches are retained. Running the individual steps manually leaves resources
running after success or failure; issue `down` explicitly when finished.

## Test scope

- Production Docker image build and real native SQLite loading.
- HTTPS discovery with consistent public origins and real Keycloak browser
  authentication, including unavailable-provider recovery.
- Bootstrap ownership, invitations, denied admission, and observer restrictions.
- Independent CLI device approvals and private credential/configuration files.
- MCP SDK initialization and tool calls through each local proxy.
- Concurrent exclusive claims and competition for the final WIP slot.
- SSE delivery and persisted replay through both proxy hops.
- Caller-supplied identity cannot override authenticated comment attribution.
- Native MCP OAuth registration, consent, PKCE exchange, role restriction,
  refresh rotation, and replay revocation.
- PAT creation/revocation, CLI logout, and browser session logout.
- Server/edge/proxy restarts, persisted state, and PostgreSQL outage recovery.
- Database backup/restore, including verification that later writes disappear
  while earlier state and credentials remain usable.
- Locally served fonts and browser assets, without a public font/CDN dependency.
- Optional sustained multi-client workload with latency reporting.

CI runs the functional suite with ten clients on both database backends. This
also exercises enough simultaneous browser and CLI streams to detect a proxy
that accidentally groups every client into its own IP quota.

Fault injection uses a small file-based request channel. The host driver
allowlists actions against named services in the current Compose project.
The test containers never receive the Docker/Podman socket.

Run the ordinary tests separately with `npm test`; use an isolated PostgreSQL
database with `MUSTER_TEST_PG_URL` for database-specific integration coverage.
No passing test claim should include a scenario absent from its result report.

`results/resources.jsonl` samples the current Compose project's container
resource usage once a minute during a run. The optional soak performs reads,
MCP reads, comment writes, card creation/deletion, and verifies live event delivery to
each client. It is a correctness/recovery workload, not a maximum-throughput
benchmark or evidence for horizontal scaling to multiple Muster servers.

## Certificates and office networks

For ready-to-use NGINX and Traefik configurations, optional Compose overlays,
certificate renewal, and a reproducible proxy check, see
[office TLS termination](office-proxies.md).

Muster does not depend on a particular certificate authority. The generated CA
belongs exclusively to this disposable test environment. A deployed server
can use any of the following:

1. **Caddy-managed public certificates.** The existing root `docker-compose.yml`
   and `Caddyfile` provide this deployment. For a server without inbound public
   reachability, DNS-01 is an option using the appropriate Caddy DNS-provider
   module and narrowly scoped DNS credentials; HTTP-01 cannot validate an
   unreachable service. Public validation and internal routing are separate.
2. **Supplied certificates.** Configure Caddy with `tls <fullchain> <private-key>`
   and read-only runtime mounts, or use a reverse proxy that already manages
   the office certificates. Renew files through the chosen certificate system
   and reload the terminating proxy as that system requires.
3. **An existing office TLS terminator.** Deploy Muster on a private backend
   network reachable only by that terminator. Set `MUSTER_PUBLIC_URL` to the
   browser-facing HTTPS origin and `MUSTER_TRUST_PROXY` to the terminator's
   exact immediate peer IP as observed by Muster. The terminator must overwrite
   forwarded headers, pass MCP requests, and stream SSE without buffering.
   Do not add another proxy in front of the existing Compose edge without
   configuring and validating the resulting trust chain.

The standalone `deploy/office.compose.yml` implements the third option with
SQLite persistence and the production Muster image. It does not include Caddy
or require `ACME_EMAIL`. Set these values in an untracked `.env.office` file:

```dotenv
MUSTER_PUBLIC_URL=https://muster.office.example
MUSTER_TRUST_PROXY=192.0.2.10
MUSTER_OIDC_ISSUER=https://identity.office.example/realms/muster
MUSTER_OIDC_CLIENT_ID=muster
MUSTER_BOOTSTRAP_OWNER_SUBJECT=replace-with-owner-subject
MUSTER_BACKEND_BIND_ADDRESS=127.0.0.1
```

The addresses above are placeholders. `MUSTER_TRUST_PROXY` must match the
immediate socket peer seen inside Muster, which may be a bridge gateway for
a proxy running on the container host. For a terminator on another machine,
bind the backend to one deliberate private host interface and restrict access
to that terminator in the network firewall. The backend hop is HTTP; protect
it as part of the office network. Use a separate encrypted backend connection
if the network cannot provide that boundary.

Create `secrets/oidc_client_secret` as described in the deployment guide, then:

```sh
docker compose --env-file .env.office -f deploy/office.compose.yml up -d --build
# Optional: trust a private CA for outbound OIDC HTTPS calls.
# Set MUSTER_CA_BUNDLE_FILE to an absolute PEM bundle path in .env.office.
docker compose --env-file .env.office -f deploy/office.compose.yml \
  -f deploy/private-ca.compose.yml up -d --build
```

Configure the existing TLS terminator to overwrite forwarding headers and
stream SSE/MCP responses. In Caddy, `header_up X-Forwarded-For {remote_host}`
replaces an incoming value. Do not combine that operation with deletion of
the same header: Caddy applies deletion after replacement. The root Caddyfile
contains the complete working forwarding configuration.

For private CA certificates, mount the CA bundle in Muster and Node-based
clients and set `NODE_EXTRA_CA_CERTS` to its path. Trust it in user browsers
through the organization's normal trust distribution. The OIDC issuer's CA
also needs to be trusted by Muster. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`
or globally ignore certificate errors. Keycloak issuer, registered redirect
URI, public origin, and certificate names must agree across all clients.

Keycloak provisioning uses the documented realm-import mechanism and production
`start` mode with its own PostgreSQL database. Test identities and credentials
must not become production fixtures. See the official
[Keycloak container guide](https://www.keycloak.org/server/containers),
[hostname configuration](https://www.keycloak.org/server/hostname), and
[Caddy TLS directive](https://caddyserver.com/docs/caddyfile/directives/tls).
