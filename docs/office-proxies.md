# Office TLS termination with NGINX or Traefik

Muster works behind your existing office TLS terminator. Certificates can come
from an internal CA, a commercial issuer, or any automated certificate service.
Muster only needs its canonical HTTPS URL and the exact IP address of the
immediate proxy it trusts. The examples here consume PEM certificate files;
they have no ACME, public DNS, or inbound Internet requirement.

Use a hostname resolved by your office DNS, such as `muster.office.example`.
Replace that example throughout the selected proxy configuration and set
`MUSTER_PUBLIC_URL=https://your-hostname`. The certificate's SAN must cover this
hostname, and browsers and CLI clients must trust its issuer. Register the exact
OIDC callback `https://your-hostname/api/v1/auth/callback` with your identity
provider. See [remote deployment configuration](remote-testing.md) for the
remaining OIDC and owner settings.

## Run a dedicated proxy alongside Muster

The optional overlays start one proxy container beside the existing
[`office.compose.yml`](../deploy/office.compose.yml) backend:

| Proxy | Compose overlay | Configuration |
| --- | --- | --- |
| NGINX | [`nginx.compose.yml`](../deploy/office/nginx.compose.yml) | [`nginx.conf`](../deploy/office/nginx.conf) |
| Traefik | [`traefik.compose.yml`](../deploy/office/traefik.compose.yml) | [`traefik.yml`](../deploy/office/traefik.yml), [`traefik-dynamic.yml`](../deploy/office/traefik-dynamic.yml) |

Choose **one** overlay. Set the base deployment's OIDC variables and secret file,
then add these values to `.env.office` alongside the base deployment settings:

```dotenv
MUSTER_PUBLIC_URL=https://muster.office.example
MUSTER_TLS_CERT_FILE=/absolute/path/to/fullchain.pem
MUSTER_TLS_KEY_FILE=/absolute/path/to/privkey.pem
# Choose a subnet that does not overlap your LAN, VPN, or existing containers.
MUSTER_PROXY_SUBNET=172.30.90.0/29
MUSTER_TRUST_PROXY=172.30.90.2
# Required by the dedicated NGINX overlay; reserve a different address.
MUSTER_BACKEND_IP=172.30.90.3
# Optional stable, locally administered MAC addresses; these are the defaults.
MUSTER_DEFAULT_MAC=02:4d:55:53:54:01
MUSTER_BACKEND_MAC=02:4d:55:53:54:02
MUSTER_PROXY_MAC=02:4d:55:53:54:03
# Use this server's actual office LAN address. The default binds loopback only.
MUSTER_HTTPS_BIND_ADDRESS=192.168.10.20
MUSTER_HTTPS_PORT=443
```

Run from the repository root:

```sh
docker compose --env-file .env.office -f deploy/office.compose.yml -f deploy/office/nginx.compose.yml up -d --build
# Or choose Traefik:
docker compose --env-file .env.office -f deploy/office.compose.yml -f deploy/office/traefik.compose.yml up -d --build
```

