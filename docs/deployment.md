# Deploying Muster on a Public Host

Muster ships two very different postures, and picking the wrong one is the
single most consequential deployment mistake:

- **Solo, localhost.** `muster serve` with no configuration. `MUSTER_AUTH_MODE`
  defaults to `open` — every request is trusted, there is no login, and that
  is correct for a single operator on their own machine.
- **Shared, public host.** Anyone who can reach the port can act as whoever
  they can authenticate as, and eventually someone hostile will try. This
  document is about that case.

## Three knobs that are easy to confuse

Almost every question about "is this deployment actually locked down?" comes
from conflating these. They are independent:

| | What it is | What it does *not* do |
| :--- | :--- | :--- |
| **`MUSTER_HOST`** | The validated address the Muster process binds to. Defaults to IPv4 loopback (`127.0.0.1`; `localhost` is accepted). | Does **not** make an explicit `MUSTER_AUTH_MODE=open` safe on a public address. |
| **The listen socket** | Binds to `MUSTER_HOST:MUSTER_PORT`. Loopback spellings (`localhost`, `127.0.0.1`, `::1`) are normalized before binding. | Does **not** bypass authentication policy. |
| **Docker's `ports:` mapping** | The *host-side* address the container's port is published on. This is what actually controls reachability. | Does **not** touch `MUSTER_HOST`, and so does **not** change the auth mode. |

The rule for auth mode itself ([src/config/index.ts](../src/config/index.ts)):

1. If `MUSTER_AUTH_MODE=enforced` is set, it is honored for any bind address.
2. If `MUSTER_AUTH_MODE=open` is set for a non-loopback address, startup fails
   closed with an actionable error. Muster never opens a public socket in
   open mode.
3. When `MUSTER_AUTH_MODE` is omitted, it is `open` for loopback and `enforced`
   for every other address, including `0.0.0.0` and `::`.

**The Docker image always starts in `enforced` mode.** The Dockerfile hardcodes
`ENV MUSTER_HOST=0.0.0.0` and `docker-compose.yml` sets it again, so rule 3
lands on `enforced` for every container. Nothing in the reverse-proxy setup
below changes that. An explicit `MUSTER_AUTH_MODE=open` would contradict the
public container bind and is rejected at startup.

You therefore do not need to set `MUSTER_AUTH_MODE` by hand for a public
deployment; the default is already correct. Setting it explicitly to `enforced`
in your deployment config is still reasonable as documentation-in-place, and
costs nothing. Never set it to `open` while `MUSTER_HOST` is public: Muster will
refuse to start rather than silently weaken the boundary.

Confirm the result rather than trusting it: the startup banner prints the
effective `• Bind:` address and `• Auth:` mode. If it reports a public address,
make sure the mode is `enforced` before exposing the port.

## Compose topology: Caddy is the only edge

Do not publish Muster's port `6878` directly. The checked-in Compose file has
no `ports:` entry for `muster-server`; Caddy is the TLS-terminating edge and
the only service with host publications:

```
Browser ──HTTPS──> Caddy (Compose edge) ──HTTP, fixed 172.30.0.2──> Muster (172.30.0.3:6878)
```

`muster-internal` is a dedicated `internal: true` `/29` network. The Compose
file assigns Caddy `172.30.0.2` and Muster `172.30.0.3`; therefore
`MUSTER_TRUST_PROXY=172.30.0.2` names the actual immediate peer that Express
will see. This is deliberately an exact address, not Docker's changing host
bridge/gateway address and not a private CIDR. If either service address is
changed, update both Compose and `MUSTER_TRUST_PROXY` in the same reviewed
change. Security takes precedence over a topology that silently follows a
changing container IP.

Both services have a second egress-only network so Caddy can complete ACME and
Muster can reach the OIDC issuer/JWKS. That network is never trusted by
Express. The Caddyfile connects to the internal-only `muster-backend` alias,
not to the egress service name, so its backend connection always originates at
the pinned `172.30.0.2` address.

Copy `.env.example` to `.env`, create `secrets/oidc_client_secret` with mode
`0600`, then set `MUSTER_PUBLIC_HOST`, `ACME_EMAIL`, the OIDC values, and the
pinned owner subject. Compose derives `MUSTER_PUBLIC_URL` as
`https://${MUSTER_PUBLIC_HOST}`, so OIDC redirects, cookie policy, CORS, and
the Caddy certificate hostname cannot drift apart. `MUSTER_PROXY_BIND_ADDRESS`
defaults to `127.0.0.1`, so the example is not exposed on all host interfaces.
Change it only to one deliberate public interface when this Caddy container
itself is the Internet-facing TLS edge and its DNS name resolves there.

