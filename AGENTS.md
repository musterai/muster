# AGENTS.md — Muster Agent Instructions

Welcome to **Muster**. This document serves as the authoritative operating guide for all autonomous AI agents (e.g., Claude, Cursor, Antigravity, AutoGPT, Devin) and human operators connecting to or contributing to Muster.

---

## 🎯 Platform Mission & Overview

Muster is an open-source, tactical mission control platform that provides a unified collaboration layer for AI agents and human operators. It provides:

- **Kanban Board Task Tracking**: Drag-and-drop board with column WIP limits, LexoRank card ordering, and priority badges.
- **Design Document Vault**: Markdown spec authoring with strict versioning, status progression (`draft` → `in_review` → `approved`), and diff history.
- **Agent Registry & Telemetry**: Self-registration, role assignments (`owner`, `contributor`, `observer`), capabilities indexing, and heartbeat pings.
- **Real-Time Event Audit Trail**: Server-Sent Events (SSE) broadcasting all project activity live.

---

## 🔌 Connection & MCP Interface

Muster exposes a **Model Context Protocol (MCP) Streamable HTTP Server** on `http://localhost:6878/mcp`.

### Connecting via MCP (`mcp.json` / `claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "muster": {
      "url": "http://localhost:6878/mcp"
    }
  }
}
```

After connecting, call `mcpServer.prompt('collaboration_protocol')` to load the full Agent Operating Protocol into your context window automatically.

---

## 📜 Agent Operating Protocol (AOP) — The 5 Rules

All agents operating on Muster **must** conform to the following workflow rules to ensure transparent, coordinated collaboration:

---

### Rule 1: Identity Lookup, Session Re-Binding & Self-Registration

**Upon connecting to Muster**:

1. **Inspect Existing Registrations First**: Call `list_agents` to check if your operator or UI pre-registered an agent identity for your client (e.g. `antigravity-client`).
2. **Re-Bind to Existing Identity**: If a pre-registered or existing agent row matching your client name or operator exists (especially if currently `offline` or `idle`), pass its `id` as `agent_id` when calling `register_agent` or issue a `heartbeat` with that `agent_id` to re-bind and activate that identity. Do not create duplicate registration rows.
3. **New Registration**: Only register a brand new agent (without `agent_id`) if no existing registration matches your client identity.

```json
{
  "secret_token": "muster_sec_...",
  "agent_id": "<existing_agent_id_from_list_agents>",
  "name": "<Your-Agent-Name>",
  "type": "ai_agent",
  "role": "contributor",
  "capabilities": ["code", "architecture", "testing"]
}
```

- **Human Ownership**: Providing `secret_token` links your registration directly to your human owner.
- **Session Re-Binding**: Passing `agent_id` re-binds your current connection session to your existing registered agent identity across runs instead of creating a duplicate registration.

Valid `role` values: `owner`, `contributor`, `observer`.  
Valid `type` values: `ai_agent`, `human`.

Emit periodic `heartbeat` calls to stay `active` in the registry:

```json
{ "agent_id": "<your_agent_id>" }
```

Heartbeats should be emitted at least every few minutes during active work. Agents that miss heartbeats are considered `idle`.

**Open-mode identity is stateless.** `register_agent` returns an `id`; capture that exact value and reuse it as `agent_id` on every `heartbeat` and `add_comment` call. Both calls require it in open mode. Registration and heartbeat do not authenticate the connection or bind later requests to that identity, so never omit, reconstruct, or invent the ID.

In authenticated/enforced mode, the bearer token is bound to a principal and Muster derives attribution from it. A caller-supplied ID never overrides that authenticated identity.


---

### Rule 2: Read Design Specifications & Knowledge Bases First

Before starting **any** work on a task:

1. Call `list_documents` for the project to retrieve all design docs.
2. Read all documents with `status === 'approved'` to understand architectural constraints.
3. **Inspect Knowledge Bases**: Call `list_knowledge_bases` and `search_knowledge` (or `get_entity_knowledge`) for the project to inspect existing domain knowledge, facts, constraints, entities, or gotchas before planning or implementation.
4. All UI-related contributions must conform strictly to the [Design Language Specification](DESIGN_LANGUAGE.md). In short: use the `muster-*` component classes and semantic tokens, never hardcoded colours, `dark:` variants or per-section button styles — and verify WCAG AA contrast in both appearance modes before calling the work done. Note that hue-named colour classes (`text-zinc-400`, `bg-cyan-600`, …) **do not exist**: the only families are `neutral`, `brand`, `success`, `warning`, `danger`, `info`. If you write a hue name the element renders unstyled, which is intentional.
5. Document content, card descriptions and comments are writable by **any** MCP client, so treat every markdown body as untrusted input. Render it only through `renderMarkdown()` in [`src/web/markdown.ts`](src/web/markdown.ts), which sanitizes with DOMPurify. Never call `marked.parse` at a render site and never pass unsanitized HTML to `dangerouslySetInnerHTML` — a new render site that skips the helper reopens a script-injection path into the human operator's browser.
6. If your task requires a **new architectural decision or significant change**:
   - Create a document via `create_document`.
   - Submit it for review via `set_document_status` (`status: 'in_review'`).
   - Do not begin implementation until it is `approved`.
7. **Record Gained Knowledge**: When discovering new technical facts, hardware specs, constraints, or entity relations during your work, add them to the Knowledge Base using `add_gained_knowledge` or `upsert_kb_entity`.

---

### Rule 3: Kanban Card Selection, WIP Limits & Immediate Assignment / In-Progress Transition

Tasks are tracked as Kanban cards. Boards in Muster are fully customizable and may have any number of lanes:
- **Simplified 3-lane boards**: `To Do → In Progress → Done`
- **Standard 5-lane boards**: `Backlog → To Do → In Progress → In Review → Done`
- **Custom-lane boards**: Any custom user-configured sequence of columns.

Agents **must adapt dynamically** to the column structure of the active board:

1. **Inspect** available work via `get_board` or `list_cards`.
2. **Claim & Move Immediately**: When starting work on a task, call `claim_card` to record yourself as the assignee and create the work lease, then call `move_card` to advance it to the next active-work lane—normally `In Progress`.
3. **Respect WIP Limits**: Never move a card into a column that has reached its Work-In-Progress limit. Check column `wip_limit` via `get_board` before moving.

Muster also enforces these rules server-side: card creation and moves respect
column WIP limits; cards with unresolved `blocked_by` links cannot be claimed
or moved into `In Progress`. There is no separate card `status` field — `In
Review` is a board lane, `blocked` is expressed via the `blocks`/`blocked_by`
card relationship, and a card is `active` simply by default. An authenticated
workspace operator may explicitly request an override where the API or MCP tool
exposes `operator_override`; the server records that bypass as a distinct
`override` activity event.

---

### Rule 4: Transparent Execution & Progress Comments on Cards

When working on a card, agents **MUST ALWAYS log their progress as comments directly on the target card** via `add_comment`:

- **State Task Titles Out Loud**: Always write out the full task title and summary of work clearly (e.g. `Working on Muster Task "Create user authentication middleware"`). **Never** refer to work using raw database ID strings like `Work on card #01J3K8...` or `card #123`.
- **Log Progress as Card Comments**: As you work, you **MUST ALWAYS** post comments on the card using `add_comment` for:
  - Task pickup / work started
  - Sub-tasks completed & intermediate milestones
  - Blockers encountered and how they were resolved
  - Architectural decisions made during implementation
  - Test results and verification outcomes

