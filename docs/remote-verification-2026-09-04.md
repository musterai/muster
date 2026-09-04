# Remote deployment verification — 2026-09-04

This report records the local verification of one enforced Muster server with
independent remote clients, real Keycloak authentication, and HTTPS. The
reproducible harness and deployment instructions are in
[remote testing](remote-testing.md); supplied-certificate NGINX and Traefik
deployments are in [office TLS termination](office-proxies.md).

## Environment and isolation

Runs used Podman 6.0.2 with Compose 5.5.0 on Linux ARM64, Node.js 24.18.1,
Keycloak 26.7.3, PostgreSQL 16.13, and Caddy 2.11.4. Each acceptance run had ten
separate CLI containers with independent home directories and credentials.
Browser authentication used real Chromium and Keycloak pages. HTTPS verification
remained enabled, with a disposable test CA explicitly trusted inside the test
environment. No public certificate authority or public ingress was required.

Final runs reused server image ID
`f1dc9062da04a15dbe766d70d23788638b4a90e84e22b7e2adeed10df50eb835`
and client image ID
`dc06744623a8fe8cc6096e74885ff67ab3ed2e71c82307803f26349c4c479f4e`.

Each run had its own databases, volumes, credentials, and Compose project.
The existing `data/muster.db` was never used. The concurrent repeat-run group
used a separate private proxy subnet from the soak. Container resource samples
therefore include contention from other isolated test work on the same VM;
latencies are observations, not production capacity estimates.

## Completed checks

| Verification | Result |
| --- | --- |
| Fresh SQLite acceptance runs, ten clients each | Three runs, 28/28 checks in each |
| Fresh PostgreSQL functional runs, ten clients each | Two runs, 29/29 checks in each |
| Fresh PostgreSQL acceptance plus 30-minute soak, ten clients | 30/30 checks; 849 workload rounds |
| Unit and integration tests with real PostgreSQL | 76 files, 690/690 tests; no skips |
| Existing MCP protocol E2E | 13/13 checks |
| Existing browser E2E | Passed, including navigation, dialogs, keyboard, touch targets, accessibility, appearance modes, and reduced motion |
| Production build and frontend bundle budget | Passed |
| NGINX 1.30.4 supplied-certificate transport probe | 9/9 checks |
| Traefik 3.7.10 supplied-certificate transport probe | 9/9 checks |
| NGINX full Keycloak/PostgreSQL acceptance, ten clients | 29/29 checks |
| Traefik full Keycloak/PostgreSQL acceptance, ten clients | 29/29 checks |
| Office Compose configurations | Both proxy overlays and private-CA overlay validated |
| Dependency audit at high-severity gate | Passed; zero high/critical, three moderate advisories remained |

The acceptance checks cover admission and permissions, device login, native MCP
OAuth/PKCE/consent/refresh, PAT expiry and revocation, concurrent claims and WIP
limits, document revisions, authenticated attribution, SSE delivery/replay and
capacity, restarts, unavailable services, persistence, backup/restore, logout,
and local browser assets. PostgreSQL additionally receives an actual database
outage and must recover without restarting Muster. See each sanitized JSON
report for the exact assertions and durations.

The fresh functional reports are `remote-sqlite-final1` (09:25:59–09:27:47 UTC),
`remote-sqlite-final2` (09:27:53–09:29:39 UTC), `remote-sqlite-final3`
(09:29:46–09:31:32 UTC), `remote-postgres-final1` (09:31:38–09:33:24 UTC), and
`remote-postgres-final2` (09:33:30–09:35:17 UTC). Each report is stored at
`scratch/<run>/results/report.json`. Failed exploratory runs used different
directories and are not counted as passing final runs.

The office proxy probes use the actual supplied configurations and a synthetic
upstream. They verify CA and hostname validation, rejection of an unknown CA,
forwarded-header spoof removal, preservation of authentication and MCP headers,
an intact 2,097,166-byte request body, and streamed GET/POST responses. First
events arrived in 1–2 ms, before the deliberately delayed second event at
approximately 1.5 seconds. The final probe report is
`scratch/office-proxy-1788515080780-d4552a/report.json`.

Separate full acceptance runs also passed behind NGINX
(`remote-office-nginx-full`, 09:43:18–09:45:06 UTC) and Traefik
(`remote-office-traefik-full`, finished 09:47:43 UTC). Each used PostgreSQL and
ten clients. Generated configurations changed the canonical test hostname and
upstream alias and added a separate Keycloak SSO route; the edge retained the
service name `caddy` for fault injection. NGINX's added SSO route re-resolved
container DNS after provider restarts. A scratch suite copy accepted either
502 or 504 for an unavailable upstream; all other assertions were unchanged.
The long soak used Caddy. See [office TLS termination](office-proxies.md) for
the exact adaptations and deployment settings.

## Thirty-minute soak

`remote-pg-final-soak` passed all 30 checks, including its 1,800-second workload
and subsequent CLI/browser logout checks. The complete acceptance run lasted
09:26:07–09:57:57 UTC; the timed workload ran for 1,800.495 seconds.

