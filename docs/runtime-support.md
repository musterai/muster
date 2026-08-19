# Node.js runtime support policy

Muster supports the current maintained Node.js LTS lines, with a minimum of
Node.js **22.13.0**. The floor is the oldest Node 22 patch accepted by the
current development dependency graph (including the `jsdom` and Vite tooling
engines); it is not a promise to support end-of-life patch releases.

The production image is pinned to Node.js **24.18.1** on Alpine 3.23. CI runs
the complete build, test, and dependency-audit gate on Node.js **22** (the
oldest supported major) and Node.js **24** (the production major). A local
installation must satisfy the `engines.node` declaration in `package.json`.

## Support window

Node 18 and Node 20 are end-of-life and are not supported. At the time this
policy was adopted, Node 22 and Node 24 were maintained LTS lines. The
supported floor advances when the oldest supported major approaches end of
life, or when the dependency graph requires a newer maintained patch line.

This policy is intentionally about maintained *majors*, not a permanently
frozen patch number. The exact floor is kept in `package.json`; the CI matrix
must always include that major and the production image's major.

## Release and upgrade procedure

Before a Node LTS line reaches end of life, the release owner must:

1. Select the next maintained LTS major and verify its native dependencies,
   TypeScript toolchain, browser tooling, and production startup.
2. Update `package.json` (`engines.node`), `package-lock.json`, Docker builder
   and runtime images, the CI matrix, and these development/deployment notes in
   one reviewed change.
3. Remove compatibility-only dependency overrides when the supported runtime
   makes the normal patched dependency graph safe. Overrides require a
   documented reason and an expiry plan; they must not preserve an EOL major.
4. Run `npm ci`, `npm run audit:runtime`, `npm run audit`, `npm run build`, and
   `npm test` on the minimum supported CI line and the production line.

The runtime change is complete only when the package engine, lockfile, CI,
Docker image, and documentation agree. Container smoke testing is a
deployment-environment check and may run in deployment CI; it is not required
on a developer laptop to validate this policy change.