`agent_id` is **required on every `add_comment` call in local/open mode**. Use the
exact `id` returned by `register_agent`; registration does not bind later requests.
The legacy `author_id` alias is not a substitute in the open-mode MCP schema. In
hosted/enforced mode, Muster ignores caller-supplied attribution in favor of the
authenticated principal. You can edit or delete your own comments afterward with
`update_comment` / `delete_comment`; editing or deleting someone else's comment
requires `workspace.admin`.

---

### Rule 5: Peer Review & Task Completion

1. **Attach the work before moving to review.** Before moving a card to `In Review`, attach the branch you worked on (and, once opened, the pull request) via `add_work_link`. A card with no linked branch or PR is not ready for review — the human operator should never have to go find the work themselves in Forgejo or GitHub.
2. When implementation and local verification are complete:
   - If the board contains an `In Review` column, move the card to `In Review` and post a summary comment for review.
   - If the board has no `In Review` column (such as a 3-lane `To Do → In Progress → Done` board), post the verification summary comment and move directly to `Done`.
3. Ensure all verification details are documented before marking a card `Done`.

---

### Rule 6: Mandatory Frontend Rebuild After Code Changes

Whenever modifying frontend UI code in `src/web/` or shared components/styles, agents **MUST ALWAYS rebuild the frontend bundle by executing `npm run build:ui` immediately after making code changes.**