- 849 rounds across ten clients.
- 8,490 verified REST card reads, 8,490 real MCP card reads, and 8,490 comment
  writes, plus 849 card creations and deletions.
- Each client observed the current card on its live event stream in every round.
- Measured REST read latency: 34 ms at the 95th percentile, 136 ms maximum.
  These timings include the runner-to-client-driver request and the two proxy
  hops. MCP/write latency was not separately measured. The report's `requests`
  field counts REST reads only, not all operations.

There were 31 one-minute container resource samples. From 09:29 UTC onward,
Muster's reported container memory ranged from 284.1 to 364.8 MB and ended at
364.8 MB. Caddy ranged from 22.98 to 26.25 MB; the application PostgreSQL
container from 66.21 to 111.1 MB; Keycloak from 618 to 623.3 MB. These are
observations under this workload, not recommended memory limits. An isolated
MCP lifecycle probe found its request objects collectible and no retained
timers; neither that probe nor this finite soak proves an absence of all leaks.

The final report is `scratch/remote-pg-final-soak/results/report.json`, with
resource samples alongside it in `resources.jsonl`. All eight final acceptance
stacks (three SQLite, three PostgreSQL/Caddy including the soak, and two office
proxy runs) were torn down and their scoped containers, networks, and database
volumes verified absent. Private logs and generated main-harness fixtures remain
in ignored scratch directories for local investigation.

## Issues found and corrected

| Failure observed | Correction |
| --- | --- |
| Production runtime attempted to reinstall native dependencies without build tools | Build/prune dependencies in the builder and copy them into the matching runtime image |
| A failed first OIDC discovery poisoned subsequent login attempts | Clear the failed discovery promise so the next login can retry |
| Keycloak's callback was rejected for its `session_state` parameter | Accept the bounded optional protocol parameter |
| Native MCP consent sent parameters rejected by strict API schemas | Send only the parameters accepted by the details and consent endpoints |
| CLI login failed to record its token ID from paginated token results, preventing logout revocation | Follow token-list cursors and retain the matching credential ID |
| A local proxy delayed opening a quiet event stream | Flush upstream response headers before piping the stream |
| Caddy deleted the forwarded headers it had just set, grouping clients into the proxy's SSE quota | Overwrite the headers without a conflicting deletion rule |
| PostgreSQL disconnects could surface as unhandled client/pool errors | Handle disconnects, reject affected transactions, release broken clients, and remove listeners before pool reuse |
| Returning to a board triggered project reloads and reset navigation | Base project loading on the parsed route without navigation-state dependencies |
| Browser startup depended on externally hosted fonts | Bundle fonts locally and restrict the related CSP sources to the application |
| NGINX rejected otherwise valid requests above its default 1 MiB cap | Match Muster's 5 MiB request ceiling |
| NGINX could retain an old dynamically assigned backend IP after recreation | Reserve Muster's backend IP in the dedicated NGINX Compose overlay; document reload requirements for existing installations |
| An unavailable backend could exceed the client's request deadline behind the office proxies | Set a short upstream connection timeout while retaining long streaming read/write timeouts |
| Podman endpoint MAC changes left stale ARP entries during restarts | Reserve per-network MAC addresses in the test stack and dedicated office overlays |
| ARM64 test-client SQLite prebuild required a newer glibc | Build the test client's native module from source and verify it loads during image creation |

Regression tests accompany the application fixes. The frontend bundle checker
also handles Vite's font source provenance while retaining strict output and
JavaScript path validation. A high-severity dependency advisory was resolved by
updating the affected transitive `fast-uri` version in the lockfile. Existing
PostgreSQL test fixtures were brought into line with required workflow lanes.

## Reproduction and limits

From the repository root, use Docker by default or set `MUSTER_TEST_ENGINE=podman`:

```sh
MUSTER_TEST_CLIENTS=10 MUSTER_TEST_BACKEND=sqlite npm run test:remote
MUSTER_TEST_CLIENTS=10 MUSTER_TEST_BACKEND=postgres npm run test:remote
MUSTER_TEST_CLIENTS=10 MUSTER_TEST_BACKEND=postgres MUSTER_TEST_SOAK_SECONDS=1800 npm run test:remote
node scripts/remote-test/proxy-smoke.mjs
```

Run these sequentially because the standard harness uses a fixed, narrowly
trusted proxy subnet. Reports remain under each private `scratch/` run directory;
only sanitized `report.json` files are suitable for publication. Raw logs and
fixtures can contain credentials or temporary authorization codes.

CI now includes the ten-client SQLite/PostgreSQL functional matrix and both
office proxy probes. Those new hosted CI jobs have not been executed as part of
this local verification. This work tests one Muster server; it does not establish
multi-server high availability, maximum capacity, or production certificate
renewal for a particular organization's infrastructure.

The local project MCP endpoint was unavailable, so project-card comments,
approved-document lookup, and knowledge-base updates could not be performed.
The implementation followed the user's explicit approval to build and fix the
remote deployment setup.
