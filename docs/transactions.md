# Domain transaction inventory

Muster treats a multi-row domain mutation and its `event` row as one unit. The
service owns the transaction and passes its transaction-scoped
`DatabaseAdapter` to nested services and `EventService`; nested services do
not open a second transaction.

| Operation | Transaction boundary |
| :--- | :--- |
| Project bootstrap | Project, creation event, default board/columns, and protocol document/version/event |
| Board create/update/delete and labels | Board/default columns or label mutation and board event where applicable |
| Column create/update/delete | Column mutation and board-scoped event |
| Comment create/update/delete | Comment mutation and card event |
| Document create/update/status/delete | Document row, version/dependent rows, and event |
| Invitation acceptance | Invitation claim and workspace membership |
| User/agent creation | Principal plus concrete identity row |
| Role seeding/creation and privileged role CRUD | Preset role set or role row plus transaction-scoped audit at REST/MCP boundaries |
| Knowledge base create/link/entity/fact/relation/update/delete | Base/link, entity/fact/relation rows, and linked project events; duplicate links emit no event; deletion emits after the row mutation |
| Card create/update/move/claim/delete and associations | Card/dependent association rows and card events |
| Card lease expiry sweep | Conditional lease clears and `claim_expired` events; concurrent sweepers release each card once and SSE runs after commit |
| Agent lifecycle/offboarding | Existing `AgentService` transaction boundaries, including credential revocation and claim cleanup |
| Privileged REST/MCP mutations | Mutation and its `AuditService.log/logAs` insert share the route/tool transaction: project deletion (workspace-scoped tombstone; no invalid deleted-project event), document status approval, role CRUD/clone, invitation CRUD/acceptance, member role/removal, token issue/revoke, local identity, and agent offboarding |

SQLite uses the adapter's serialized `BEGIN IMMEDIATE` transaction queue. Each
callback receives a scoped adapter; nested service calls join that scope. Root
adapter calls made accidentally from inside a transaction fail fast, while
unrelated root operations wait behind the owner and cannot be absorbed into a
rollback.
PostgreSQL receives the same callback on one checked-out connection; row locks
remain an explicit dialect-specific concern only where a read/check/write race
requires them. Event listeners are best-effort notifications after the event
insert is issued; adapters queue listeners with `afterCommit` so SSE publication
cannot precede a successful commit. PostgreSQL returns its checked-out client
to the pool before awaiting potentially slow listeners while preserving
after-commit callback order. The persisted event row itself remains inside the
transaction.

Privileged MCP mutations fail closed if their service container lacks the root
adapter: they cannot perform the mutation without the transaction that also
writes its audit record. Audit targets derived from created results (for
example role creation/cloning) use the newly-created row ID; document approval
uses `document.approve`, while other status transitions use
`document.status_changed`.

Failure-injection and deterministic SQLite serialization coverage lives in
`tests/domain-transactions.test.ts` and `tests/card-claim.test.ts`. It asserts that failures after dependent
writes or audit inserts remove the entire logical unit, including event rows
and deferred notifications; it also exercises duplicate invitation acceptance,
concurrent project bootstrap/document versioning, token issue/revoke, and
association retry idempotency, scoped nested transactions, and unrelated root
write isolation.

Requests without an idempotency key (for example token issuance) are
deliberately non-idempotent and a transport retry may create a new token. State
transitions that are naturally replayable use conflict-ignore writes and emit
one event only when the underlying row changed.