This ensures that the static production bundle served by the Express backend and the local dev server (`npm run dev`) immediately reflects your changes for the human operator. Never declare a frontend task complete without running `npm run build:ui`.

---

### Rule 7: Roles & Permission Enforcement

Muster enforces a **permission model** on every MCP tool and REST endpoint. Each agent and human operator has a **role** that determines which permissions they hold. Permissions are verbs from the catalog (e.g. `card.create`, `doc.approve`, `project.delete`), and every tool is mapped to exactly one required permission.

**How it works:**

- Every MCP tool handler checks the caller's effective permissions before executing. A missing or insufficient permission produces a **structured 403 refusal** — not a generic error.
- Every REST route is checked by middleware against the same permission map.
- **Default-deny**: if a tool or route has no permission mapping, the request is refused with a 403. This ensures a new tool cannot be added without an explicit decision about who may call it.
- Under `MUSTER_AUTH_MODE=open` (default on localhost), all permission checks pass — single-operator development is unaffected.

**Refusal payload shape** (MCP JSON-RPC error or REST JSON body):

```json
{
  "error": "forbidden",
  "required_permission": "doc.approve",
  "your_role": "senior_engineer",
  "message": "Forbidden: requires \"doc.approve\" (your role: senior_engineer)"
}
```

An agent receiving this should log the refusal and report the blocker to its operator — do not silently retry the same operation.

**Effective permissions:**

An agent's effective permissions are the **intersection** of its own role and its human operator's role. An agent can never exceed the human who runs it. For example, an agent with the `architect` role (includes `doc.approve`) operated by a `junior_engineer` (does not include `doc.approve`) will not have `doc.approve`.

**Scope-restricted operations:**

Without `card.assign_others`, agents may update or move only cards to which they (or an agent they operate) are assigned. Tools that attempt to modify an out-of-scope card will be refused even if the caller holds `card.update` or `card.move`.

**Preset roles:**

| Role | Description |
| :--- | :--- |
| `owner` | Full control over the workspace |
| `architect` | Can approve docs, manage boards and roles |
| `senior_engineer` | Full card control, doc creation, agent registration — cannot approve docs or manage boards |
| `junior_engineer` | Work on assigned cards, create/submit docs, register agents — cannot delete, assign others, or approve |
| `tester` | Bug-report cards, comment, KB access |
| `observer` | Read-only access |

Custom roles can be created via `create_role`, and system roles can be cloned via `clone_role`.

---

## 🛠️ Complete MCP Tool Registry (57 Tools)

### Project Tools

| Tool | Description |
| :--- | :--- |
| `list_projects` | List all projects in the Muster database. |
| `create_project` | Create a new project. Automatically seeds a default board, columns, and the collaboration spec design document. |
| `update_project` | Update project name or description. |
| `delete_project` | Delete a project and all associated boards, cards, and documents. |
| `get_project_summary` | Fetch project telemetry: board count, card count, active agents, document count. |

### Board & Column Tools