Use `podman compose` in place of `docker compose` when using Podman. The proxy
overlays require Compose 2.23.2 or newer for
[per-network MAC addresses](https://docs.docker.com/reference/compose-file/services/);
verification used Podman with the Docker Compose 5.5 provider. The proxy
has a fixed address on a dedicated internal network; Muster trusts only that
address. The NGINX overlay also reserves Muster's `MUSTER_BACKEND_IP` on that
network so its upstream address survives backend restarts and recreation.
Muster also retains an outbound network for identity-provider access.

Both overlays assign distinct stable MAC addresses to Muster's outbound and
office-edge endpoints and the proxy's office-edge endpoint. This matches the
verified restart topology and prevents Podman restart behavior from leaving
stale ARP mappings when a container's IP stays fixed but its generated MAC
changes. The defaults are locally administered addresses on isolated Compose
networks; override them if your network policy requires different addresses,
and keep them unique within each network. Existing-proxy deployments retain
their existing network configuration.

The backend's existing published port remains bound to loopback by default.
Keep that default; office clients should use the HTTPS proxy.

The examples use standard HTTPS port 443. If you choose another public port,
include it in `MUSTER_PUBLIC_URL`, the OIDC callback, and the proxy's explicit
`Host`, `X-Forwarded-Host`, and `X-Forwarded-Port` values. NGINX `server_name` and
Traefik's `Host()` rule still contain only the hostname.

## Use your existing NGINX or Traefik

Run only `deploy/office.compose.yml` and add the relevant proxy configuration to
your existing installation. Set its upstream to the reachable Muster backend
address instead of `muster-server:6878`. For a proxy process on the same host,
that will normally be `http://127.0.0.1:6878`; a proxy in a container needs a
shared container network or a reachable private host address. Loopback inside a
proxy container refers to that container itself.

Set `MUSTER_TRUST_PROXY` to the exact source address **as seen by Muster**.
Container NAT may make this different from the proxy's host address. Reserve a
stable address for the proxy, check the engine's network addressing, and verify
the login redirect and Secure session cookie through the proxy before admitting
users. If the proxy is on another host, bind the backend to its private network
address and restrict that port to the proxy at the network firewall. These
examples use HTTP only on the private proxy-to-Muster hop. A deployment that
requires encryption on that hop should use its existing service-mesh or TLS
tunnel and continue to verify the upstream certificate.

For NGINX, include `nginx.conf` in its `http` context, point the certificate paths
at your managed files, run `nginx -t`, then reload. Response buffering and gzip
are disabled, and streaming read timeouts are extended for SSE and Streamable
HTTP MCP. Its request-body limit is 5 MiB, matching Muster's transport ceiling
instead of rejecting otherwise valid bodies above NGINX's 1 MiB default.
Both proxy examples use a three-second upstream connection timeout so a stopped
backend returns a gateway error before the client's request deadline; their
long response-stream settings remain separate.
This simple upstream is resolved when NGINX loads its configuration;
reload NGINX if recreating the backend changes its container IP. See the official
[NGINX proxy module documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

For Traefik, merge the static entrypoint/file-provider settings into its existing
configuration, and put `traefik-dynamic.yml` in its watched dynamic directory.
Keep `forwardedHeaders.insecure: false`; add `trustedIPs` only when another known
proxy genuinely sits in front of it. Negative `flushInterval` flushes immediately,
and a zero response write timeout permits long-lived event streams. The file
provider needs no Docker socket. See Traefik's
[entrypoint settings](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/)
and [response forwarding settings](https://doc.traefik.io/traefik/reference/routing-configuration/http/load-balancing/service/).

Both configurations replace the canonical scheme and host, discard the standard
`Forwarded` header, and replace untrusted client address headers. They preserve
Authorization, cookies, MCP session headers, and SSE replay cursors. Do not add
HTTP Basic authentication in front of Muster's API/MCP paths: it would compete
with Muster's bearer-token authentication. If adding access logs, omit query
strings and credentials because OAuth callbacks can contain authorization codes.

## Certificate renewal and private issuer trust

Supply a full certificate chain and matching private key, mounted read-only.
Renew through your organization's existing process. NGINX must reload after a
certificate change; Traefik must observe a dynamic configuration reload (touch
or rewrite the dynamic configuration after replacing the certificate). These
Compose examples bind individual files, so an atomic replacement on the host
may leave the old inode mounted: recreate `tls-proxy` after renewal, or use a
directory mount that exposes your certificate manager's layout.

An existing Traefik certificate resolver is also supported: replace the router's
`tls: {}` with `tls: { certResolver: your-existing-resolver }` and remove that
router's supplied-certificate configuration/mounts as appropriate. Define the
resolver in your existing static configuration. The dedicated Traefik overlay
connects the proxy only to an internal network, which is sufficient for supplied
certificates. An ACME resolver additionally needs outbound access to the CA
and, for DNS-01, the DNS provider API: attach the proxy to an outbound network
such as the Compose project's `default` network. Existing Traefik deployments
generally already provide that connectivity. Configure any challenge-specific
ingress separately; enabling a resolver alone does not create it.
Caddy or another terminator can
likewise manage certificates independently. DNS-01 can issue public certificates
without exposing the server's public IP; it still requires control of an actual
public DNS domain. Supplied certificates have no such dependency. See Traefik's
[supplied certificate documentation](https://doc.traefik.io/traefik/reference/routing-configuration/http/tls/tls-certificates/)
and [ACME resolver documentation](https://doc.traefik.io/traefik/reference/install-configuration/tls/certificate-resolvers/acme/).

If the **OIDC provider** uses a private CA, add
`-f deploy/private-ca.compose.yml` and set `MUSTER_CA_BUNDLE_FILE` to its trusted
CA PEM bundle. This governs Muster's outbound TLS verification; the public
proxy's certificate is a separate setting. Node-based Muster CLI clients can
use `NODE_EXTRA_CA_CERTS=/path/to/office-ca.pem`; browsers need issuer trust
configured by the operating system or browser administrator. Keep certificate
verification enabled.

## Reproduce the proxy verification

```sh
MUSTER_TEST_ENGINE=podman node scripts/remote-test/proxy-smoke.mjs
```

The standalone probe creates a unique, engine-assigned internal network and
runs NGINX, Traefik, and a synthetic upstream. It mounts the actual configurations
above, generates a disposable CA, and verifies the certificate chain and
hostname, rejection of untrusted certificates, forwarding-header spoof removal,
preserved auth/session headers, and first-event delivery before the delayed
second event for both GET SSE and POST MCP-shaped traffic. It also sends a
JSON POST body above 1 MiB and verifies its byte count and SHA-256 digest at
the upstream. It removes its
containers, network, and private keys, and writes a JSON report under
`scratch/office-proxy-*/report.json`. It never starts Muster or accesses a Muster
database. The full Keycloak/Muster authentication and multi-client suite is
described separately in [remote testing](remote-testing.md).

Verified on 2026-09-04 with NGINX `1.30.4-alpine` and Traefik `v3.7.10` on
Podman: all nine checks passed for each proxy, with first stream events received
in 1–2 ms and the second event delayed by 1.5 seconds. The 2,097,166-byte JSON
body reached each upstream intact; the same probe returned 413 with NGINX's
original default body limit before the 5 MiB setting was added. Both merged Compose
overlays also passed configuration validation. These transport checks against a
synthetic upstream are separate from the full application checks below.

## Full application acceptance verification

The real Muster/Keycloak suite was also run against the production Muster and
client images with PostgreSQL and ten independent CLI/MCP clients:

| Proxy | Verified result | Run |
| --- | --- | --- |
| NGINX `1.30.4-alpine` | 29/29 checks passed, 2026-09-04 | `remote-office-nginx-full` |
| Traefik `v3.7.10` | 29/29 checks passed, 2026-09-04 | `remote-office-traefik-full` |

The checks cover browser OIDC login, device approval, native MCP OAuth/PKCE,
permission and token revocation, concurrent claims/WIP/document revisions, SSE
delivery/replay/capacity, proxy and server restart, stopped upstream recovery,
database outage recovery, backup/restore, and logout. They use fresh isolated
data and a disposable CA with normal certificate verification. The long soak
test remains part of the main Caddy-based verification, rather than these
additional proxy runs.

For these runs only the generated files under `scratch/` were adapted: the
office hostname became `muster.test`, the upstream used the stack's
`muster-backend` network alias, and a separate `sso.muster.test` route served
Keycloak. The TLS proxy retained the generated service name `caddy` so the
unchanged fault-control interface could restart it. NGINX's added SSO route
re-resolved container DNS because Podman changes Keycloak's dynamic IP on
stop/start; Muster's own upstream address remained reserved. A scratch copy of
the suite accepted either HTTP 502 or 504 for an unavailable upstream, since
both are valid gateway failures. All other assertions remained unchanged.

The initial NGINX run exposed its default 60-second upstream connection timeout:
clients exhausted their shorter request deadline before receiving a gateway
error. The explicit three-second timeout fixes that failure while retaining
long-lived SSE responses. The supplied NGINX overlay also reserves Muster's
backend IP to avoid stale DNS resolution after container recreation.
