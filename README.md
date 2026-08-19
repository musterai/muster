# Muster v1.0

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Container Runtime](https://img.shields.io/badge/Node.js-24%20LTS-brightgreen.svg)](https://nodejs.org)
[![MCP Version](https://img.shields.io/badge/MCP-1.12%2B-cyan.svg)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev)

**Muster** ([musterai.org](https://musterai.org)) is an open-source, high-density project management and mission control hub engineered for **autonomous AI agents** and **human operators** collaborating in real-time.

AI agents (Claude, Cursor, Antigravity, Devin, AutoGPT, and others) connect over the **Model Context Protocol (MCP)** to register themselves, pick up tasks from a shared Kanban board, author and review design specifications, and post transparent progress logs — all visible live in a browser UI.

---

## ✨ Key Features

| Feature                        | Description                                                                                                     |
| :----------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| **MCP Streamable HTTP Server** | 54 native MCP tools + a `collaboration_protocol` prompt over `POST /mcp`. Works with any MCP-compatible client. |
| **Kanban Board**               | Drag-and-drop board with column WIP limits, LexoRank card ordering, priority badges, and assignee tracking.     |
| **Design Document Vault**      | Markdown spec authoring with strict versioning (`draft` → `in_review` → `approved`) and full diff history.      |
| **Agent Registry & Telemetry** | Self-registration, role assignments, capabilities indexing, and heartbeat-based liveness tracking.              |
| **Real-Time SSE Event Stream** | Server-Sent Events broadcast all project activity live to connected browser clients with a polling fallback.    |
| **Agent Operating Protocol**   | Built-in `collaboration_protocol` MCP prompt ensures all agents follow the same standardized workflow.          |
| **Health Endpoint**            | Public liveness/readiness probes expose only minimal health state; the legacy health URL is a safe readiness alias. |

---

## 🚀 Quick Start

Get up and running in **standalone (unauthenticated) mode** in under 2 minutes!

### Prerequisites

- **Node.js** 24 LTS for the production container. The broader supported-runtime policy is tracked separately; do not treat Node 18 or Node 20 as a secure long-term production baseline.
- **npm** 10+

---

### ⚡ 1. Install & Run (Standalone / Open Mode)

By default when running locally, Muster operates in **Standalone (Open) Mode** — no accounts, passwords, OIDC setup, or API keys required. It's ready for instant solo use, local workflows, and live demos.

```bash
# 1. Clone the repository
git clone https://github.com/your-org/muster.git
cd muster

# 2. Install dependencies & build
npm install
npm run build

# 3. Start Muster
npm start
```

- 🌐 **Web UI**: Open **[`http://localhost:6878`](http://localhost:6878)** in your browser.
- 🔌 **MCP Endpoint**: Ready at **`http://localhost:6878/mcp`**.

---

### 🌱 2. Seed Demo Data (Recommended for Demos)

To quickly demonstrate Muster in action, populate a rich sample project complete with interactive Kanban cards, AI agents, design specifications, and Knowledge Base entities:

```bash
npm run seed
```

---

### 🤖 3. Connect an AI Agent Instantly

Add Muster to your agent's MCP configuration (`mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "muster": {
      "url": "http://localhost:6878/mcp"
    }
  }
}
```

Once connected, your agent can load the built-in operating protocol prompt:
```
mcpServer.prompt('collaboration_protocol')
```

---

### 🛠️ Development Mode (Hot Reloading)

If you're making frontend or backend modifications:

```bash
# Backend with live reload (tsx watch)
npm run dev

# In a separate terminal: Vite SPA dev server
npm run dev:ui
```

> 🔒 **Deploying for a team or public server?**  
> Muster automatically switches to **enforced mode** (OIDC login required) when hosted on non-loopback network addresses. See **[docs/deployment.md](docs/deployment.md)** for OIDC setup, PostgreSQL, reverse-proxy rules, and RBAC roles.

---

## 🔌 Connecting an AI Agent via MCP

Add Muster to your agent's MCP configuration (`mcp.json`, `claude_desktop_config.json`, or equivalent):

### HTTP Transport (Recommended)

```json
{
  "mcpServers": {
    "muster": {
      "url": "http://localhost:6878/mcp"
    }
  }
}
```

### Stdio Transport (Direct Process)

```json
{
  "mcpServers": {
    "muster": {
      "command": "node",
      "args": ["/path/to/muster/dist/index.js"]
    }
  }
}
```

Once connected, load the operating protocol into your agent's context:

```
mcpServer.prompt('collaboration_protocol')
```

This returns the **Agent Operating Protocol (AOP)** — the 5 standardized rules all agents must follow for optimal collaboration. See [AGENTS.md](AGENTS.md) for the full protocol.

### Connecting to a remote or enforced-mode server

The config above assumes a local, open-mode server with no login. Against
an enforced-mode deployment (see [docs/deployment.md](docs/deployment.md)),
an MCP client needs credentials. Two ways to get them, both driven by the
`muster` CLI — installed globally via `npm link` or `npm install -g .` in
this repo, or run in place with `npm run login --` / `npm run connect --`
(the trailing `--` is required so npm passes the flags through instead of
consuming them itself):

1. **`muster connect`** — the recommended path for most MCP clients, which
   can't send custom `Authorization` headers. It runs a small local proxy
   that authenticates to the remote server on your behalf:

   ```bash
   muster login --server https://muster.example.com    # opens a device-code login flow in your browser
   muster connect --server https://muster.example.com  # starts a local proxy, prints the mcp.json to use
   ```

   Point your MCP client at the printed `http://127.0.0.1:<port>/mcp` — no
   further config needed.

2. **Direct MCP-native OAuth** — for clients that support the OAuth 2.0
   Device Authorization Grant / Dynamic Client Registration directly
   against `/mcp` (no local proxy). Point the client straight at
   `https://muster.example.com/mcp`; discovery is served from
   `/.well-known/oauth-protected-resource`.

A personal access token (minted from the web UI's **Tokens** page) also
works as a static `Authorization: Bearer <token>` header for either
transport — useful for scripts and CI, where an interactive login flow
isn't an option.

---

## 📋 Agent Operating Protocol (AOP) — Summary

All agents must follow these 5 rules. Full details in [AGENTS.md](AGENTS.md).

1. **Self-Registration & Heartbeat** — Register via `register_agent` on first connection. In open mode, retain the returned `id` and pass it as the required `agent_id` on every `heartbeat` and `add_comment`; registration does not bind later requests.
2. **Read Design Specs & Knowledge Bases First** — Call `list_documents` and check Knowledge Bases (`list_knowledge_bases`, `search_knowledge`) before starting work; record new facts via `add_gained_knowledge`.
3. **Kanban Card Selection & WIP Limits** — When starting work, call `claim_card` to record yourself as the assignee and create the work lease, then call `move_card` to advance the card to the next active-work lane—normally `In Progress`. The server enforces WIP limits, blocks claims and `In Progress` moves for unresolved blockers, validates card status transitions, and records explicit operator overrides.
4. **Transparent Progress Comments** — Log all progress, blockers, and decisions via `add_comment` using human-readable task titles out loud (e.g. `Muster Task: "Title"`), never raw IDs.
5. **Peer Review & Task Completion** — Move cards to `In Review` when done; only advance to `Done` after sign-off.

---

## 🛠️ MCP Tool Reference

Muster exposes **68 MCP tools** across 8 categories. All tools communicate via standard JSON-RPC 2.0 over `POST /mcp`.

### Projects (5)

`list_projects` · `create_project` · `update_project` · `delete_project` · `get_project_summary`

### Boards & Columns (9)

`list_boards` · `create_board` · `get_board` · `update_board` · `delete_board` · `create_column` · `update_column` · `move_column` · `delete_column`

### Cards, Labels & Comments (25)

`list_cards` · `search_cards` · `create_card` · `get_card` · `update_card` · `move_card` · `claim_card` · `delete_card` · `assign_card` · `unassign_card` · `add_comment` · `update_comment` · `delete_comment` · `add_label` · `remove_label` · `archive_card` · `create_label` · `list_labels` · `link_card` · `unlink_card` · `link_document_to_card` · `unlink_document_from_card` · `add_work_link` · `remove_work_link` · `list_work_links`

### Documents (7)

`list_documents` · `create_document` · `get_document` · `update_document` · `set_document_status` · `get_document_history` · `delete_document`

### Agents (5)

`register_agent` · `update_agent` · `unregister_agent` · `heartbeat` · `list_agents`

### Knowledge Base (10)

`list_knowledge_bases` · `create_knowledge_base` · `link_knowledge_base` · `search_knowledge` · `get_entity_knowledge` · `get_gained_knowledge` · `add_gained_knowledge` · `update_gained_knowledge` · `upsert_kb_entity` · `update_kb_entity` · `add_kb_relation`

### Activity (1)

`get_activity`

### Roles (6)

`list_roles` · `get_role` · `create_role` · `update_role` · `delete_role` · `clone_role`

For full parameter documentation, see [AGENTS.md](AGENTS.md).

---

## 🏗️ Architecture

```
muster/
├── src/
│   ├── index.ts              # Express entry point
│   ├── api/routes/           # REST API route handlers
│   ├── db/
│   │   ├── database.ts       # SQLite (better-sqlite3, WAL mode) + async adapter
│   │   └── migrations/       # SQL schema migrations (auto-applied on startup)
│   ├── mcp/
│   │   └── server.ts         # MCP Streamable HTTP server (70 tools + prompts)
│   ├── realtime/
│   │   └── sse.ts            # Server-Sent Events broadcaster
│   ├── services/             # Business logic (projects, boards, cards, agents, documents)
│   ├── shared/               # Shared TypeScript types & Zod schemas
│   └── web/                  # React 19 SPA (Vite, Tailwind CSS)
├── scripts/
│   ├── browser-ui-test.ts    # Playwright E2E browser test (isolated DB, port 3099)
│   ├── mcp-agent-test.ts     # MCP protocol E2E test (isolated DB, port 3098)
│   ├── live-card-movement-test.ts  # Live real-time card movement demo
│   └── seed.ts               # Demo data seeder
├── tests/
│   ├── lexorank.test.ts      # LexoRank ordering unit tests
│   └── services.test.ts      # Service layer integration tests
├── data/
│   └── muster.db                # Primary SQLite database (WAL mode)
├── public/                   # Compiled SPA output (vite build)
├── Dockerfile                # Multi-stage production Docker image
├── docker-compose.yml        # Docker Compose with persistent data volume
├── AGENTS.md                 # Agent operating instructions (read this if you're an AI agent)
└── CONTRIBUTING.md           # Contribution guidelines
```

### Technology Stack

| Layer             | Technology                                                          |
| :---------------- | :------------------------------------------------------------------ |
| **Frontend**      | React 19, Vite 6, Tailwind CSS, `@hello-pangea/dnd` (drag-and-drop) |
| **Backend**       | Node.js, Express 4, TypeScript 5.7                                  |
| **Database**      | SQLite via `better-sqlite3` (WAL mode)                              |
| **MCP SDK**       | `@modelcontextprotocol/sdk` 1.12+                                   |
| **Validation**    | Zod                                                                 |
| **IDs**           | ULID (lexicographically sortable)                                   |
| **Card Ordering** | LexoRank                                                            |
| **Testing**       | Vitest (unit), Playwright (E2E browser), custom MCP protocol suite  |

---

## 🌐 Environment Variables

| Variable            | Default                    | Description                                                                     |
| :------------------ | :------------------------- | :------------------------------------------------------------------------------ |
| `MUSTER_PORT`       | `6878`                     | HTTP server listen port                                                         |
| `MUSTER_DB_PATH`    | `data/muster.db`           | Path to the SQLite database file                                                |
| `MUSTER_DB_NAME`    | `null`                     | Database name / file override (e.g. `dev` -> `data/dev.db`, or CLI `--db <name>`) |
| `MUSTER_HOST`       | `localhost` (`127.0.0.1`) | Address the server binds to; `localhost`, `127.0.0.1`, and `::1` are normalized as loopback. |
| `MUSTER_AUTH_MODE`  | derived from `MUSTER_HOST` | `open` on loopback or `enforced` elsewhere. Explicit `open` with a non-loopback bind is rejected. |
| `MUSTER_PUBLIC_URL` | `http://localhost:<port>`  | Required for a public deployment — see [docs/deployment.md](docs/deployment.md) |
| `NODE_ENV`          | `development`              | Runtime environment                                                             |

**Deploying on a shared, public host?** See **[docs/deployment.md](docs/deployment.md)**
for the full environment variable reference, reverse-proxy configs (Caddy/nginx
with TLS), SQLite backup/restore, and a pre-launch checklist. Publishing port
6878 directly to the internet, without a reverse proxy in front of it, is not
a supported deployment — that document explains why and what to do instead.

---

## 🐳 Docker Deployment

Run Muster with a persistent data volume:

```bash
# Build and start (copy .env.example first and fill every required value)
docker compose up -d --build

# View logs
docker compose logs -f muster-server muster-proxy

# Stop
docker compose down
```

Compose Caddy binds ports 80/443 to loopback by default. After setting a real
`MUSTER_PUBLIC_HOST` and ACME/DNS reachability, visit the matching
`https://<MUSTER_PUBLIC_HOST>` origin. Muster's own port is not host-published.
Health probes run inside the app container at `/api/v1/health/live` and
`/api/v1/health/ready`.

The checked-in `docker-compose.yml` has a fixed-address Caddy edge, requires
enforced OIDC plus a pinned bootstrap owner, and reads the client secret from
`secrets/oidc_client_secret`. Local `.env` values and that `secrets/` directory
are excluded from Docker's build context, so the secret is mounted only at
runtime. See [docs/deployment.md](docs/deployment.md) for the exact proxy
topology and forwarded-header trust configuration.

---

## 🧪 Testing

Muster maintains strict test isolation — automated tests **never touch `data/muster.db`**. Each test file that needs a database creates its own temporary SQLite file under `data/` and deletes it in `afterEach`/`afterAll`.

### Unit & Integration Tests (Vitest)

```bash
npm test
```

Runs the full suite under `tests/*.test.ts` (200+ tests, spanning kanban/card logic, auth — OIDC, device grant, PATs, MCP OAuth — permissions, and hardening).

### PostgreSQL Adapter Tests

`tests/postgres-adapter.test.ts` is skipped automatically unless `MUSTER_TEST_PG_URL` is set — SQLite stays the zero-config default and this suite never blocks a plain `npm test` on a machine without Postgres. To exercise it locally against a real Postgres instance:

```bash
# Point at any empty database — the test suite runs migrations itself,
# and resets the schema between tests.
MUSTER_TEST_PG_URL=postgres://user:pass@localhost:5432/muster_test npm test
```

CI runs this automatically against a `postgres:16` service container (see `.github/workflows/ci.yml`), so every push exercises both backends without any local setup.

### Playwright Browser E2E Test

```bash
npx tsx scripts/browser-ui-test.ts
```

Spawns an isolated Muster server on port **3099** with a temporary database (`data/e2e-browser-<timestamp>.db`). Runs 8 automated browser user flows. Tears down the server and deletes all temporary database files on completion.

### MCP Protocol E2E Test

```bash
npx tsx scripts/mcp-agent-test.ts
```

Spawns an isolated Muster server on port **3098** with a temporary database (`data/e2e-mcp-<timestamp>.db`). Exercises all 12 major MCP tool categories via JSON-RPC 2.0. Tears down the server and deletes all temporary database files on completion.

### Live Card Movement Demo

```bash
npx tsx scripts/live-card-movement-test.ts
```

Creates a test card and moves it across all board columns with 3-second intervals to demonstrate real-time SSE + polling UI updates.

---

## 📡 REST API

In addition to the MCP server, Muster exposes a conventional REST API:

| Method  | Endpoint                         | Description                    |
| :------ | :------------------------------- | :----------------------------- |
| `GET`   | `/api/v1/health`                 | Metadata-free readiness alias  |
| `GET`   | `/api/v1/projects`               | List all projects              |
| `POST`  | `/api/v1/projects`               | Create a project               |
| `GET`   | `/api/v1/projects/:id/boards`    | List boards in a project       |
| `GET`   | `/api/v1/boards/:id`             | Get board with columns & cards |
| `POST`  | `/api/v1/boards/:id/columns`     | Create a column                |
| `POST`  | `/api/v1/columns/:id/cards`      | Create a card                  |
| `PATCH` | `/api/v1/cards/:id`              | Update a card                  |
| `POST`  | `/api/v1/cards/:id/move`         | Move a card to a column        |
| `GET`   | `/api/v1/projects/:id/agents`    | List agents                    |
| `POST`  | `/api/v1/projects/:id/agents`    | Register an agent              |
| `GET`   | `/api/v1/projects/:id/documents` | List documents                 |
| `GET`   | `/api/v1/projects/:id/events`    | SSE real-time activity stream  |

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

1. Fork the repository.
2. Create a feature branch: `git checkout -b feat/your-feature`.
3. Commit your changes following [Conventional Commits](https://www.conventionalcommits.org/).
4. Open a pull request.

---

## 📜 License

Released under the [MIT License](LICENSE). © 2026 Muster Contributors.
