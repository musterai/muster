# Domain transaction inventory

Muster treats a multi-row domain mutation and its `event` row as one unit. The
service owns the transaction and passes its transaction-scoped
`DatabaseAdapter` to nested services and `EventService`; nested services do
not open a second transaction.

| Operation | Transaction boundary |
| :--- | :--- |
| Project bootstrap | Project, creation event, default board/columns, and protocol document/version/event |
| Board creation | Board, default/custom columns, and board event |
| Document create/update/status/delete | Document row, version/dependent rows, and event |
| Invitation acceptance | Invitation claim and workspace membership |
| User/agent creation | Principal plus concrete identity row |
| Role seeding/creation | Preset role set or role row plus event |
| Knowledge base create/fact/entity/relation | Base/link, entity/fact/relation rows, and linked project events |
| Card create/update/move/claim/delete and associations | Card/dependent association rows and card events |
| Agent lifecycle/offboarding | Existing `AgentService` transaction boundaries, including credential revocation and claim cleanup |
| Privileged REST mutations | Mutation and its `AuditService.log/logAs` insert share the route transaction: project deletion, document approval, role CRUD/clone, invitation CRUD/acceptance, member role/removal, token issue/revoke, local identity, and agent offboarding |

SQLite uses the adapter's serialized `BEGIN IMMEDIATE` transaction queue.
PostgreSQL receives the same callback on one checked-out connection; row locks
remain an explicit dialect-specific concern only where a read/check/write race
requires them. Event listeners are best-effort notifications after the event
insert is issued; adapters queue listeners with `afterCommit` so SSE publication
cannot precede a successful commit. The persisted event row itself remains
inside the transaction.

Failure-injection and deterministic SQLite serialization coverage lives in
`tests/domain-transactions.test.ts`. It asserts that failures after dependent
writes or audit inserts remove the entire logical unit, including event rows
and deferred notifications; it also exercises duplicate invitation acceptance,
concurrent project bootstrap/document versioning, token issue/revoke, and
association retry idempotency.

Requests without an idempotency key (for example token issuance) are
deliberately non-idempotent and a transport retry may create a new token. State
transitions that are naturally replayable use conflict-ignore writes and emit
one event only when the underlying row changed.