The static `172.30.0.0/29` pool is intentional. If it overlaps an existing
Docker network, Compose/Docker must fail while creating the network rather
than assigning a surprise source address. Select an unused `/29`, then update
the IPAM subnet, Caddy's `.2` address, Muster's `.3` address, and
`MUSTER_TRUST_PROXY` together before retrying. Never solve an overlap by
removing the static address or trusting the whole replacement subnet.

Do **not** place a host Caddy/nginx in front of this Compose Caddy service as a
drop-in substitution: it reintroduces a host-to-Docker NAT hop and changes the
client-IP trust chain. A multi-proxy design needs its own reviewed edge
configuration that authenticates or otherwise identifies every hop; it is not
the checked-in deployment path.

### Forwarded headers

Muster ignores `X-Forwarded-*` by default. Its proxy allowlist accepts only
exact IPv4/IPv6 addresses (or their single-address `/32`/`/128` spellings),
never broad private ranges or hop counts. Caddy clears and rebuilds
`X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` from the direct
browser connection before proxying. A direct request to Muster therefore
cannot spoof HTTPS or its client address; a request through the configured
Caddy gets the correct public origin, secure cookie behavior, and client IP.

## Environment variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MUSTER_PORT` | `6878` | The port the server listens on, inside the container. Restricting *who can reach* it is the reverse proxy's and Docker's job, not this variable's. |
| `MUSTER_HOST` | `localhost` (normalized to `127.0.0.1`; `0.0.0.0` in Docker) | Validated listener address. `localhost`, `127.0.0.1`, and `::1` are loopback; `0.0.0.0`, `::`, and other addresses are non-loopback. |
| `MUSTER_AUTH_MODE` | derived from `MUSTER_HOST` | `open` or `enforced`. Omitted means open on loopback and enforced elsewhere. Explicit `open` + non-loopback is rejected; explicit `enforced` always works. |
| `MUSTER_DB_PATH` | `data/muster.db` | SQLite database file path. |
| `MUSTER_DB_TYPE` | `sqlite` | Database backend — `sqlite` or `postgres` (see [PostgreSQL, and migrating an existing SQLite install to it](#postgresql-and-migrating-an-existing-sqlite-install-to-it)). |
| `MUSTER_DATABASE_URL` | — | PostgreSQL connection string, e.g. `postgres://user:pass@host:5432/muster`. Required when `MUSTER_DB_TYPE=postgres`; ignored otherwise. |
| `MUSTER_ATTACHMENTS_DIR` | `data/attachments` | Local storage for uploaded attachments. |
| `MUSTER_PUBLIC_URL` | `http://localhost:<port>` | **Required for a public deployment.** The externally-reachable HTTPS origin — OIDC redirect URIs, CORS's allowed origin, the MCP protected-resource metadata's `resource`, and the Device Authorization Grant's `verification_uri` are all derived from this. It must exactly match what's in the browser's address bar, including scheme. Compose derives it from `MUSTER_PUBLIC_HOST` as `https://…`. |
| `MUSTER_OIDC_ISSUER` | — | The OIDC provider's issuer URL (Authentik, Keycloak, Okta, Auth0, Google, GitHub via an OIDC-compatible proxy, etc). Discovery is fetched from `${issuer}/.well-known/openid-configuration`. |
| `MUSTER_OIDC_CLIENT_ID` | — | OAuth client ID registered with the provider. |
| `MUSTER_OIDC_CLIENT_SECRET` | — | OAuth client secret. Keep this out of version control and shell history — pass it via your deployment platform's secret store. It is mutually exclusive with `MUSTER_OIDC_CLIENT_SECRET_FILE`. |
| `MUSTER_OIDC_CLIENT_SECRET_FILE` | — | Read the client secret from a mounted secret file (preferred for Compose/Kubernetes); the value is trimmed and never logged. It is mutually exclusive with `MUSTER_OIDC_CLIENT_SECRET`. |
| `MUSTER_BOOTSTRAP_OWNER_SUBJECT` | — | The OIDC `sub` claim pinned as workspace owner before first login. **Required whenever authentication is enforced** (including every non-loopback deployment); no first-login owner race/policy exists in production. |
| `MUSTER_TRUST_PROXY` | empty (trust none) | Comma-separated exact immediate proxy IPs (single-address `/32`/`/128` is accepted). CIDR ranges and broad private networks are rejected. The Compose topology pins this to `172.30.0.2`. |
| `MUSTER_PROXY_BIND_ADDRESS` | `127.0.0.1` in Compose | Host-side address for Compose Caddy ports 80/443. Change it only to an intentional public interface when Caddy is the TLS edge. |
| `MUSTER_PUBLIC_HOST` | — | DNS hostname only for Compose Caddy's automatic TLS site; it must agree with `MUSTER_PUBLIC_URL`. |
| `ACME_EMAIL` | — | ACME contact email for Compose Caddy. |

OIDC is required for a public deployment: without it, `/auth/login` returns
`503 oidc_not_configured` and nobody can sign in at all.

OIDC authentication and workspace admission remain separate. A local account
must be active and either be a member, match a pending invitation, or match the
configured bootstrap owner. Enforced deployments require the pin before the
database or listener opens, so the old first-successful-login ownership policy
is limited to zero-config loopback open development. Anonymous `/auth/me`
responses retain the login-state shape but do not disclose workspace metadata.

The liveness probe is `GET /api/v1/health/live` and returns only
`{"status":"alive"}`. Readiness is `GET /api/v1/health/ready`; it performs a
`SELECT 1` and returns `503 {"status":"not_ready"}` on failure without
leaking database details. The legacy `/api/v1/health` URL remains only as an
unauthenticated compatibility alias for that same metadata-free readiness
contract; it no longer reveals version, uptime, database driver/mode, or
latency.

## Backing up and restoring the SQLite database

Muster runs SQLite in WAL mode, so a plain file copy of `muster.db` while the
server is running can miss data still sitting in the `-wal` file.

**Backup (server running):**

```bash
sqlite3 data/muster.db ".backup data/muster-backup-$(date +%Y%m%d).db"
```

`.backup` is a proper SQLite API call, not a file copy — it's safe against a
concurrently-running server.

**Backup (server stopped):** a plain copy of `muster.db`, `muster.db-wal`, and
`muster.db-shm` (if present) is safe once the process has exited cleanly.

**Restore:**

```bash
# Stop Muster first.
cp data/muster-backup-20260101.db data/muster.db
rm -f data/muster.db-wal data/muster.db-shm   # avoid replaying a stale WAL
# Start Muster.
```

**Docker Compose:** the `muster-data` named volume holds the whole `data/`
directory. Back it up with:

```bash
docker run --rm -v muster_muster-data:/data -v "$(pwd)":/backup \
  alpine tar czf /backup/muster-data-backup.tar.gz -C /data .
```

Restore the same way, with the server stopped (`docker compose stop
muster-server`) so nothing is mid-write:

```bash
docker run --rm -v muster_muster-data:/data -v "$(pwd)":/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/muster-data-backup.tar.gz -C /data"
```

## PostgreSQL, and migrating an existing SQLite install to it

SQLite (the default) is a single synchronous connection — fine for one
operator, but it becomes the throughput ceiling once several agents are
polling boards, claiming cards, and streaming events concurrently. Switch to
PostgreSQL for that case:

```bash
export MUSTER_DB_TYPE=postgres
export MUSTER_DATABASE_URL=postgres://muster:<password>@<host>:5432/muster
```

Nothing else changes — every service is written against the same
`DatabaseAdapter` interface, and the migrations in `src/db/migrations/` run
against either backend (the migrator translates the handful of
SQLite-specific expressions itself). Point `MUSTER_DATABASE_URL` at an empty
database and start Muster; migrations create the schema on first boot,
exactly like the SQLite path does.

### Moving existing data from SQLite to PostgreSQL

There's no bespoke export tool for this — [pgloader](https://pgloader.io/)
already does SQLite→PostgreSQL migration well, handling type coercion and
batching for you. General procedure:

1. Stand up the target PostgreSQL database and run Muster against it once
   with an empty `data/` so migrations create the schema:

   ```bash
   MUSTER_DB_TYPE=postgres MUSTER_DATABASE_URL=postgres://muster:<password>@<host>:5432/muster \
     node dist/index.js &
   # wait for "Migrations applied" in the log, then stop it (Ctrl-C) —
   # you want the empty schema in place, not the server running yet.
   ```

2. Stop Muster against the *old* SQLite database and take a clean backup
   (see above) so pgloader reads a consistent file, not one mid-write.

3. Run pgloader with a load script that truncates the target tables first
   (the schema already exists from step 1, so pgloader should load data
   into it rather than trying to create its own):

   ```lisp
   LOAD DATABASE
        FROM sqlite:///path/to/muster-backup.db
        INTO postgresql://muster:<password>@<host>:5432/muster

   WITH include no drop, create no tables, create no indexes, reset sequences,
        data only

   SET work_mem to '256MB', maintenance_work_mem to '512MB';
   ```

   Save that as `migrate.load` and run `pgloader migrate.load`.

4. Things worth checking afterward, since Muster's schema has a few
   properties pgloader's defaults don't always handle cleanly:
   - **Timestamps are `TEXT`, not native**: every `created_at`/`updated_at`
     column is an ISO-8601 string (`2026-01-01T00:00:00.000Z`), not a
     Postgres `timestamp`. This is deliberate — the app compares and sorts
     them as text throughout — so make sure pgloader isn't casting them to
     a native timestamp type; `data only` mode against an already-created
     schema (step 1) avoids this, since the column types are fixed before
     pgloader ever runs.
   - **Booleans are `INTEGER` (0/1)**: same reasoning — `archived`,
     `is_epic`, etc. are integers, not Postgres `boolean`. Same fix: create
     the schema first, load data only.
   - **The `"column"` table**: a reserved word in both dialects, always
     double-quoted in Muster's own SQL. Verify pgloader preserved the exact
     table name rather than renaming it.
   - **Foreign keys**: run `\d+ card` (or any FK-heavy table) in `psql`
     afterward and spot-check a few rows resolve — a partial or reordered
     load can leave orphaned references that constraints (correctly) would
     have rejected during a live INSERT but that a bulk loader may not
     enforce mid-transfer.
   - **Sequences**: `reset sequences` above only matters if a future
     migration ever adds a Postgres `SERIAL`/`IDENTITY` column — today every
     ID in this schema is an application-generated ULID, so there's nothing
     to reset. Left in the script defensively.

5. Point `MUSTER_DATABASE_URL` at the migrated database and start Muster for
   real. Verify a board loads and a card claim succeeds before decommissioning
   the old SQLite file.

### Concurrency behavior differs between backends

`CardService.claim()`'s exclusivity guarantee (MUS-14 — two agents can never
both claim the same card) is enforced differently depending on backend:
SQLite gets it for free from `better-sqlite3`'s single physical connection,
which serializes every transaction globally regardless of table or row.
PostgreSQL has a real connection pool with genuine concurrent transactions,
so the same guarantee is enforced explicitly with `SELECT ... FOR UPDATE`
row locking inside the claim transaction
([src/services/card.service.ts](../src/services/card.service.ts)). This is
covered by a dedicated test that fires concurrent claims through a real
connection pool against a live Postgres instance
([tests/postgres-adapter.test.ts](../tests/postgres-adapter.test.ts)) rather
than relying on a mock, since a mock cannot exercise real lock contention.

## What's already handled for you

These are implemented in the server itself — nothing to configure beyond the
environment variables above:

- **CORS** is restricted to `MUSTER_PUBLIC_URL`; no other origin can read API
  responses with credentials attached.
- **Security headers** (HSTS when served over HTTPS, `X-Content-Type-Options`,
  `Referrer-Policy`, a CSP scoped to the SPA's actual external resources).
- **Rate limiting** on the OAuth/device-grant endpoints, `/mcp`, and failed
  bearer-token attempts, all returning `429` with `Retry-After`.
- **Request body limits** — `5MB` per request, with a tighter per-field cap on
  document/card content specifically.
- **Audit log** of every privileged action (role changes, membership,
  tokens, invitations, document approvals, project deletion), visible under
  Admin → Audit Log to workspace admins.

## Checklist before going live

- [ ] Startup banner reads the expected `Bind:` address and `Auth:     enforced`.
      (Don't infer either value from the `ports:` mapping — they're unrelated.)
- [ ] `MUSTER_PUBLIC_URL` set to the exact HTTPS origin end users will use.
- [ ] `MUSTER_OIDC_*` configured and a test login completes end-to-end.
- [ ] Compose Caddy is the only TLS edge. `muster-server` has no host port,
      `MUSTER_TRUST_PROXY` remains the fixed `172.30.0.2` peer, and any public
      `MUSTER_PROXY_BIND_ADDRESS` was chosen intentionally.
- [ ] A backup of `data/` (or the `muster-data` volume) is scheduled.
- [ ] `MUSTER_BOOTSTRAP_OWNER_SUBJECT` is set to the intended OIDC `sub`.
