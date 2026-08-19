# Dependency security policy

Muster treats package audit results as a release gate, not as an automatic
upgrade instruction. Dependency changes must preserve the supported Node.js
runtime, pass the protocol and browser regression suites, and avoid forced
major upgrades unless they are reviewed as a compatibility change.

CI runs both of these checks after the reproducible `npm ci` install:

- `npm run audit:runtime` rejects high or critical advisories in production
  dependencies.
- `npm run audit` rejects high or critical advisories in the complete graph,
  including development and build tooling.

Moderate findings are reviewed in context and should be fixed when a compatible
patch exists. A high or critical exception requires a documented owner,
technical rationale, compensating controls, and an explicit expiry date; the CI
gate must not be weakened globally to accommodate an exception.

The `@hono/node-server` override intentionally selects patched `1.19.15` rather
than the 2.x line pulled by npm's generic audit fix. Version 2 requires Node 20,
while Muster currently declares support for Node 18 and newer. Remove the
override only when the application runtime floor is deliberately raised or the
MCP SDK no longer resolves the vulnerable 1.x release.
