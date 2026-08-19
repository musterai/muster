# Frontend bundle budget

Muster's pre-split baseline was measured from integration commit
`a146e8f99238ad6e7339c254360c542f25ecd36b` with `npm run build:ui`:

| Build | Minified JavaScript | Gzip JavaScript | Shape |
| :-- | --: | --: | :-- |
| Pre-split baseline | 1,378.46 kB | 368.48 kB | One entry chunk; every product surface loaded up front |
| Split entry shell | 237.96 kB | 73.88 kB | App shell; major views and standalone consent screens excluded |
| Split default-board startup | 485.80 kB | 149.34 kB | Entry, board, Markdown, and their static imports |

The entry shell is 82.7% smaller minified and 79.9% smaller gzip than the
baseline. The complete default-board startup is 64.8% smaller minified and
59.5% smaller gzip. The graph vendor is 767.31 kB / 195.98 kB and is fetched
only for the Knowledge Base boundary alongside its 31.35 kB / 8.18 kB view
chunk.

The production build now writes Vite's manifest plus deterministic Rollup
chunk metadata, and `scripts/check-frontend-bundle.mjs` validates both. The
metadata records each chunk's normalized module IDs, static/dynamic imports,
facade, and exact output file. Content hashes never grant an exception, so the
check is deterministic across builds.
Run `npm run bundle:report` for a report without failing, or
`npm run bundle:check` to enforce `config/frontend-bundle-budget.json`.

The policy has three layers:

- the entry's complete static-import closure is capped at 260 KiB minified / 80 KiB gzip;
- the default board startup (entry plus the board boundary and both static
  closures) is capped at 600 KiB / 180 KiB gzip;
- every ordinary JavaScript chunk is capped at 260 KiB / 80 KiB gzip.

`vendor-graph` has one reviewed exception: 800 KiB / 210 KiB gzip. It contains
`vis-network`, `vis-data`, and their stable graph-only dependencies. That code
is never in the default board startup path and the named split prevents normal
Knowledge Base changes from invalidating the expensive vendor cache. Vite's
generic warning ceiling matches this exception; the manifest check remains the
stricter guard for every ordinary chunk.

The exception is fail-closed. Exactly one Rollup chunk must have the configured
`vendor-graph` identity; every module must belong to the explicit graph-package
allowlist; required `vis-network` and `vis-data` modules must remain present;
and the only direct importer must be the Knowledge Base facade. The checker
cross-binds every normalized Vite source to the same unique Rollup facade and
output file, translates manifest source-key imports to output files, and
requires exact static and dynamic edge equality. It also rejects duplicate
facades/files, default-route reachability, non-canonical or escaped module IDs,
path traversal before package allowlisting, duplicate exception targets,
undocumented exceptions, and stale exceptions. Mutation regressions cover each
case.

Natural lazy boundaries exist for the board, documents, agents, activity,
Knowledge Base/graph, tokens, workspace administration, account/shortcut
dialogs, and the shared CRUD-modal group. App-level project, board, event, and
identity state stays above these boundaries, so navigation does not replace
the live data model. The graph stays inside the Knowledge Base boundary because
graph is its default mode; nesting another lazy import there would turn the
first Knowledge Base visit into an avoidable sequential request waterfall.

Loading states use a polite live region. Resolved views receive a labelled,
programmatically focusable region after keyboard/history navigation. Chunk
failures render a non-secret-bearing alert with an explicit reload action.