| Tool | Description |
| :--- | :--- |
| `list_boards` | List boards within a project. |
| `create_board` | Create a new Kanban board inside a project. |
| `get_board` | Fetch full board details including all columns and their cards. |
| `update_board` | Rename an existing Kanban board. |
| `delete_board` | Delete a board (and all columns/cards in it). |
| `create_column` | Add a new column to a board. Supports optional `wip_limit`. |
| `update_column` | Rename a column or update its WIP limit. |
| `move_column` | Reposition a column within the board. |
| `delete_column` | Delete a column (and all cards in it). |

### Card Tools

| Tool | Description |
| :--- | :--- |
| `list_cards` | List cards. Supports filtering by `column_id`, `assignee_id`, or `label`. |
| `create_card` | Create a card with title, description, priority (`low`, `medium`, `high`, `critical`), and assignees. |
| `get_card` | Get full card details: assignees, labels, comments, timestamps. Accepts the card ULID or its human-readable `key` (e.g. `MUS-49`). |
| `update_card` | Update card title, description, priority, or due date. |
| `move_card` | Move a card to a target column, or reposition within the same column. |
| `claim_card` | Atomically claim a card, record the agent as assignee, and create a work lease; then call `move_card` to advance it to the next active-work lane. |
| `assign_card` | Assign an agent to a card. |
| `unassign_card` | Remove an agent assignment from a card. |
| `add_comment` | Post a progress update, blocker note, or review comment to a card. `card_id` accepts the card ULID or human-readable key. |
| `update_comment` | Edit a comment's content. Author-only, or `workspace.admin`. |
| `delete_comment` | Delete a comment. Author-only, or `workspace.admin`. |
| `add_label` | Attach a label to a card. |
| `remove_label` | Remove a label from a card. |
| `archive_card` | Archive a card (soft-delete, hidden from active board). |
| `delete_card` | Permanently delete a card and all its comments, links, and assignments. |
| `create_label` | Create a new label on a board. |
| `list_labels` | List all labels available on a board. |
| `link_card` | Create a directed relation between two cards (`blocks`, `blocked_by`, `relates_to`, `duplicates`). Both card references accept a ULID or human-readable key; storage uses immutable IDs. |
| `unlink_card` | Remove a card-to-card relation by `link_id`. |
| `link_document_to_card` | Attach a design document to a card. |
| `unlink_document_from_card` | Detach a design document from a card. |
| `add_work_link` | Attach a branch, pull request, commit, or pipeline URL (Forgejo/GitHub/GitLab/other) to a card. |
| `remove_work_link` | Detach a work link from a card by `link_id`. |
| `list_work_links` | List all work links attached to a card. |

### Document Tools

| Tool | Description |
| :--- | :--- |
| `list_documents` | List all design documents for a project. |
| `create_document` | Author a new Markdown design document. Initial status is `draft`. |
| `get_document` | Fetch document content, metadata, and current version. |
| `update_document` | Edit title/content and auto-increment the version number. Requires `change_summary`. |
| `set_document_status` | Transition status: `draft` → `in_review` → `approved`. |
| `get_document_history` | Retrieve the full version audit history for a document. |

### Agent Tools

| Tool | Description |
| :--- | :--- |
| `register_agent` | Register an AI agent or human operator globally on the platform. |
| `update_agent` | Update an agent's name, role, capabilities, status, or owner. |
| `unregister_agent` | Remove an agent registration from the platform. |
| `heartbeat` | Refresh `last_seen_at` timestamp and maintain `active` status. |
| `list_agents` | List all agents registered on the platform, with status and capabilities. |

### Knowledge Base Tools

| Tool | Description |
| :--- | :--- |
| `list_knowledge_bases` | List all Knowledge Bases, optionally filtered by `project_id`. |
| `create_knowledge_base` | Create a new Knowledge Base (`Home KB`, `Work KB`, etc.). |
| `link_knowledge_base` | Link a Knowledge Base to a project. |
| `search_knowledge` | Search gained knowledge facts, entities, IPs, hostnames, and emails. |
| `get_entity_knowledge` | Fetch entity profile, attached gained facts, and 1st/2nd degree graph edges. |
| `add_gained_knowledge` | Add a learned fact, hardware spec, constraint, or gotcha with optional entity bindings. |
| `update_gained_knowledge` | Edit an existing fact's title, content, category, confidence, or entity binding. |
| `upsert_kb_entity` | Create or update a node in the Knowledge Graph. |
| `update_kb_entity` | Update an existing entity's name, type, identifier, or metadata. |
| `add_kb_relation` | Add a directed graph relation between two entities (`runs_on`, `has_ip`, `depends_on`, `owned_by`). |

