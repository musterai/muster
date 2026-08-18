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

SQLite uses the adapter's serialized `BEGIN IMMEDIATE` transaction queue.
PostgreSQL receives the same callback on one checked-out connection; row locks
remain an explicit dialect-specific concern only where a read/check/write race
requires them. Event listeners are best-effort notifications after the event
insert is issued; the persisted event row itself remains inside the transaction.

Failure-injection coverage lives in `tests/domain-transactions.test.ts` and
asserts that a failure after a dependent write removes the entire logical unit,
including its event rows.
