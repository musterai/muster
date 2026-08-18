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

## Do not publish port 6878 directly

`docker-compose.yml`'s default `ports: ["6878:6878"]` is a getting-started
convenience, not a deployment topology. Muster's own HTTP server has no TLS
support and no public-facing hardening beyond what's described in this
document — it is designed to sit behind a reverse proxy that terminates TLS,
not to be the public-facing edge itself.

**Correct topology:**

```
Internet → reverse proxy (TLS termination, port 443) → Muster (port 6878, reachable only from the proxy)
```

Change `docker-compose.yml` to publish the port on the host's loopback
interface only:

```yaml
ports:
  - "127.0.0.1:6878:6878"
```

or drop the `ports:` mapping entirely and put the reverse proxy in the same
Docker network, reaching Muster by its service name.

Either way, **this is a reachability change in addition to Muster's own bind
policy.** Inside the container Muster binds `0.0.0.0:6878` because the image
sets `MUSTER_HOST=0.0.0.0`; that non-loopback bind automatically selects
`enforced` mode. The `127.0.0.1` in the port mapping is an address on the
*host*, not a value Muster reads.

## Reverse proxy

### Caddy (recommended — automatic TLS via Let's Encrypt)

```caddyfile
muster.example.com {
    # Muster sends `X-Accel-Buffering: no` and periodic SSE keep-alives. Keep
    # the response streaming so browser EventSource clients receive updates
    # promptly instead of waiting for a proxy buffer to fill.
    reverse_proxy 127.0.0.1:6878
}
```

That's the whole config. Caddy obtains and renews the certificate itself.
Restart Caddy after changes; no separate certbot step.

`127.0.0.1:6878` assumes Caddy runs on the host and Muster publishes to
loopback. If Caddy is a container on the same Docker network instead, use the
service name — `reverse_proxy muster-server:6878` — and drop the `ports:`
mapping entirely. The same substitution applies to the nginx `proxy_pass`
below.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name muster.example.com;

    ssl_certificate     /etc/letsencrypt/live/muster.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/muster.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:6878;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE (the live board updates) and MCP Streamable HTTP both need a
        # long-lived, unbuffered connection — the two settings below are not
        # optional for either to work.
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

server {
    listen 80;
    server_name muster.example.com;
    return 301 https://$host$request_uri;
}
```

Obtain the certificate with `certbot --nginx -d muster.example.com` (or your
existing ACME tooling) before starting nginx with this config.

### SSE connection and queue policy

The server bounds each process to 100 live SSE clients, with per-principal,
per-IP, and per-workspace limits of 4, 20, and 50 respectively. A client that
does not drain writes is allowed at most 100 queued events or 256 KiB and is
disconnected after 30 seconds without a `drain` notification. Capacity
refusals return HTTP 429 with `error: "sse_capacity_exceeded"` and a
`Retry-After` header. The broadcaster's counters (`activeClients`, sent and
dropped events, dropped clients, backpressure drops, and capacity rejections)
are available through its process-local `getStats()` observability hook; event
bodies are never included in logs or those counters.

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
| `MUSTER_PUBLIC_URL` | `http://localhost:<port>` | **Required for a public deployment.** The externally-reachable HTTPS origin — OIDC redirect URIs, CORS's allowed origin, the MCP protected-resource metadata's `resource`, and the Device Authorization Grant's `verification_uri` are all derived from this. It must exactly match what's in the browser's address bar, including scheme. |
| `MUSTER_OIDC_ISSUER` | — | The OIDC provider's issuer URL (Authentik, Keycloak, Okta, Auth0, Google, GitHub via an OIDC-compatible proxy, etc). Discovery is fetched from `${issuer}/.well-known/openid-configuration`. |
| `MUSTER_OIDC_CLIENT_ID` | — | OAuth client ID registered with the provider. |
| `MUSTER_OIDC_CLIENT_SECRET` | — | OAuth client secret. Keep this out of version control and shell history — pass it via your deployment platform's secret store. |
| `MUSTER_BOOTSTRAP_OWNER_SUBJECT` | — | The OIDC `sub` claim to pin as workspace owner in advance, bypassing invitation admission. Optional — the first person to sign in becomes owner automatically if this is unset. |

OIDC is required for a public deployment: without it, `/auth/login` returns
`503 oidc_not_configured` and nobody can sign in at all.

OIDC authentication and workspace admission remain separate. A local account
must be active and either be a member, match a pending invitation, or be the
configured bootstrap owner. When no bootstrap subject is pinned, the
first-user membership check and owner insert run in one database transaction,
so concurrent first logins cannot both become owners. Anonymous `/auth/me`
responses retain the login-state shape but do not disclose workspace metadata.

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
- [ ] Reverse proxy terminates TLS, and Muster is not reachable except through
      it — `docker-compose.yml`'s `ports:` mapping publishes to `127.0.0.1`
      only, or there is no `ports:` mapping and the proxy shares the Docker
      network.
- [ ] A backup of `data/` (or the `muster-data` volume) is scheduled.
- [ ] `MUSTER_BOOTSTRAP_OWNER_SUBJECT` set, or you're prepared to be the very
      first person to sign in.