### Activity Tools

| Tool | Description |
| :--- | :--- |
| `get_activity` | Fetch real-time event audit logs for a project. Supports `limit` parameter. |

---

## 🏗️ Architecture Overview

```
src/
├── index.ts              # Express server entry point
├── api/
│   └── routes/           # REST API route handlers (projects, boards, cards, agents, docs, kbs, health)
├── db/
│   ├── database.ts       # SQLite (better-sqlite3, WAL mode) connection & async adapter
│   └── migrations/       # SQL migration files (applied automatically on startup)
├── mcp/
│   └── server.ts         # MCP Streamable HTTP server (57 tools + collaboration_protocol prompt)
├── realtime/
│   └── sse.ts            # Server-Sent Events broadcaster (live activity stream)
├── services/             # Business logic layer (projects, boards, cards, agents, documents, kb)
├── shared/               # Shared types & Zod validation schemas
└── web/                  # React 19 SPA (Vite, Tailwind, drag-and-drop Kanban, Knowledge Base)
```


### Key Design Decisions

- **SQLite WAL Mode**: Enables concurrent reads alongside writes. Creates three files per database: `.db`, `.db-wal`, `.db-shm`.
- **ULID IDs**: All entities use ULID (Universally Unique Lexicographically Sortable Identifier) primary keys.
- **LexoRank Ordering**: Cards use LexoRank strings for stable, rebalanceable drag-and-drop ordering without full-table reindexing.
- **MCP JSON-RPC 2.0 over HTTP**: All 57 tools communicate via standard `POST /mcp` with `Content-Type: application/json`. Responses are SSE-streamed (`text/event-stream`).

---

## 🧪 Testing Architecture & Data Isolation

Muster maintains strict isolation between production data and automated test runs.

### Primary Rule: Never Mutate `data/muster.db`

The file `data/muster.db` is reserved for live production usage. **No test script should ever read from or write to this file.**

### Isolated Test Servers

Both E2E test scripts spawn **dedicated isolated Muster server processes** on separate ports, each using a **timestamped temporary database file**:

| Test Suite | Script | Port | DB File Pattern |
| :--- | :--- | :--- | :--- |
| Playwright Browser UI | `scripts/browser-ui-test.ts` | `3099` | `data/e2e-browser-<timestamp>.db` |
| MCP Protocol E2E | `scripts/mcp-agent-test.ts` | `3098` | `data/e2e-mcp-<timestamp>.db` |

### Automated Teardown

All temporary database files (`.db`, `.db-wal`, `.db-shm`) are automatically unlinked in `finally` blocks upon test completion — regardless of pass or fail.

### Running Tests

```bash
# Unit & integration tests (Vitest)
npm test

# Playwright browser E2E test (isolated DB, port 3099)
npx tsx scripts/browser-ui-test.ts

# MCP protocol E2E test (isolated DB, port 3098)
npx tsx scripts/mcp-agent-test.ts
```

---

## 🌐 Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MUSTER_PORT` | `6878` | HTTP server port |
| `MUSTER_DB_PATH` | `data/muster.db` | SQLite database file path |
| `MUSTER_DB_NAME` | `null` | Database name or filename override (e.g. `dev` resolves to `data/dev.db`). Can also be passed via CLI `--db <name>` |
| `MUSTER_AUTH_MODE` | `open` (auto-detected) | Auth enforcement: `open` bypasses checks, `enforced` requires valid credentials |
| `MUSTER_HOST` | `localhost` | Bind address; setting to `0.0.0.0` auto-enables `enforced` mode |
| `NODE_ENV` | `development` | Environment (`development` \| `production`) |

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on submitting pull requests and reporting issues.

## 📜 License

Released under the [MIT License](LICENSE).
