# Dependency security policy

Muster treats package audit results as a release gate, not as an automatic
upgrade instruction. Dependency changes must preserve the supported Node.js
runtime described in [`docs/runtime-support.md`](runtime-support.md), pass the
protocol and browser regression suites, and avoid forced major upgrades unless
they are reviewed as a compatibility change.

CI runs both of these checks after the reproducible `npm ci` install:

- `npm run audit:runtime` rejects high or critical advisories in production
  dependencies.
- `npm run audit` rejects high or critical advisories in the complete graph,
  including development and build tooling.

Moderate findings are reviewed in context and should be fixed when a compatible
patch exists. A high or critical exception requires a documented owner,
technical rationale, compensating controls, and an explicit expiry date; the CI
gate must not be weakened globally to accommodate an exception.

The application no longer carries a compatibility override for
`@hono/node-server`. Its MCP SDK range now resolves the normal patched 2.1.1
release, whose Node.js floor is below Muster's supported 22.13.0 floor. If a
future advisory requires an override, document the exact package range, reason,
compensating controls, and expiry date here before committing it.
