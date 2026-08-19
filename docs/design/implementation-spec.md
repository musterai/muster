# Muster — Implementation Specification

> This document contains complete, file-by-file implementation code for the Muster.
> For architecture and design decisions, see [System Design](file:///Users/erik/Code/Collaborative%20Agent%20Platform/docs/design/system-design.md).
>
> **Target audience**: AI coding agents. Every code block is complete and copy-pasteable.
> **Build order**: Files are listed in dependency order. Create them in the order listed.

---

## 1. Project Initialization

Run these shell commands to initialize the project structure:

```bash
mkdir -p muster
cd muster
npm init -y
mkdir -p src/config src/shared src/db/migrations data/attachments
```

### File: `package.json`

```json
{
  "name": "muster",
  "version": "1.0.0",
  "description": "Project management system for AI agents",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "test": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "better-sqlite3": "^11.7.0",
    "express": "^4.21.0",
    "ulid": "^2.3.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/express": "^4.17.21",
    "@types/node": "^22.13.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

### File: `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

## 2. Configuration

### File: `src/config/index.ts`

```typescript
// File: src/config/index.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

export const config = {
  port: parseInt(process.env.MUSTER_PORT || '6878', 10),
  host: process.env.MUSTER_HOST || 'localhost',
  db: {
    type: process.env.MUSTER_DB_TYPE || 'sqlite',
    path: process.env.MUSTER_DB_PATH || path.join(projectRoot, 'data/muster.db'),
  },
  attachmentsDir: process.env.MUSTER_ATTACHMENTS_DIR || path.join(projectRoot, 'data/attachments'),
  publicDir: path.join(projectRoot, 'public'),
};
```

## 3. Shared Types

### File: `src/shared/types.ts`

```typescript
// File: src/shared/types.ts

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateProject {
  name: string;
  description?: string | null;
}

export interface UpdateProject {
  name?: string;
  description?: string | null;
}

export interface Board {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CreateBoard {
  project_id: string;
  name: string;
}

export interface UpdateBoard {
  name?: string;
}

export interface Column {
  id: string;
  board_id: string;
  name: string;
  position: string;
  wip_limit: number | null;
}

export interface CreateColumn {
  board_id: string;
  name: string;
  position: string;
  wip_limit?: number | null;
}

export interface UpdateColumn {
  name?: string;
  position?: string;
  wip_limit?: number | null;
}

export interface Card {
  id: string;
  column_id: string;
  title: string;
  description: string | null;
  position: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  due_date: string | null;
  created_at: string;
  updated_at: string;
  archived: 0 | 1;
}

export interface CreateCard {
  column_id: string;
  title: string;
  description?: string | null;
  position: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  due_date?: string | null;
}

export interface UpdateCard {
  column_id?: string;
  title?: string;
  description?: string | null;
  position?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  due_date?: string | null;
  archived?: 0 | 1;
}

export interface Label {
  id: string;
  board_id: string;
  name: string;
  color: string;
}

export interface CreateLabel {
  board_id: string;
  name: string;
  color: string;
}

export interface UpdateLabel {
  name?: string;
  color?: string;
}

export interface CardLabel {
  card_id: string;
  label_id: string;
}

export interface CardAssignee {
  card_id: string;
  agent_id: string;
}

export interface Comment {
  id: string;
  card_id: string;
  author_id: string;
  content: string;
  created_at: string;
}

export interface CreateComment {
  card_id: string;
  author_id: string;
  content: string;
}

export interface Attachment {
  id: string;
  card_id: string;
  filename: string;
  path: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface CreateAttachment {
  card_id: string;
  filename: string;
  path: string;
  mime_type: string;
  size_bytes: number;
}

export interface Document {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  content: string;
  status: 'draft' | 'in_review' | 'approved' | 'archived';
  author_id: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateDocument {
  project_id: string;
  parent_id?: string | null;
  title: string;
  content: string;
  status?: 'draft' | 'in_review' | 'approved' | 'archived';
  author_id: string;
}

export interface UpdateDocument {
  parent_id?: string | null;
  title?: string;
  content?: string;
  status?: 'draft' | 'in_review' | 'approved' | 'archived';
  author_id?: string;
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  version: number;
  content: string;
  author_id: string;
  change_summary: string | null;
  created_at: string;
}

export interface CreateDocumentVersion {
  document_id: string;
  version: number;
  content: string;
  author_id: string;
  change_summary?: string | null;
}

export interface AgentRegistration {
  id: string;
  project_id: string;
  name: string;
  type: 'ai_agent' | 'human';
  role: 'owner' | 'contributor' | 'observer';
  capabilities: string;
  status: 'active' | 'idle' | 'offline';
  last_seen_at: string;
  created_at: string;
}

export interface CreateAgentRegistration {
  project_id: string;
  name: string;
  type: 'ai_agent' | 'human';
  role: 'owner' | 'contributor' | 'observer';
  capabilities: string;
  status: 'active' | 'idle' | 'offline';
}

export interface UpdateAgentRegistration {
  name?: string;
  role?: 'owner' | 'contributor' | 'observer';
  capabilities?: string;
  status?: 'active' | 'idle' | 'offline';
  last_seen_at?: string;
}

export interface Event {
  id: string;
  project_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  payload: string;
  created_at: string;
}

export interface CreateEvent {
  project_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  payload: string;
}
```

## 4. Shared Utilities

### File: `src/shared/errors.ts`

```typescript
// File: src/shared/errors.ts

export class AppError extends Error {
  public statusCode: number;
  public code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}
```

### File: `src/shared/lexorank.ts`

```typescript
// File: src/shared/lexorank.ts

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const START_CHAR = 'a';
const END_CHAR = 'z';

export function generateRank(): string {
  return 'm';
}

function getMidChar(c1: string, c2: string): string {
  const i1 = ALPHABET.indexOf(c1);
  const i2 = ALPHABET.indexOf(c2);
  const midIndex = Math.floor((i1 + i2) / 2);
  return ALPHABET[midIndex];
}

export function rankBetween(before: string | null, after: string | null): string {
  if (!before && !after) {
    return generateRank();
  }
  if (!before && after) {
    return rankBefore(after);
  }
  if (before && !after) {
    return rankAfter(before);
  }

  // both before and after are provided
  const str1 = before!;
  const str2 = after!;
  let rank = '';
  let i = 0;

  while (true) {
    const char1 = i < str1.length ? str1[i] : START_CHAR;
    const char2 = i < str2.length ? str2[i] : END_CHAR;

    if (char1 === char2) {
      rank += char1;
      i++;
      continue;
    }

    const i1 = ALPHABET.indexOf(char1);
    const i2 = ALPHABET.indexOf(char2);

    if (i2 - i1 > 1) {
      const mid = getMidChar(char1, char2);
      rank += mid;
      break;
    } else {
      rank += char1;
      i++;
      // We need to keep going and append something in the middle
      // Effectively this is like getting a rank after str1 padded.
      return rank + rankAfter(str1.substring(i));
    }
  }

  return rank;
}

export function rankAfter(rank: string): string {
  let newRank = '';
  for (let i = 0; i < rank.length; i++) {
    const char = rank[i];
    if (char === END_CHAR) {
      newRank += char;
    } else {
      const charIndex = ALPHABET.indexOf(char);
      newRank += ALPHABET[charIndex + 1];
      return newRank;
    }
  }
  return newRank + 'm';
}

export function rankBefore(rank: string): string {
  let newRank = '';
  for (let i = 0; i < rank.length; i++) {
    const char = rank[i];
    if (char === START_CHAR) {
      newRank += char;
    } else {
      const charIndex = ALPHABET.indexOf(char);
      newRank += ALPHABET[charIndex - 1];
      return newRank;
    }
  }
  return newRank + 'm';
}
```

## 5. Database Layer

### File: `src/db/adapter.ts`

```typescript
// File: src/db/adapter.ts

export interface DatabaseAdapter {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  execute(sql: string, params?: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
  transaction<T>(fn: (adapter: DatabaseAdapter) => T): T;
  migrate(sql: string): void;
  close(): void;
}
```

### File: `src/db/sqlite-adapter.ts`

```typescript
// File: src/db/sqlite-adapter.ts
import Database from 'better-sqlite3';
import { DatabaseAdapter } from './adapter.js';

export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database;

  constructor(filepath: string) {
    this.db = new Database(filepath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  execute(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid?: number | bigint } {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  transaction<T>(fn: (adapter: DatabaseAdapter) => T): T {
    const tx = this.db.transaction(() => {
      return fn(this);
    });
    return tx();
  }

  migrate(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
```

### File: `src/db/factory.ts`

```typescript
// File: src/db/factory.ts
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseAdapter } from './adapter.js';
import { SQLiteAdapter } from './sqlite-adapter.js';

export function createDatabase(config: { type: string; path: string }): DatabaseAdapter {
  if (config.type !== 'sqlite') {
    throw new Error(`Unsupported database type: ${config.type}`);
  }

  const dir = path.dirname(config.path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new SQLiteAdapter(config.path);
}
```

### File: `src/db/migrations/001-initial.sql`

```sql
-- File: src/db/migrations/001-initial.sql

CREATE TABLE project (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE board (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX idx_board_project_id ON board(project_id);

CREATE TABLE column (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT NOT NULL,
    wip_limit INTEGER,
    FOREIGN KEY (board_id) REFERENCES board(id) ON DELETE CASCADE
);
CREATE INDEX idx_column_board_id ON column(board_id);

CREATE TABLE label (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    FOREIGN KEY (board_id) REFERENCES board(id) ON DELETE CASCADE
);
CREATE INDEX idx_label_board_id ON label(board_id);

CREATE TABLE agent_registration (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    role TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    status TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_registration_project_id ON agent_registration(project_id);

CREATE TABLE card (
    id TEXT PRIMARY KEY,
    column_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    position TEXT NOT NULL,
    priority TEXT NOT NULL,
    due_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (column_id) REFERENCES column(id) ON DELETE CASCADE
);
CREATE INDEX idx_card_column_id ON card(column_id);

CREATE TABLE card_label (
    card_id TEXT NOT NULL,
    label_id TEXT NOT NULL,
    PRIMARY KEY (card_id, label_id),
    FOREIGN KEY (card_id) REFERENCES card(id) ON DELETE CASCADE,
    FOREIGN KEY (label_id) REFERENCES label(id) ON DELETE CASCADE
);

CREATE TABLE card_assignee (
    card_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    PRIMARY KEY (card_id, agent_id),
    FOREIGN KEY (card_id) REFERENCES card(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agent_registration(id) ON DELETE CASCADE
);

CREATE TABLE comment (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (card_id) REFERENCES card(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES agent_registration(id) ON DELETE CASCADE
);
CREATE INDEX idx_comment_card_id ON comment(card_id);

CREATE TABLE attachment (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (card_id) REFERENCES card(id) ON DELETE CASCADE
);
CREATE INDEX idx_attachment_card_id ON attachment(card_id);

CREATE TABLE document (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    author_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES document(id) ON DELETE SET NULL,
    FOREIGN KEY (author_id) REFERENCES agent_registration(id) ON DELETE CASCADE
);
CREATE INDEX idx_document_project_id ON document(project_id);
CREATE INDEX idx_document_parent_id ON document(parent_id);

CREATE TABLE document_version (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    author_id TEXT NOT NULL,
    change_summary TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (document_id) REFERENCES document(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES agent_registration(id) ON DELETE CASCADE
);
CREATE INDEX idx_document_version_document_id ON document_version(document_id);

CREATE TABLE event (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX idx_event_project_id ON event(project_id);
```

### File: `src/db/migrator.ts`

```typescript
// File: src/db/migrator.ts
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseAdapter } from './adapter.js';

export class Migrator {
  private db: DatabaseAdapter;
  private migrationsDir: string;

  constructor(db: DatabaseAdapter, migrationsDir: string) {
    this.db = db;
    this.migrationsDir = migrationsDir;
  }

  public run(): void {
    this.db.transaction((adapter) => {
      adapter.migrate(`
        CREATE TABLE IF NOT EXISTS _migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL
        );
      `);

      const appliedMigrations = adapter.query<{ filename: string }>('SELECT filename FROM _migrations');
      const appliedSet = new Set(appliedMigrations.map(m => m.filename));

      if (!fs.existsSync(this.migrationsDir)) {
        return;
      }

      const files = fs.readdirSync(this.migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    });
  }
}
```

## 6. Core Services

All services follow the same pattern:
- Constructor takes `db: DatabaseAdapter` and optionally `onEvent` callback
- Use `ulid()` for ID generation, `new Date().toISOString()` for timestamps
- Throw `NotFoundError` for missing entities, `ConflictError` for constraint violations

### File: `src/services/event.service.ts`
```typescript
// File: src/services/event.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Event } from '../shared/types.js';

export class EventService {
  constructor(
    private db: DatabaseAdapter,
    private onEvent?: (event: Event) => void
  ) {}

  async emit(
    projectId: string,
    entityType: string,
    entityId: string,
    action: string,
    actorId: string,
    payload: any
  ): Promise<Event> {
    const event: Event = {
      id: ulid(),
      project_id: projectId,
      entity_type: entityType,
      entity_id: entityId,
      action,
      actor_id: actorId,
      payload,
      created_at: new Date().toISOString()
    };

    const payloadStr = typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);

    await this.db.execute(
      `INSERT INTO events (id, project_id, entity_type, entity_id, action, actor_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.project_id, event.entity_type, event.entity_id, event.action, event.actor_id, payloadStr, event.created_at]
    );

    if (this.onEvent) {
      this.onEvent(event);
    }

    return event;
  }

  async list(
    projectId: string,
    options?: { entityType?: string; entityId?: string; since?: string; limit?: number }
  ): Promise<Event[]> {
    let sql = `SELECT * FROM events WHERE project_id = ?`;
    const params: any[] = [projectId];

    if (options?.entityType) {
      sql += ` AND entity_type = ?`;
      params.push(options.entityType);
    }
    if (options?.entityId) {
      sql += ` AND entity_id = ?`;
      params.push(options.entityId);
    }
    if (options?.since) {
      sql += ` AND created_at > ?`;
      params.push(options.since);
    }
    
    sql += ` ORDER BY created_at DESC`;
    
    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const rows = await this.db.query<any>(sql, params);
    return rows.map(row => ({
      ...row,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    }));
  }
}
```

### File: `src/services/project.service.ts`
```typescript
// File: src/services/project.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Project, CreateProject, Event } from '../shared/types.js';
import { NotFoundError } from '../shared/errors.js';

export class ProjectService {
  constructor(
    private db: DatabaseAdapter,
    private onEvent?: (event: Event) => void
  ) {}

  async create(data: CreateProject): Promise<Project> {
    const now = new Date().toISOString();
    const project: Project = {
      id: ulid(),
      name: data.name,
      description: data.description || null,
      created_at: now,
      updated_at: now
    };

    await this.db.execute(
      `INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [project.id, project.name, project.description, project.created_at, project.updated_at]
    );

    return project;
  }

  async list(): Promise<Project[]> {
    return this.db.query<Project>(`SELECT * FROM projects ORDER BY created_at DESC`);
  }

  async getById(id: string): Promise<Project> {
    const rows = await this.db.query<Project>(`SELECT * FROM projects WHERE id = ?`, [id]);
    if (rows.length === 0) {
      throw new NotFoundError(`Project with ID ${id} not found`);
    }
    return rows[0];
  }

  async update(id: string, data: Partial<CreateProject>): Promise<Project> {
    const project = await this.getById(id);
    const updatedName = data.name !== undefined ? data.name : project.name;
    const updatedDescription = data.description !== undefined ? data.description : project.description;
    const updatedAt = new Date().toISOString();

    await this.db.execute(
      `UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
      [updatedName, updatedDescription, updatedAt, id]
    );

    return this.getById(id);
  }

  async delete(id: string): Promise<void> {
    const project = await this.getById(id);
    await this.db.execute(`DELETE FROM projects WHERE id = ?`, [id]);
  }

  async getSummary(id: string): Promise<any> {
    const project = await this.getById(id);
    
    const boards = await this.db.query<{ count: number }>(`SELECT COUNT(*) as count FROM boards WHERE project_id = ?`, [id]);
    const agents = await this.db.query<{ count: number }>(`SELECT COUNT(*) as count FROM agent_registrations WHERE project_id = ?`, [id]);
    const docs = await this.db.query<{ count: number }>(`SELECT COUNT(*) as count FROM documents WHERE project_id = ?`, [id]);
    
    // Detailed card breakdown by board and column would require joining cards and columns
    // For simplicity, total cards in project:
    const cards = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM cards c
       JOIN boards b ON c.board_id = b.id
       WHERE b.project_id = ?`, [id]
    );

    return {
      ...project,
      board_count: boards[0].count,
      agent_count: agents[0].count,
      document_count: docs[0].count,
      card_count: cards[0].count
    };
  }
}
```

### File: `src/services/board.service.ts`
```typescript
// File: src/services/board.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Board, CreateBoard, Column, Event } from '../shared/types.js';
import { NotFoundError } from '../shared/errors.js';
import { generateRank, rankAfter } from '../shared/lexorank.js';

export class BoardService {
  constructor(
    private db: DatabaseAdapter,
    private onEvent?: (event: Event) => void
  ) {}

  async create(data: CreateBoard): Promise<Board> {
    const now = new Date().toISOString();
    const board: Board = {
      id: ulid(),
      project_id: data.project_id,
      name: data.name,
      description: data.description || null,
      created_at: now,
      updated_at: now
    };

    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO boards (id, project_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [board.id, board.project_id, board.name, board.description, board.created_at, board.updated_at]
      );

      // Default columns
      const defaultCols = [
        { name: 'Backlog', wipLimit: null },
        { name: 'To Do', wipLimit: null },
        { name: 'In Progress', wipLimit: 3 },
        { name: 'In Review', wipLimit: 2 },
        { name: 'Done', wipLimit: null }
      ];

      let currentRank = generateRank();
      
      for (const col of defaultCols) {
        const colId = ulid();
        await tx.execute(
          `INSERT INTO columns (id, board_id, name, position, wip_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [colId, board.id, col.name, currentRank, col.wipLimit, now, now]
        );
        currentRank = rankAfter(currentRank);
      }
    });

    return board;
  }

  async list(projectId: string): Promise<Board[]> {
    return this.db.query<Board>(`SELECT * FROM boards WHERE project_id = ? ORDER BY created_at ASC`, [projectId]);
  }

  async getById(id: string): Promise<Board & { columns: any[] }> {
    const rows = await this.db.query<Board>(`SELECT * FROM boards WHERE id = ?`, [id]);
    if (rows.length === 0) {
      throw new NotFoundError(`Board with ID ${id} not found`);
    }
    const board = rows[0];

    const columns = await this.db.query<any>(
      `SELECT c.*, COUNT(cards.id) as card_count 
       FROM columns c
       LEFT JOIN cards ON cards.column_id = c.id AND cards.archived_at IS NULL
       WHERE c.board_id = ?
       GROUP BY c.id
       ORDER BY c.position ASC`,
      [id]
    );

    return { ...board, columns };
  }

  async update(id: string, data: Partial<CreateBoard>): Promise<Board> {
    const board = await this.getById(id);
    const updatedName = data.name !== undefined ? data.name : board.name;
    const updatedDescription = data.description !== undefined ? data.description : board.description;
    const updatedAt = new Date().toISOString();

    await this.db.execute(
      `UPDATE boards SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
      [updatedName, updatedDescription, updatedAt, id]
    );

    return this.getById(id);
  }

  async delete(id: string): Promise<void> {
    await this.getById(id); // checks existence
    await this.db.execute(`DELETE FROM boards WHERE id = ?`, [id]);
  }
}
```

### File: `src/services/column.service.ts`
```typescript
// File: src/services/column.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Column, CreateColumn, Event } from '../shared/types.js';
import { NotFoundError, ConflictError } from '../shared/errors.js';
import { generateRank, rankAfter } from '../shared/lexorank.js';

export class ColumnService {
  constructor(
    private db: DatabaseAdapter,
    private onEvent?: (event: Event) => void
  ) {}

  async create(data: CreateColumn): Promise<Column> {
    const now = new Date().toISOString();
    const cols = await this.db.query<Column>(
      `SELECT position FROM columns WHERE board_id = ? ORDER BY position DESC LIMIT 1`, 
      [data.board_id]
    );

    const position = cols.length > 0 ? rankAfter(cols[0].position) : generateRank();

    const column: Column = {
      id: ulid(),
      board_id: data.board_id,
      name: data.name,
      position,
      wip_limit: data.wip_limit || null,
      created_at: now,
      updated_at: now
    };

    await this.db.execute(
      `INSERT INTO columns (id, board_id, name, position, wip_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [column.id, column.board_id, column.name, column.position, column.wip_limit, column.created_at, column.updated_at]
    );

    return column;
  }

  async getById(id: string): Promise<Column> {
    const rows = await this.db.query<Column>(`SELECT * FROM columns WHERE id = ?`, [id]);
    if (rows.length === 0) {
      throw new NotFoundError(`Column with ID ${id} not found`);
    }
    return rows[0];
  }

  async update(id: string, data: Partial<CreateColumn>): Promise<Column> {
    const column = await this.getById(id);
    const updatedName = data.name !== undefined ? data.name : column.name;
    const updatedWip = data.wip_limit !== undefined ? data.wip_limit : column.wip_limit;
    const updatedAt = new Date().toISOString();

    await this.db.execute(
      `UPDATE columns SET name = ?, wip_limit = ?, updated_at = ? WHERE id = ?`,
      [updatedName, updatedWip, updatedAt, id]
    );

    return this.getById(id);
  }

  async move(id: string, position: string): Promise<Column> {
    const column = await this.getById(id);
    const updatedAt = new Date().toISOString();

    await this.db.execute(
      `UPDATE columns SET position = ?, updated_at = ? WHERE id = ?`,
      [position, updatedAt, id]
    );

    return this.getById(id);
  }

  async delete(id: string): Promise<void> {
    const column = await this.getById(id);
    
    const cards = await this.db.query<{count: number}>(`SELECT COUNT(*) as count FROM cards WHERE column_id = ? AND archived_at IS NULL`, [id]);
    if (cards[0].count > 0) {
      throw new ConflictError(`Cannot delete column with ID ${id} because it contains active cards`);
    }

    await this.db.execute(`DELETE FROM columns WHERE id = ?`, [id]);
  }
}
```

### File: `src/services/card.service.ts`
```typescript
// File: src/services/card.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Card, CreateCard, Event, Label, CardAssignee } from '../shared/types.js';
import { NotFoundError, ConflictError } from '../shared/errors.js';
import { generateRank, rankAfter } from '../shared/lexorank.js';

export class CardService {
  constructor(
    private db: DatabaseAdapter,
    private onEvent?: (event: Event) => void
  ) {}

  async create(data: CreateCard): Promise<Card> {
    const now = new Date().toISOString();

    const cards = await this.db.query<Card>(
      `SELECT position FROM cards WHERE column_id = ? AND archived_at IS NULL ORDER BY position DESC LIMIT 1`, 
      [data.column_id]
    );

    const position = cards.length > 0 ? rankAfter(cards[0].position) : generateRank();

    const card: Card = {
      id: ulid(),
      board_id: data.board_id,
      column_id: data.column_id,
      title: data.title,
      description: data.description || null,
      position,
      status: 'active',
      priority: data.priority || 'medium',
      due_date: data.due_date || null,
      created_at: now,
      updated_at: now,
      archived_at: null
    };

    await this.db.execute(
      `INSERT INTO cards (id, board_id, column_id, title, description, position, status, priority, due_date, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [card.id, card.board_id, card.column_id, card.title, card.description, card.position, card.status, card.priority, card.due_date, card.created_at, card.updated_at, card.archived_at]
    );

    return card;
  }

  async list(filters?: { columnId?: string; boardId?: string; assigneeId?: string; labelId?: string; archived?: boolean }): Promise<Card[]> {
    let sql = `
      SELECT DISTINCT c.* 
      FROM cards c
      LEFT JOIN card_assignees ca ON c.id = ca.card_id
      LEFT JOIN card_labels cl ON c.id = cl.card_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (filters?.columnId) {
      sql += ` AND c.column_id = ?`;
      params.push(filters.columnId);
    }
    if (filters?.boardId) {
      sql += ` AND c.board_id = ?`;
      params.push(filters.boardId);
    }
    if (filters?.assigneeId) {
      sql += ` AND ca.agent_id = ?`;
      params.push(filters.assigneeId);
    }
    if (filters?.labelId) {
      sql += ` AND cl.label_id = ?`;
      params.push(filters.labelId);
    }

    if (filters?.archived) {
      sql += ` AND c.archived_at IS NOT NULL`;
    } else {
      sql += ` AND c.archived_at IS NULL`;
    }

    sql += ` ORDER BY c.position ASC`;

    return this.db.query<Card>(sql, params);
  }

  async getById(id: string): Promise<Card & { labels: Label[], assignees: CardAssignee[], comments: any[] }> {
    const rows = await this.db.query<Card>(`SELECT * FROM cards WHERE id = ?`, [id]);
    if (rows.length === 0) {
      throw new NotFoundError(`Card with ID ${id} not found`);
    }
    const card = rows[0];

    const labels = await this.db.query<Label>(
      `SELECT l.* FROM labels l JOIN card_labels cl ON l.id = cl.label_id WHERE cl.card_id = ?`, [id]
    );
    const assignees = await this.db.query<CardAssignee>(
      `SELECT * FROM card_assignees WHERE card_id = ?`, [id]
    );
    const comments = await this.db.query<any>(
      `SELECT * FROM comments WHERE card_id = ? ORDER BY created_at ASC`, [id]
    );

    return { ...card, labels, assignees, comments };
  }

  async update(id: string, data: Partial<CreateCard>): Promise<Card> {
    const card = await this.getById(id);
    const updatedTitle = data.title !== undefined ? data.title : card.title;
    const updatedDesc = data.description !== undefined ? data.description : card.description;
    const updatedPriority = data.priority !== undefined ? data.priority : card.priority;
    const updatedDue = data.due_date !== undefined ? data.due_date : card.due_date;
    const updatedAt = new Date().toISOString();

    await this.db.execute(
      `UPDATE cards SET title = ?, description = ?, priority = ?, due_date = ?, updated_at = ? WHERE id = ?`,
      [updatedTitle, updatedDesc, updatedPriority, updatedDue, updatedAt, id]
    );

    return this.getById(id);
  }

  async move(id: string, targetColumnId: string, position?: string): Promise<Card> {
    const card = await this.getById(id);
    const updatedAt = new Date().toISOString();

    // Check WIP Limits if moving to a new column
    if (card.column_id !== targetColumnId) {
      const colRows = await this.db.query<{wip_limit: number | null}>(`SELECT wip_limit FROM columns WHERE id = ?`, [targetColumnId]);
      if (colRows.length > 0 && colRows[0].wip_limit !== null) {
        const countRows = await this.db.query<{count: number}>(`SELECT COUNT(*) as count FROM cards WHERE column_id = ? AND archived_at IS NULL`, [targetColumnId]);
        if (countRows[0].count >= colRows[0].wip_limit) {
          throw new ConflictError(`Cannot move card to column ${targetColumnId}, WIP limit exceeded`);
        }
      }
    }

    let finalPos = position;
    if (!finalPos) {
      const cards = await this.db.query<Card>(
        `SELECT position FROM cards WHERE column_id = ? AND archived_at IS NULL ORDER BY position DESC LIMIT 1`, 
        [targetColumnId]
      );
      finalPos = cards.length > 0 ? rankAfter(cards[0].position) : generateRank();
    }

    await this.db.execute(
      `UPDATE cards SET column_id = ?, position = ?, updated_at = ? WHERE id = ?`,
      [targetColumnId, finalPos, updatedAt, id]
    );

    return this.getById(id);
  }

  async assign(cardId: string, agentId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO card_assignees (card_id, agent_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      [cardId, agentId, now]
    );
  }

  async unassign(cardId: string, agentId: string): Promise<void> {
    await this.db.execute(
      `DELETE FROM card_assignees WHERE card_id = ? AND agent_id = ?`,
      [cardId, agentId]
    );
  }

  async addLabel(cardId: string, labelId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO card_labels (card_id, label_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      [cardId, labelId, now]
    );
  }

  async removeLabel(cardId: string, labelId: string): Promise<void> {
    await this.db.execute(
      `DELETE FROM card_labels WHERE card_id = ? AND label_id = ?`,
      [cardId, labelId]
    );
  }

  async archive(id: string): Promise<Card> {
    const card = await this.getById(id);
    const now = new Date().toISOString();
    
    await this.db.execute(
      `UPDATE cards SET archived_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id]
    );

    return this.getById(id);
  }
}
```

### File: `src/services/comment.service.ts`
```typescript
// File: src/services/comment.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Comment, CreateComment, Event } from '../shared/types.js';

export class CommentService {
  constructor(
    private db: DatabaseAdapter,
    private onEvent?: (event: Event) => void
  ) {}

  async create(data: CreateComment): Promise<Comment> {
    const now = new Date().toISOString();
    const comment: Comment = {
      id: ulid(),
      card_id: data.card_id,
      author_id: data.author_id,
      content: data.content,
      created_at: now,
      updated_at: now
    };

    await this.db.execute(
      `INSERT INTO comments (id, card_id, author_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [comment.id, comment.card_id, comment.author_id, comment.content, comment.created_at, comment.updated_at]
    );

    return comment;
  }

  async listByCard(cardId: string): Promise<Comment[]> {
    return this.db.query<Comment>(`SELECT * FROM comments WHERE card_id = ? ORDER BY created_at ASC`, [cardId]);
  }
}
```

### File: `src/services/document.service.ts`
```typescript
// File: src/services/document.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { Document, CreateDocument, UpdateDocument, DocumentVersion, Event, DocumentStatus } from '../shared/types.js';
import { NotFoundError } from '../shared/errors.js';

export class DocumentService {
  constructor(
    private db: DatabaseAdapter,
    private onEvent?: (event: Event) => void
  ) {}

  async create(data: CreateDocument): Promise<Document> {
    const now = new Date().toISOString();
    const docId = ulid();

    const doc: Document = {
      id: docId,
      project_id: data.project_id,
      parent_id: data.parent_id || null,
      title: data.title,
      content: data.content,
      status: 'draft',
      author_id: data.author_id,
      version: 1,
      created_at: now,
      updated_at: now
    };

    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO documents (id, project_id, parent_id, title, content, status, author_id, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [doc.id, doc.project_id, doc.parent_id, doc.title, doc.content, doc.status, doc.author_id, doc.version, doc.created_at, doc.updated_at]
      );

      const verId = ulid();
      await tx.execute(
        `INSERT INTO document_versions (id, document_id, version, title, content, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [verId, doc.id, doc.version, doc.title, doc.content, doc.author_id, now]
      );
    });

    return doc;
  }

  async list(projectId: string, filters?: { status?: DocumentStatus; parentId?: string }): Promise<Document[]> {
    let sql = `SELECT * FROM documents WHERE project_id = ?`;
    const params: any[] = [projectId];

    if (filters?.status) {
      sql += ` AND status = ?`;
      params.push(filters.status);
    }
    if (filters?.parentId !== undefined) {
      if (filters.parentId === null) {
        sql += ` AND parent_id IS NULL`;
      } else {
        sql += ` AND parent_id = ?`;
        params.push(filters.parentId);
      }
    }

    sql += ` ORDER BY updated_at DESC`;

    return this.db.query<Document>(sql, params);
  }

  async getById(id: string, version?: number): Promise<Document> {
    const rows = await this.db.query<Document>(`SELECT * FROM documents WHERE id = ?`, [id]);
    if (rows.length === 0) {
      throw new NotFoundError(`Document with ID ${id} not found`);
    }
    const doc = rows[0];

    if (version !== undefined) {
      const verRows = await this.db.query<DocumentVersion>(
        `SELECT * FROM document_versions WHERE document_id = ? AND version = ?`, [id, version]
      );
      if (verRows.length > 0) {
        doc.title = verRows[0].title;
        doc.content = verRows[0].content;
        doc.version = verRows[0].version;
      } else {
        throw new NotFoundError(`Version ${version} of Document ${id} not found`);
      }
    }

    return doc;
  }

  async update(id: string, data: UpdateDocument): Promise<Document> {
    const doc = await this.getById(id);
    const now = new Date().toISOString();
    const newVersion = doc.version + 1;

    const updatedTitle = data.title !== undefined ? data.title : doc.title;
    const updatedContent = data.content !== undefined ? data.content : doc.content;

    await this.db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE documents SET title = ?, content = ?, version = ?, updated_at = ? WHERE id = ?`,
        [updatedTitle, updatedContent, newVersion, now, id]
      );

      const verId = ulid();
      await tx.execute(
        `INSERT INTO document_versions (id, document_id, version, title, content, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [verId, doc.id, newVersion, updatedTitle, updatedContent, data.author_id, now]
      );
    });

    return this.getById(id);
  }

  async setStatus(id: string, status: DocumentStatus): Promise<Document> {
    await this.getById(id);
    const now = new Date().toISOString();
    await this.db.execute(`UPDATE documents SET status = ?, updated_at = ? WHERE id = ?`, [status, now, id]);
    return this.getById(id);
  }

  async getHistory(id: string): Promise<DocumentVersion[]> {
    return this.db.query<DocumentVersion>(
      `SELECT * FROM document_versions WHERE document_id = ? ORDER BY version DESC`, [id]
    );
  }
}
```

### File: `src/services/agent.service.ts`
```typescript
// File: src/services/agent.service.ts
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { AgentRegistration, RegisterAgent, Event } from '../shared/types.js';
import { NotFoundError } from '../shared/errors.js';

export class AgentService {
  constructor(
    private db: DatabaseAdapter,
    private onEvent?: (event: Event) => void
  ) {}

  async register(data: RegisterAgent): Promise<AgentRegistration> {
    const now = new Date().toISOString();
    
    // Check if already registered
    const existing = await this.db.query<AgentRegistration>(
      `SELECT * FROM agent_registrations WHERE project_id = ? AND agent_type = ? AND role = ? AND status != 'offline' LIMIT 1`,
      [data.project_id, data.agent_type, data.role]
    );

    if (existing.length > 0) {
      // Just refresh heartbeat
      return this.heartbeat(existing[0].id);
    }

    const registration: AgentRegistration = {
      id: ulid(),
      project_id: data.project_id,
      agent_type: data.agent_type,
      role: data.role,
      status: 'active',
      capabilities: data.capabilities || [],
      last_seen_at: now,
      created_at: now
    };

    const caps = JSON.stringify(registration.capabilities);

    await this.db.execute(
      `INSERT INTO agent_registrations (id, project_id, agent_type, role, status, capabilities, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [registration.id, registration.project_id, registration.agent_type, registration.role, registration.status, caps, registration.last_seen_at, registration.created_at]
    );

    return registration;
  }

  async list(projectId: string): Promise<AgentRegistration[]> {
    const rows = await this.db.query<any>(`SELECT * FROM agent_registrations WHERE project_id = ? ORDER BY last_seen_at DESC`, [projectId]);
    return rows.map(row => ({
      ...row,
      capabilities: typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities
    }));
  }

  async getById(id: string): Promise<AgentRegistration> {
    const rows = await this.db.query<any>(`SELECT * FROM agent_registrations WHERE id = ?`, [id]);
    if (rows.length === 0) {
      throw new NotFoundError(`Agent registration with ID ${id} not found`);
    }
    const row = rows[0];
    return {
      ...row,
      capabilities: typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities
    };
  }

  async heartbeat(id: string): Promise<AgentRegistration> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE agent_registrations SET status = 'active', last_seen_at = ? WHERE id = ?`,
      [now, id]
    );
    return this.getById(id);
  }

  async updateStatus(): Promise<void> {
    const now = new Date();
    
    // Idle if > 5 mins
    const idleTime = new Date(now.getTime() - 5 * 60000).toISOString();
    // Offline if > 15 mins
    const offlineTime = new Date(now.getTime() - 15 * 60000).toISOString();

    await this.db.execute(
      `UPDATE agent_registrations 
       SET status = 'idle' 
       WHERE status = 'active' AND last_seen_at < ? AND last_seen_at >= ?`,
      [idleTime, offlineTime]
    );

    await this.db.execute(
      `UPDATE agent_registrations 
       SET status = 'offline' 
       WHERE status != 'offline' AND last_seen_at < ?`,
      [offlineTime]
    );
  }
}
```
## 7. Real-Time Events (SSE)

### File: `src/realtime/sse.ts`
```typescript
// File: src/realtime/sse.ts
import { Response } from 'express';
import { Event } from '../types';

export class SSEManager {
  private clients: Map<string, Set<Response>> = new Map();

  public addClient(res: Response, projectId: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    if (!this.clients.has(projectId)) {
      this.clients.set(projectId, new Set());
    }
    
    this.clients.get(projectId)!.add(res);

    res.on('close', () => {
      this.removeClient(res, projectId);
    });
  }

  public removeClient(res: Response, projectId: string): void {
    const projectClients = this.clients.get(projectId);
    if (projectClients) {
      projectClients.delete(res);
      if (projectClients.size === 0) {
        this.clients.delete(projectId);
      }
    }
  }

  public broadcast = (projectId: string, event: Event): void => {
    const projectClients = this.clients.get(projectId);
    if (projectClients) {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      projectClients.forEach((client) => {
        client.write(data);
      });
    }
  };
}
```

## 8. MCP Server

### File: `src/mcp/server.ts`
```typescript
// File: src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ProjectService,
  BoardService,
  ColumnService,
  CardService,
  CommentService,
  DocumentService,
  AgentService,
  EventService
} from '../services';

export interface Services {
  projectService: ProjectService;
  boardService: BoardService;
  columnService: ColumnService;
  cardService: CardService;
  commentService: CommentService;
  documentService: DocumentService;
  agentService: AgentService;
  eventService: EventService;
}

export function createMcpServer(services: Services): McpServer {
  const server = new McpServer({
    name: 'Muster',
    version: '1.0.0',
  });

  const handleError = (error: any) => {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  };

  const handleSuccess = (result: any) => {
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };

  // --- Project Management ---
  server.tool(
    'list_projects',
    {},
    async () => {
      try {
        const result = await services.projectService.listProjects();
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'create_project',
    { name: z.string(), description: z.string().optional() },
    async ({ name, description }) => {
      try {
        const result = await services.projectService.createProject({ name, description });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // --- Board Management ---
  server.tool(
    'list_boards',
    { project_id: z.string() },
    async ({ project_id }) => {
      try {
        const result = await services.boardService.listBoards(project_id);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'create_board',
    { project_id: z.string(), name: z.string() },
    async ({ project_id, name }) => {
      try {
        const result = await services.boardService.createBoard({ projectId: project_id, name });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'get_board',
    { board_id: z.string() },
    async ({ board_id }) => {
      try {
        const result = await services.boardService.getBoard(board_id);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // --- Column Management ---
  server.tool(
    'create_column',
    {
      board_id: z.string(),
      name: z.string(),
      position: z.string().optional(),
      wip_limit: z.number().optional()
    },
    async ({ board_id, name, position, wip_limit }) => {
      try {
        const result = await services.columnService.createColumn({ 
          boardId: board_id, 
          name, 
          position: position ? parseFloat(position) : undefined, 
          wipLimit: wip_limit 
        });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'update_column',
    {
      column_id: z.string(),
      name: z.string().optional(),
      wip_limit: z.number().optional()
    },
    async ({ column_id, name, wip_limit }) => {
      try {
        const result = await services.columnService.updateColumn(column_id, { name, wipLimit: wip_limit });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'move_column',
    {
      column_id: z.string(),
      position: z.string()
    },
    async ({ column_id, position }) => {
      try {
        const result = await services.columnService.moveColumn(column_id, parseFloat(position));
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'delete_column',
    { column_id: z.string() },
    async ({ column_id }) => {
      try {
        await services.columnService.deleteColumn(column_id);
        return handleSuccess({ success: true });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // --- Card Management ---
  server.tool(
    'list_cards',
    {
      column_id: z.string().optional(),
      board_id: z.string().optional(),
      assignee_id: z.string().optional(),
      label_id: z.string().optional(),
      archived: z.boolean().optional()
    },
    async (filters) => {
      try {
        const result = await services.cardService.listCards(filters);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'create_card',
    {
      column_id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      priority: z.string().optional(),
      assignees: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional()
    },
    async (data) => {
      try {
        const result = await services.cardService.createCard({
          columnId: data.column_id,
          title: data.title,
          description: data.description,
          priority: data.priority as any,
          assignees: data.assignees,
          labels: data.labels
        });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'get_card',
    { card_id: z.string().describe('The card ULID or its human-readable key (e.g. "MUS-49")') },
    async ({ card_id }) => {
      try {
        const result = await services.cardService.getCard(card_id);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'update_card',
    {
      card_id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.string().optional(),
      due_date: z.string().optional()
    },
    async ({ card_id, title, description, priority, due_date }) => {
      try {
        const result = await services.cardService.updateCard(card_id, {
          title,
          description,
          priority: priority as any,
          dueDate: due_date ? new Date(due_date) : undefined
        });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'move_card',
    {
      card_id: z.string(),
      target_column_id: z.string(),
      position: z.string().optional()
    },
    async ({ card_id, target_column_id, position }) => {
      try {
        const result = await services.cardService.moveCard(card_id, target_column_id, position ? parseFloat(position) : undefined);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'assign_card',
    {
      card_id: z.string(),
      agent_id: z.string()
    },
    async ({ card_id, agent_id }) => {
      try {
        await services.cardService.assignCard(card_id, agent_id);
        return handleSuccess({ success: true });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'unassign_card',
    {
      card_id: z.string(),
      agent_id: z.string()
    },
    async ({ card_id, agent_id }) => {
      try {
        await services.cardService.unassignCard(card_id, agent_id);
        return handleSuccess({ success: true });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'add_comment',
    {
      card_id: z.string(),
      content: z.string(),
      author_id: z.string()
    },
    async ({ card_id, content, author_id }) => {
      try {
        const result = await services.commentService.addComment({ cardId: card_id, content, authorId: author_id });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'add_label',
    {
      card_id: z.string(),
      label_id: z.string()
    },
    async ({ card_id, label_id }) => {
      try {
        await services.cardService.addLabel(card_id, label_id);
        return handleSuccess({ success: true });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'remove_label',
    {
      card_id: z.string(),
      label_id: z.string()
    },
    async ({ card_id, label_id }) => {
      try {
        await services.cardService.removeLabel(card_id, label_id);
        return handleSuccess({ success: true });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'archive_card',
    {
      card_id: z.string()
    },
    async ({ card_id }) => {
      try {
        const result = await services.cardService.archiveCard(card_id);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // --- Label Management ---
  server.tool(
    'create_label',
    {
      board_id: z.string(),
      name: z.string(),
      color: z.string()
    },
    async ({ board_id, name, color }) => {
      try {
        const result = await services.boardService.createLabel({ boardId: board_id, name, color });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'list_labels',
    {
      board_id: z.string()
    },
    async ({ board_id }) => {
      try {
        const result = await services.boardService.listLabels(board_id);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // --- Document Management ---
  server.tool(
    'list_documents',
    {
      project_id: z.string(),
      status: z.string().optional(),
      parent_id: z.string().optional()
    },
    async ({ project_id, status, parent_id }) => {
      try {
        const result = await services.documentService.listDocuments(project_id, { status: status as any, parentId: parent_id });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'create_document',
    {
      project_id: z.string(),
      title: z.string(),
      content: z.string(),
      author_id: z.string(),
      parent_id: z.string().optional()
    },
    async ({ project_id, title, content, author_id, parent_id }) => {
      try {
        const result = await services.documentService.createDocument({ projectId: project_id, title, content, authorId: author_id, parentId: parent_id });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'get_document',
    {
      document_id: z.string(),
      version: z.number().optional()
    },
    async ({ document_id, version }) => {
      try {
        const result = await services.documentService.getDocument(document_id, version);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'update_document',
    {
      document_id: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      change_summary: z.string(),
      author_id: z.string()
    },
    async ({ document_id, title, content, change_summary, author_id }) => {
      try {
        const result = await services.documentService.updateDocument(document_id, { title, content, changeSummary: change_summary, authorId: author_id });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'set_document_status',
    {
      document_id: z.string(),
      status: z.string()
    },
    async ({ document_id, status }) => {
      try {
        const result = await services.documentService.setDocumentStatus(document_id, status as any);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'get_document_history',
    {
      document_id: z.string()
    },
    async ({ document_id }) => {
      try {
        const result = await services.documentService.getDocumentHistory(document_id);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // --- Agent Management ---
  server.tool(
    'register_agent',
    {
      project_id: z.string(),
      name: z.string(),
      type: z.string(),
      role: z.string(),
      capabilities: z.array(z.string()).optional()
    },
    async ({ project_id, name, type, role, capabilities }) => {
      try {
        const result = await services.agentService.registerAgent({ projectId: project_id, name, type: type as any, role, capabilities });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'heartbeat',
    {
      agent_id: z.string()
    },
    async ({ agent_id }) => {
      try {
        await services.agentService.heartbeat(agent_id);
        return handleSuccess({ success: true });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'list_agents',
    {
      project_id: z.string()
    },
    async ({ project_id }) => {
      try {
        const result = await services.agentService.listAgents(project_id);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.tool(
    'get_project_summary',
    {
      project_id: z.string()
    },
    async ({ project_id }) => {
      try {
        const result = await services.projectService.getProjectSummary(project_id);
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // --- Activity ---
  server.tool(
    'get_activity',
    {
      project_id: z.string(),
      entity_type: z.string().optional(),
      entity_id: z.string().optional(),
      since: z.string().optional(),
      limit: z.number().optional()
    },
    async ({ project_id, entity_type, entity_id, since, limit }) => {
      try {
        const result = await services.eventService.getEvents(project_id, {
          entityType: entity_type as any,
          entityId: entity_id,
          since: since ? new Date(since) : undefined,
          limit
        });
        return handleSuccess(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // --- Resources ---
  server.resource(
    'project-summary',
    'muster://project/{id}/summary',
    async (uri, { id }) => {
      const summary = await services.projectService.getProjectSummary(id as string);
      return { contents: [{ uri: uri.href, text: JSON.stringify(summary) }] };
    }
  );

  server.resource(
    'board-details',
    'muster://board/{id}',
    async (uri, { id }) => {
      const board = await services.boardService.getBoard(id as string);
      return { contents: [{ uri: uri.href, text: JSON.stringify(board) }] };
    }
  );

  server.resource(
    'card-details',
    'muster://card/{id}',
    async (uri, { id }) => {
      const card = await services.cardService.getCard(id as string);
      return { contents: [{ uri: uri.href, text: JSON.stringify(card) }] };
    }
  );

  server.resource(
    'document-details',
    'muster://document/{id}',
    async (uri, { id }) => {
      const document = await services.documentService.getDocument(id as string);
      return { contents: [{ uri: uri.href, text: JSON.stringify(document) }] };
    }
  );

  server.resource(
    'project-activity',
    'muster://project/{id}/activity',
    async (uri, { id }) => {
      const activity = await services.eventService.getEvents(id as string);
      return { contents: [{ uri: uri.href, text: JSON.stringify(activity) }] };
    }
  );

  return server;
}
```

## 9. REST API

### File: `src/api/middleware/error-handler.ts`
```typescript
// File: src/api/middleware/error-handler.ts
import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../errors';

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
  console.error(err);

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  res.status(500).json({ error: 'Internal Server Error' });
}
```

### File: `src/api/middleware/validate.ts`
```typescript
// File: src/api/middleware/validate.ts
import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';
import { ValidationError } from '../../errors';

export const validate = (schema: AnyZodObject, target: 'body' | 'query' | 'params' = 'body') => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req[target] = await schema.parseAsync(req[target]);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(new ValidationError(error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')));
      } else {
        next(error);
      }
    }
  };
};
```

### File: `src/api/router.ts`
```typescript
// File: src/api/router.ts
import { Router } from 'express';
import { Services } from '../mcp/server';
import { SSEManager } from '../realtime/sse';
import { createProjectRoutes } from './routes/project.routes';
import { createBoardRoutes } from './routes/board.routes';
import { createColumnRoutes } from './routes/column.routes';
import { createCardRoutes } from './routes/card.routes';
import { createDocumentRoutes } from './routes/document.routes';
import { createAgentRoutes } from './routes/agent.routes';
import { createEventRoutes } from './routes/event.routes';

export function createRouter(services: Services, sseManager: SSEManager): Router {
  const router = Router();

  router.use('/projects', createProjectRoutes(services.projectService));
  router.use('/boards', createBoardRoutes(services.boardService));
  router.use('/columns', createColumnRoutes(services.columnService));
  router.use('/cards', createCardRoutes(services.cardService, services.commentService));
  router.use('/documents', createDocumentRoutes(services.documentService));
  router.use('/agents', createAgentRoutes(services.agentService));
  router.use('/events', createEventRoutes(services.eventService, sseManager));

  return router;
}
```

### Route files

### File: `src/api/routes/project.routes.ts`
```typescript
// File: src/api/routes/project.routes.ts
import { Router } from 'express';
import { ProjectService } from '../../services';

export function createProjectRoutes(projectService: ProjectService): Router {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      const result = await projectService.createProject(req.body);
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  router.get('/', async (req, res, next) => {
    try {
      const result = await projectService.listProjects();
      res.json(result);
    } catch (err) { next(err); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const result = await projectService.getProject(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.get('/:id/summary', async (req, res, next) => {
    try {
      const result = await projectService.getProjectSummary(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  });

  return router;
}
```

### File: `src/api/routes/board.routes.ts`
```typescript
// File: src/api/routes/board.routes.ts
import { Router } from 'express';
import { BoardService } from '../../services';

export function createBoardRoutes(boardService: BoardService): Router {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      const result = await boardService.createBoard(req.body);
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  router.get('/', async (req, res, next) => {
    try {
      const result = await boardService.listBoards(req.query.projectId as string);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const result = await boardService.getBoard(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post('/:id/labels', async (req, res, next) => {
    try {
      const result = await boardService.createLabel({ ...req.body, boardId: req.params.id });
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  router.get('/:id/labels', async (req, res, next) => {
    try {
      const result = await boardService.listLabels(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  });

  return router;
}
```

### File: `src/api/routes/column.routes.ts`
```typescript
// File: src/api/routes/column.routes.ts
import { Router } from 'express';
import { ColumnService } from '../../services';

export function createColumnRoutes(columnService: ColumnService): Router {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      const result = await columnService.createColumn(req.body);
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const result = await columnService.updateColumn(req.params.id, req.body);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post('/:id/move', async (req, res, next) => {
    try {
      const result = await columnService.moveColumn(req.params.id, req.body.position);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      await columnService.deleteColumn(req.params.id);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return router;
}
```

### File: `src/api/routes/card.routes.ts`
```typescript
// File: src/api/routes/card.routes.ts
import { Router } from 'express';
import { CardService, CommentService } from '../../services';

export function createCardRoutes(cardService: CardService, commentService: CommentService): Router {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      const result = await cardService.createCard(req.body);
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  router.get('/', async (req, res, next) => {
    try {
      const result = await cardService.listCards(req.query);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const result = await cardService.getCard(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const result = await cardService.updateCard(req.params.id, req.body);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post('/:id/move', async (req, res, next) => {
    try {
      const result = await cardService.moveCard(req.params.id, req.body.targetColumnId, req.body.position);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post('/:id/assign', async (req, res, next) => {
    try {
      await cardService.assignCard(req.params.id, req.body.agentId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  router.post('/:id/unassign', async (req, res, next) => {
    try {
      await cardService.unassignCard(req.params.id, req.body.agentId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  router.post('/:id/labels', async (req, res, next) => {
    try {
      await cardService.addLabel(req.params.id, req.body.labelId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  router.delete('/:id/labels/:labelId', async (req, res, next) => {
    try {
      await cardService.removeLabel(req.params.id, req.params.labelId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  router.post('/:id/archive', async (req, res, next) => {
    try {
      const result = await cardService.archiveCard(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post('/:id/comments', async (req, res, next) => {
    try {
      const result = await commentService.addComment({ cardId: req.params.id, ...req.body });
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  return router;
}
```

### File: `src/api/routes/document.routes.ts`
```typescript
// File: src/api/routes/document.routes.ts
import { Router } from 'express';
import { DocumentService } from '../../services';

export function createDocumentRoutes(documentService: DocumentService): Router {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      const result = await documentService.createDocument(req.body);
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  router.get('/', async (req, res, next) => {
    try {
      const result = await documentService.listDocuments(req.query.projectId as string, req.query);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const version = req.query.version ? parseInt(req.query.version as string, 10) : undefined;
      const result = await documentService.getDocument(req.params.id, version);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const result = await documentService.updateDocument(req.params.id, req.body);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.post('/:id/status', async (req, res, next) => {
    try {
      const result = await documentService.setDocumentStatus(req.params.id, req.body.status);
      res.json(result);
    } catch (err) { next(err); }
  });

  router.get('/:id/history', async (req, res, next) => {
    try {
      const result = await documentService.getDocumentHistory(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  });

  return router;
}
```

### File: `src/api/routes/agent.routes.ts`
```typescript
// File: src/api/routes/agent.routes.ts
import { Router } from 'express';
import { AgentService } from '../../services';

export function createAgentRoutes(agentService: AgentService): Router {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      const result = await agentService.registerAgent(req.body);
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  router.post('/:id/heartbeat', async (req, res, next) => {
    try {
      await agentService.heartbeat(req.params.id);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  router.get('/', async (req, res, next) => {
    try {
      const result = await agentService.listAgents(req.query.projectId as string);
      res.json(result);
    } catch (err) { next(err); }
  });

  return router;
}
```

### File: `src/api/routes/event.routes.ts`
```typescript
// File: src/api/routes/event.routes.ts
import { Router } from 'express';
import { EventService } from '../../services';
import { SSEManager } from '../../realtime/sse';

export function createEventRoutes(eventService: EventService, sseManager: SSEManager): Router {
  const router = Router();

  router.get('/stream', (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }
    sseManager.addClient(res, projectId);
  });

  router.get('/', async (req, res, next) => {
    try {
      const result = await eventService.getEvents(req.query.projectId as string, req.query as any);
      res.json(result);
    } catch (err) { next(err); }
  });

  return router;
}
```

## 10. Entry Point

### File: `src/index.ts`
```typescript
// File: src/index.ts
import express from 'express';
import path from 'path';
import { createDatabaseAdapter } from './db/factory';
import {
  ProjectService,
  BoardService,
  ColumnService,
  CardService,
  CommentService,
  DocumentService,
  AgentService,
  EventService
} from './services';
import { SSEManager } from './realtime/sse';
import { createRouter } from './api/router';
import { errorHandler } from './api/middleware/error-handler';
import { createMcpServer } from './mcp/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function main() {
  const db = createDatabaseAdapter();
  await db.migrate();

  const sseManager = new SSEManager();
  const eventService = new EventService(db, sseManager.broadcast);

  const services = {
    projectService: new ProjectService(db, eventService.broadcast),
    boardService: new BoardService(db, eventService.broadcast),
    columnService: new ColumnService(db, eventService.broadcast),
    cardService: new CardService(db, eventService.broadcast),
    commentService: new CommentService(db, eventService.broadcast),
    documentService: new DocumentService(db, eventService.broadcast),
    agentService: new AgentService(db, eventService.broadcast),
    eventService
  };

  const existingProjects = await services.projectService.listProjects();
  console.log(`Starting Muster... Found ${existingProjects.length} existing project(s).`);

  const app = express();
  app.use(express.json());
  
  app.use(express.static(path.join(__dirname, '../public')));
  
  const apiRouter = createRouter(services, sseManager);
  app.use('/api', apiRouter);
  
  app.use(errorHandler);

  const mcpServer = createMcpServer(services);
  
  if (process.argv.includes('--stdio')) {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error('MCP Server running on stdio');
  }

  const port = process.env.PORT || 6878;
  const server = app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });

  const shutdown = async () => {
    console.log('Shutting down...');
    server.close();
    await db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
```
## 11. Web UI

The web UI is served as static files from the `public/` directory. It's vanilla HTML/CSS/JS — no build step required for the frontend. 

### File: `public/index.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard - Muster</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header class="app-header">
        <div class="header-brand">
            <h1>Muster</h1>
        </div>
        <div class="header-controls">
            <select id="project-selector" class="select-input">
                <option value="">Loading projects...</option>
            </select>
            <nav class="main-nav">
                <a href="index.html" class="nav-link active">Dashboard</a>
                <a href="board.html" class="nav-link">Boards</a>
                <a href="document.html" class="nav-link">Documents</a>
                <a href="activity.html" class="nav-link">Activity</a>
            </nav>
        </div>
    </header>

    <main class="dashboard-grid">
        <!-- Agents Online Panel -->
        <section class="panel glass-panel">
            <div class="panel-header">
                <h2>Agents Online</h2>
                <span class="badge" id="agent-count">0</span>
            </div>
            <div class="panel-content" id="agents-list">
                <div class="loading-spinner">Loading agents...</div>
            </div>
        </section>

        <!-- Board Snapshot Panel -->
        <section class="panel glass-panel">
            <div class="panel-header">
                <h2>Board Snapshot</h2>
                <select id="board-selector" class="select-input select-sm">
                    <option value="">Select Board</option>
                </select>
            </div>
            <div class="panel-content" id="board-snapshot">
                <div class="empty-state">No board selected</div>
            </div>
        </section>

        <!-- Recent Activity Panel -->
        <section class="panel glass-panel dashboard-activity">
            <div class="panel-header">
                <h2>Recent Activity</h2>
                <div class="live-indicator">
                    <span class="pulse-dot"></span> Live
                </div>
            </div>
            <div class="panel-content activity-feed" id="activity-list">
                <div class="loading-spinner">Waiting for activity...</div>
            </div>
        </section>

        <!-- Design Documents Panel -->
        <section class="panel glass-panel">
            <div class="panel-header">
                <h2>Design Documents</h2>
                <a href="document.html" class="btn btn-sm">View All</a>
            </div>
            <div class="panel-content" id="documents-list">
                <div class="loading-spinner">Loading documents...</div>
            </div>
        </section>
    </main>

    <script src="js/app.js"></script>
    <script src="js/dashboard.js"></script>
</body>
</html>
```

### File: `public/styles.css`
```css
/* Design Tokens */
:root {
    --bg-base: #0f1117;
    --bg-panel: rgba(26, 29, 39, 0.7);
    --bg-panel-solid: #1a1d27;
    --bg-panel-hover: #222633;
    
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --text-muted: #64748b;
    
    --accent-primary: #6366f1;
    --accent-hover: #4f46e5;
    
    --status-green: #22c55e;
    --status-yellow: #eab308;
    --status-red: #ef4444;
    --status-blue: #3b82f6;
    --status-gray: #64748b;
    
    --border-color: rgba(255, 255, 255, 0.1);
    --border-highlight: rgba(255, 255, 255, 0.2);
    
    --radius-sm: 4px;
    --radius-md: 8px;
    --radius-lg: 12px;
    
    --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
    
    --font-main: 'Inter', system-ui, -apple-system, sans-serif;
}

/* Reset & Base */
* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

body {
    font-family: var(--font-main);
    background-color: var(--bg-base);
    color: var(--text-primary);
    line-height: 1.5;
    min-height: 100vh;
    overflow-x: hidden;
}

a {
    color: var(--accent-primary);
    text-decoration: none;
}

a:hover {
    color: var(--accent-hover);
}

/* Layout */
.app-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 2rem;
    background-color: var(--bg-panel-solid);
    border-bottom: 1px solid var(--border-color);
    position: sticky;
    top: 0;
    z-index: 100;
}

.header-brand h1 {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
}

.header-controls {
    display: flex;
    align-items: center;
    gap: 1.5rem;
}

.main-nav {
    display: flex;
    gap: 1rem;
}

.nav-link {
    color: var(--text-secondary);
    font-weight: 500;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-sm);
    transition: all 0.2s;
}

.nav-link:hover, .nav-link.active {
    color: var(--text-primary);
    background-color: rgba(255,255,255,0.05);
}

/* Dashboard Grid */
.dashboard-grid {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    grid-auto-rows: minmax(300px, auto);
    gap: 1.5rem;
    padding: 2rem;
    max-width: 1600px;
    margin: 0 auto;
}

.dashboard-grid > section:nth-child(1) { grid-column: span 4; } /* Agents */
.dashboard-grid > section:nth-child(2) { grid-column: span 8; } /* Board Snapshot */
.dashboard-grid > section:nth-child(3) { grid-column: span 6; } /* Activity */
.dashboard-grid > section:nth-child(4) { grid-column: span 6; } /* Documents */

/* Glass Panels */
.glass-panel {
    background: var(--bg-panel);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--shadow-md);
}

.panel-header {
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(0,0,0,0.2);
}

.panel-header h2 {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0;
}

.panel-content {
    padding: 1.5rem;
    flex: 1;
    overflow-y: auto;
}

/* Scrollbars */
::-webkit-scrollbar {
    width: 8px;
    height: 8px;
}
::-webkit-scrollbar-track {
    background: rgba(0,0,0,0.1);
}
::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.2);
    border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
    background: rgba(255,255,255,0.3);
}

/* Components */
.select-input {
    background-color: var(--bg-base);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    padding: 0.5rem 1rem;
    font-family: inherit;
    font-size: 0.9rem;
    outline: none;
}

.select-input:focus {
    border-color: var(--accent-primary);
}

.select-sm {
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
}

.btn {
    background-color: var(--accent-primary);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    padding: 0.5rem 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s;
    display: inline-block;
    text-align: center;
}

.btn:hover {
    background-color: var(--accent-hover);
    color: white;
}

.btn-sm {
    padding: 0.25rem 0.75rem;
    font-size: 0.8rem;
}

.btn-outline {
    background-color: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-primary);
}

.btn-outline:hover {
    background-color: rgba(255,255,255,0.05);
    border-color: var(--border-highlight);
}

/* Status & Badges */
.status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 8px;
}
.status-online { background-color: var(--status-green); box-shadow: 0 0 8px var(--status-green); }
.status-busy { background-color: var(--status-yellow); box-shadow: 0 0 8px var(--status-yellow); }
.status-offline { background-color: var(--status-red); }

.badge {
    padding: 0.2rem 0.5rem;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.badge-default { background: rgba(255,255,255,0.1); color: var(--text-primary); }
.badge-critical { background: rgba(239, 68, 68, 0.2); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }
.badge-high { background: rgba(234, 179, 8, 0.2); color: #fde047; border: 1px solid rgba(234, 179, 8, 0.3); }
.badge-medium { background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.3); }
.badge-low { background: rgba(100, 116, 139, 0.2); color: #cbd5e1; border: 1px solid rgba(100, 116, 139, 0.3); }

/* Documents */
.badge-draft { background: rgba(100, 116, 139, 0.2); color: #cbd5e1; }
.badge-review { background: rgba(245, 158, 11, 0.2); color: #fcd34d; }
.badge-approved { background: rgba(34, 197, 94, 0.2); color: #86efac; }
.badge-archived { background: rgba(0,0,0,0.3); color: var(--text-muted); }

/* Live Indicator */
.live-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: var(--status-green);
    font-weight: 500;
}
.pulse-dot {
    width: 8px;
    height: 8px;
    background-color: var(--status-green);
    border-radius: 50%;
    animation: pulse 2s infinite;
}
@keyframes pulse {
    0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
    70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
    100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
}

/* Agent List */
.agent-item {
    display: flex;
    align-items: center;
    padding: 1rem 0;
    border-bottom: 1px solid var(--border-color);
}
.agent-item:last-child { border-bottom: none; }
.agent-info { flex: 1; }
.agent-name { font-weight: 600; display: flex; align-items: center; margin-bottom: 0.25rem; }
.agent-role { font-size: 0.85rem; color: var(--text-secondary); }
.agent-task { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem; }

/* Activity Feed */
.activity-feed {
    display: flex;
    flex-direction: column;
    gap: 1rem;
}
.activity-item {
    display: flex;
    gap: 1rem;
    padding: 1rem;
    background: rgba(255,255,255,0.02);
    border-radius: var(--radius-md);
    border-left: 3px solid var(--accent-primary);
    animation: slideIn 0.3s ease-out forwards;
}
.activity-item.system { border-left-color: var(--status-gray); }
.activity-item.agent { border-left-color: var(--status-blue); }
.activity-item.user { border-left-color: var(--status-green); }
.activity-item.error { border-left-color: var(--status-red); }

@keyframes slideIn {
    from { opacity: 0; transform: translateX(-10px); }
    to { opacity: 1; transform: translateX(0); }
}

.activity-icon {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--bg-base);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.9rem;
}
.activity-content { flex: 1; }
.activity-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.25rem;
    font-size: 0.85rem;
}
.activity-author { font-weight: 600; color: var(--text-primary); }
.activity-time { color: var(--text-muted); }
.activity-message { color: var(--text-secondary); font-size: 0.95rem; }
.activity-details { 
    margin-top: 0.5rem;
    background: rgba(0,0,0,0.2);
    padding: 0.5rem;
    border-radius: var(--radius-sm);
    font-family: monospace;
    font-size: 0.8rem;
    color: var(--text-muted);
    overflow-x: auto;
}

/* Document List */
.doc-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    background: rgba(255,255,255,0.02);
    border-radius: var(--radius-md);
    margin-bottom: 0.75rem;
    transition: background 0.2s;
}
.doc-item:hover {
    background: rgba(255,255,255,0.05);
}
.doc-title { font-weight: 500; color: var(--text-primary); margin-bottom: 0.25rem; }
.doc-meta { font-size: 0.8rem; color: var(--text-secondary); display: flex; gap: 1rem; }

/* Board Snapshot */
.snapshot-columns {
    display: flex;
    gap: 1rem;
    height: 100%;
}
.snapshot-column {
    flex: 1;
    background: rgba(0,0,0,0.2);
    border-radius: var(--radius-md);
    padding: 1rem;
    display: flex;
    flex-direction: column;
}
.snapshot-col-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 1rem;
    font-weight: 500;
    font-size: 0.9rem;
}
.snapshot-mini-card {
    background: var(--bg-panel-solid);
    padding: 0.5rem;
    border-radius: var(--radius-sm);
    margin-bottom: 0.5rem;
    font-size: 0.8rem;
    border-left: 2px solid var(--accent-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* Full Board (board.html) */
.board-container {
    display: flex;
    gap: 1.5rem;
    padding: 1.5rem 2rem;
    height: calc(100vh - 73px);
    overflow-x: auto;
    overflow-y: hidden;
}
.board-column {
    background: var(--bg-panel);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    width: 320px;
    min-width: 320px;
    display: flex;
    flex-direction: column;
    max-height: 100%;
}
.board-col-header {
    padding: 1rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(0,0,0,0.2);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}
.board-col-title { font-weight: 600; }
.wip-limit { font-size: 0.8rem; color: var(--text-muted); }
.wip-limit.exceeded { color: var(--status-red); font-weight: bold; }

.board-cards {
    padding: 1rem;
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.kanban-card {
    background: var(--bg-panel-solid);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 1rem;
    cursor: grab;
    box-shadow: var(--shadow-sm);
    transition: transform 0.1s, box-shadow 0.1s;
}
.kanban-card:hover {
    border-color: var(--border-highlight);
    box-shadow: var(--shadow-md);
}
.kanban-card:active {
    cursor: grabbing;
}
.kanban-card.dragging {
    opacity: 0.5;
    transform: scale(0.95);
}
.card-title {
    font-size: 0.95rem;
    font-weight: 500;
    margin-bottom: 0.5rem;
    line-height: 1.4;
}
.card-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 1rem;
}
.card-assignee {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
}
.avatar-sm {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--accent-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 0.7rem;
    font-weight: bold;
}

/* Empty States & Loading */
.empty-state {
    text-align: center;
    padding: 2rem;
    color: var(--text-muted);
    font-style: italic;
}
.loading-spinner {
    text-align: center;
    padding: 2rem;
    color: var(--text-secondary);
}

/* Modals */
.modal-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
}
.modal-overlay.active {
    opacity: 1;
    pointer-events: auto;
}
.modal-content {
    background: var(--bg-panel-solid);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 600px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: var(--shadow-lg);
    transform: translateY(20px);
    transition: transform 0.2s;
}
.modal-overlay.active .modal-content {
    transform: translateY(0);
}
.modal-header {
    padding: 1.5rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.modal-body {
    padding: 1.5rem;
    overflow-y: auto;
}
.modal-footer {
    padding: 1.5rem;
    border-top: 1px solid var(--border-color);
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
}
.close-modal {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.5rem;
    cursor: pointer;
}
.close-modal:hover { color: var(--text-primary); }

/* Document Split View */
.doc-container {
    display: flex;
    height: calc(100vh - 73px);
}
.doc-sidebar {
    width: 300px;
    border-right: 1px solid var(--border-color);
    background: var(--bg-panel-solid);
    display: flex;
    flex-direction: column;
}
.doc-sidebar-header {
    padding: 1rem;
    border-bottom: 1px solid var(--border-color);
}
.doc-tree {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
}
.tree-item {
    padding: 0.5rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
.tree-item:hover, .tree-item.active {
    background: rgba(255,255,255,0.05);
    color: var(--text-primary);
}
.doc-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg-base);
}
.doc-toolbar {
    padding: 1rem 2rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--bg-panel);
}
.doc-content {
    flex: 1;
    padding: 2rem;
    overflow-y: auto;
    max-width: 900px;
    margin: 0 auto;
    width: 100%;
}
.markdown-body {
    color: var(--text-primary);
}
.markdown-body h1, .markdown-body h2, .markdown-body h3 {
    margin-top: 1.5em;
    margin-bottom: 0.5em;
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 0.3em;
}
.markdown-body p { margin-bottom: 1em; }
.markdown-body pre {
    background: var(--bg-panel-solid);
    padding: 1rem;
    border-radius: var(--radius-md);
    overflow-x: auto;
    border: 1px solid var(--border-color);
}
.markdown-body code {
    font-family: monospace;
    background: rgba(255,255,255,0.1);
    padding: 0.2em 0.4em;
    border-radius: 3px;
}
.markdown-body pre code {
    background: none;
    padding: 0;
}

/* Activity Page Full View */
.activity-page-container {
    max-width: 1000px;
    margin: 2rem auto;
    padding: 0 2rem;
}
.activity-filters {
    display: flex;
    gap: 1rem;
    margin-bottom: 2rem;
    background: var(--bg-panel);
    padding: 1rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-color);
}

/* Utilities */
.text-danger { color: var(--status-red); }
.text-success { color: var(--status-green); }
.text-warning { color: var(--status-yellow); }

/* Responsive */
@media (max-width: 1200px) {
    .dashboard-grid > section:nth-child(1) { grid-column: span 6; }
    .dashboard-grid > section:nth-child(2) { grid-column: span 6; }
    .dashboard-grid > section:nth-child(3) { grid-column: span 12; }
    .dashboard-grid > section:nth-child(4) { grid-column: span 12; }
}
@media (max-width: 768px) {
    .dashboard-grid > section { grid-column: span 12 !important; }
    .header-controls { flex-direction: column; gap: 1rem; }
    .app-header { flex-direction: column; align-items: flex-start; gap: 1rem; }
    .doc-container { flex-direction: column; }
    .doc-sidebar { width: 100%; height: 200px; border-right: none; border-bottom: 1px solid var(--border-color); }
}
```

### File: `public/js/app.js`
```javascript
// Shared application logic

const API_BASE = '/api/v1';

const api = {
    async get(endpoint) {
        const res = await fetch(`${API_BASE}${endpoint}`);
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return res.json();
    },
    async post(endpoint, data) {
        const res = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return res.json();
    },
    async put(endpoint, data) {
        const res = await fetch(`${API_BASE}${endpoint}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return res.json();
    }
};

let currentEventSource = null;

function connectSSE(projectId, onMessage) {
    if (currentEventSource) {
        currentEventSource.close();
    }
    
    if (!projectId) return null;

    currentEventSource = new EventSource(`${API_BASE}/projects/${projectId}/events/stream`);
    
    currentEventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (onMessage) onMessage(data);
        } catch (e) {
            console.error('Error parsing SSE event', e);
        }
    };
    
    currentEventSource.onerror = (err) => {
        console.error('SSE Error', err);
        // Will auto-reconnect
    };
    
    return currentEventSource;
}

function formatTimeAgo(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);
    
    if (seconds < 60) return 'just now';
    
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    
    return date.toLocaleDateString();
}

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .toString()
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

function createBadge(text, type) {
    const validTypes = ['default', 'critical', 'high', 'medium', 'low', 'draft', 'review', 'approved', 'archived'];
    const cssClass = validTypes.includes(type) ? `badge-${type}` : 'badge-default';
    return `<span class="badge ${cssClass}">${escapeHtml(text)}</span>`;
}

// Global project selection state
let currentProjectId = localStorage.getItem('muster_current_project');

async function loadProjects() {
    const selector = document.getElementById('project-selector');
    if (!selector) return;

    try {
        const data = await api.get('/projects');
        selector.innerHTML = '';
        
        if (data.projects.length === 0) {
            selector.innerHTML = '<option value="">No projects found</option>';
            return;
        }

        data.projects.forEach(p => {
            const option = document.createElement('option');
            option.value = p.id;
            option.textContent = p.name;
            selector.appendChild(option);
        });

        // Select current or first
        if (currentProjectId && data.projects.some(p => p.id === currentProjectId)) {
            selector.value = currentProjectId;
        } else {
            currentProjectId = data.projects[0].id;
            selector.value = currentProjectId;
            localStorage.setItem('muster_current_project', currentProjectId);
        }

        // Trigger custom event for pages to react
        window.dispatchEvent(new CustomEvent('projectChanged', { detail: { projectId: currentProjectId } }));

        selector.addEventListener('change', (e) => {
            currentProjectId = e.target.value;
            localStorage.setItem('muster_current_project', currentProjectId);
            window.dispatchEvent(new CustomEvent('projectChanged', { detail: { projectId: currentProjectId } }));
        });

    } catch (err) {
        console.error("Failed to load projects", err);
        selector.innerHTML = '<option value="">Error loading projects</option>';
    }
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    loadProjects();
});
```

### File: `public/js/dashboard.js`
```javascript
// Dashboard functionality

const elements = {
    agentsList: document.getElementById('agents-list'),
    agentCount: document.getElementById('agent-count'),
    boardSelector: document.getElementById('board-selector'),
    boardSnapshot: document.getElementById('board-snapshot'),
    activityList: document.getElementById('activity-list'),
    documentsList: document.getElementById('documents-list')
};

window.addEventListener('projectChanged', async (e) => {
    const projectId = e.detail.projectId;
    if (!projectId) return;

    await loadDashboardData(projectId);
    setupSSE(projectId);
});

async function loadDashboardData(projectId) {
    try {
        // Fetch Agents
        const agentsData = await api.get(`/projects/${projectId}/agents`);
        renderAgents(agentsData.agents);

        // Fetch Boards list
        const boardsData = await api.get(`/projects/${projectId}/boards`);
        populateBoardSelector(boardsData.boards, projectId);

        // Fetch Activity
        const activityData = await api.get(`/projects/${projectId}/events`);
        renderActivity(activityData.events.slice(0, 20));

        // Fetch Documents
        const docsData = await api.get(`/projects/${projectId}/documents`);
        renderDocuments(docsData.documents);

    } catch (err) {
        console.error("Error loading dashboard data", err);
    }
}

function setupSSE(projectId) {
    connectSSE(projectId, (event) => {
        // Handle incoming real-time events
        if (event.type === 'agent_state_changed') {
            api.get(`/projects/${projectId}/agents`).then(data => renderAgents(data.agents));
        } else if (event.type === 'document_created' || event.type === 'document_updated') {
            api.get(`/projects/${projectId}/documents`).then(data => renderDocuments(data.documents));
        } else if (event.type.startsWith('card_') || event.type.startsWith('board_')) {
            const boardId = elements.boardSelector.value;
            if (boardId) loadBoardSnapshot(projectId, boardId);
        }
        
        // Always prepend to activity feed
        prependActivity(event);
    });
}

function renderAgents(agents) {
    elements.agentCount.textContent = agents.length;
    
    if (agents.length === 0) {
        elements.agentsList.innerHTML = '<div class="empty-state">No agents available</div>';
        return;
    }

    elements.agentsList.innerHTML = agents.map(agent => {
        let statusClass = 'status-offline';
        if (agent.state === 'idle') statusClass = 'status-online';
        if (agent.state === 'working') statusClass = 'status-busy';
        
        return `
            <div class="agent-item">
                <div class="agent-info">
                    <div class="agent-name">
                        <span class="status-dot ${statusClass}"></span>
                        ${escapeHtml(agent.name)}
                    </div>
                    <div class="agent-role">${escapeHtml(agent.role || 'General Agent')}</div>
                    ${agent.currentTaskId ? `<div class="agent-task">Task: ${escapeHtml(agent.currentTaskId)}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function populateBoardSelector(boards, projectId) {
    elements.boardSelector.innerHTML = '';
    if (boards.length === 0) {
        elements.boardSelector.innerHTML = '<option value="">No boards</option>';
        elements.boardSnapshot.innerHTML = '<div class="empty-state">Create a board to see snapshot</div>';
        return;
    }

    boards.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = b.name;
        elements.boardSelector.appendChild(opt);
    });

    loadBoardSnapshot(projectId, boards[0].id);

    elements.boardSelector.onchange = (e) => {
        loadBoardSnapshot(projectId, e.target.value);
    };
}

async function loadBoardSnapshot(projectId, boardId) {
    if (!boardId) return;
    try {
        const board = await api.get(`/projects/${projectId}/boards/${boardId}`);
        
        elements.boardSnapshot.innerHTML = `
            <div class="snapshot-columns">
                ${board.columns.map(col => `
                    <div class="snapshot-column">
                        <div class="snapshot-col-header">
                            <span>${escapeHtml(col.name)}</span>
                            <span class="badge badge-default">${col.cards.length}</span>
                        </div>
                        <div class="snapshot-cards">
                            ${col.cards.slice(0, 3).map(card => `
                                <div class="snapshot-mini-card">
                                    ${escapeHtml(card.title)}
                                </div>
                            `).join('')}
                            ${col.cards.length > 3 ? `<div style="font-size: 0.75rem; color: var(--text-muted); text-align: center;">+${col.cards.length - 3} more</div>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    } catch (err) {
        elements.boardSnapshot.innerHTML = '<div class="empty-state text-danger">Failed to load board</div>';
    }
}

function renderDocuments(documents) {
    if (documents.length === 0) {
        elements.documentsList.innerHTML = '<div class="empty-state">No documents found</div>';
        return;
    }

    elements.documentsList.innerHTML = documents.slice(0, 5).map(doc => `
        <div class="doc-item">
            <div>
                <div class="doc-title">
                    <a href="document.html?id=${doc.id}">${escapeHtml(doc.title)}</a>
                </div>
                <div class="doc-meta">
                    <span>v${doc.version}</span>
                    <span>${formatTimeAgo(doc.updatedAt)}</span>
                </div>
            </div>
            <div>
                ${createBadge(doc.status.replace('_', ' '), doc.status === 'in_review' ? 'review' : doc.status)}
            </div>
        </div>
    `).join('');
}

function renderActivity(events) {
    if (events.length === 0) {
        elements.activityList.innerHTML = '<div class="empty-state">No recent activity</div>';
        return;
    }
    
    elements.activityList.innerHTML = '';
    events.forEach(event => prependActivity(event, false));
}

function prependActivity(event, truncate = true) {
    // Remove empty state if present
    const empty = elements.activityList.querySelector('.empty-state');
    if (empty) empty.remove();

    const el = document.createElement('div');
    el.className = `activity-item ${event.source}`;
    
    let icon = '⚙️';
    if (event.source === 'user') icon = '👤';
    if (event.source === 'agent') icon = '🤖';
    
    let payloadHtml = '';
    if (event.payload) {
        payloadHtml = `<div class="activity-details">${escapeHtml(JSON.stringify(event.payload))}</div>`;
    }

    el.innerHTML = `
        <div class="activity-icon">${icon}</div>
        <div class="activity-content">
            <div class="activity-header">
                <span class="activity-author">${escapeHtml(event.source)}</span>
                <span class="activity-time">${formatTimeAgo(event.timestamp)}</span>
            </div>
            <div class="activity-message">
                <strong>${escapeHtml(event.type)}</strong>
            </div>
            ${payloadHtml}
        </div>
    `;

    elements.activityList.insertBefore(el, elements.activityList.firstChild);

    if (truncate) {
        const items = elements.activityList.querySelectorAll('.activity-item');
        if (items.length > 20) {
            items[items.length - 1].remove();
        }
    }
}
```

### File: `public/board.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Boards - Muster</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header class="app-header">
        <div class="header-brand">
            <h1>Muster</h1>
        </div>
        <div class="header-controls">
            <select id="project-selector" class="select-input"></select>
            <nav class="main-nav">
                <a href="index.html" class="nav-link">Dashboard</a>
                <a href="board.html" class="nav-link active">Boards</a>
                <a href="document.html" class="nav-link">Documents</a>
                <a href="activity.html" class="nav-link">Activity</a>
            </nav>
        </div>
    </header>

    <div style="padding: 1rem 2rem; border-bottom: 1px solid var(--border-color); background: var(--bg-panel-solid); display: flex; gap: 1rem; align-items: center;">
        <select id="board-select" class="select-input"></select>
        <button id="btn-new-card" class="btn btn-sm">New Card</button>
    </div>

    <div class="board-container" id="board-container">
        <!-- Columns will be rendered here -->
        <div class="loading-spinner" style="width: 100%;">Loading board...</div>
    </div>

    <script src="js/app.js"></script>
    <script src="js/board.js"></script>
</body>
</html>
```

### File: `public/js/board.js`
```javascript
// Board drag and drop and rendering logic

const elements = {
    boardSelect: document.getElementById('board-select'),
    boardContainer: document.getElementById('board-container'),
    btnNewCard: document.getElementById('btn-new-card')
};

let currentBoardId = new URLSearchParams(window.location.search).get('id');
let currentBoardData = null;

window.addEventListener('projectChanged', async (e) => {
    const projectId = e.detail.projectId;
    if (!projectId) return;

    await loadBoards(projectId);
    setupSSE(projectId);
});

async function loadBoards(projectId) {
    try {
        const data = await api.get(`/projects/${projectId}/boards`);
        const boards = data.boards;
        
        elements.boardSelect.innerHTML = '';
        if (boards.length === 0) {
            elements.boardContainer.innerHTML = '<div class="empty-state" style="width:100%">No boards in this project.</div>';
            return;
        }

        boards.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.id;
            opt.textContent = b.name;
            elements.boardSelect.appendChild(opt);
        });

        if (currentBoardId && boards.some(b => b.id === currentBoardId)) {
            elements.boardSelect.value = currentBoardId;
        } else {
            currentBoardId = boards[0].id;
        }

        elements.boardSelect.onchange = (e) => {
            currentBoardId = e.target.value;
            // Update URL
            window.history.replaceState({}, '', `?id=${currentBoardId}`);
            renderBoard(projectId, currentBoardId);
        };

        renderBoard(projectId, currentBoardId);

    } catch (err) {
        console.error(err);
        elements.boardContainer.innerHTML = '<div class="empty-state text-danger" style="width:100%">Error loading boards.</div>';
    }
}

async function renderBoard(projectId, boardId) {
    try {
        const board = await api.get(`/projects/${projectId}/boards/${boardId}`);
        currentBoardData = board;
        
        elements.boardContainer.innerHTML = board.columns.map(col => {
            const isExceeded = col.wipLimit && col.cards.length > col.wipLimit;
            return `
                <div class="board-column" data-col-id="${col.id}">
                    <div class="board-col-header">
                        <span class="board-col-title">${escapeHtml(col.name)}</span>
                        <span class="wip-limit ${isExceeded ? 'exceeded' : ''}">
                            ${col.cards.length} ${col.wipLimit ? `/ ${col.wipLimit}` : ''}
                        </span>
                    </div>
                    <div class="board-cards" data-col-id="${col.id}">
                        ${col.cards.map(card => `
                            <div class="kanban-card" draggable="true" data-card-id="${card.id}">
                                <div class="card-title">${escapeHtml(card.title)}</div>
                                <div>${createBadge(card.priority, card.priority)}</div>
                                <div class="card-meta">
                                    <span class="badge badge-default">${escapeHtml(card.status)}</span>
                                    ${card.assignedTo ? `<div class="avatar-sm" title="${escapeHtml(card.assignedTo)}">${card.assignedTo.charAt(0).toUpperCase()}</div>` : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }).join('');

        setupDragAndDrop(projectId, boardId);

    } catch (err) {
        console.error(err);
    }
}

function setupDragAndDrop(projectId, boardId) {
    const cards = document.querySelectorAll('.kanban-card');
    const containers = document.querySelectorAll('.board-cards');

    cards.forEach(card => {
        card.addEventListener('dragstart', () => {
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
        });
    });

    containers.forEach(container => {
        container.addEventListener('dragover', e => {
            e.preventDefault();
            const afterElement = getDragAfterElement(container, e.clientY);
            const draggable = document.querySelector('.dragging');
            if (afterElement == null) {
                container.appendChild(draggable);
            } else {
                container.insertBefore(draggable, afterElement);
            }
        });

        container.addEventListener('drop', async e => {
            e.preventDefault();
            const draggable = document.querySelector('.dragging');
            if (!draggable) return;
            
            const cardId = draggable.dataset.cardId;
            const toColId = container.dataset.colId;
            
            // Find current col id
            let fromColId;
            for(const col of currentBoardData.columns) {
                if(col.cards.find(c => c.id === cardId)) fromColId = col.id;
            }

            if (fromColId !== toColId) {
                // Call API
                try {
                    await api.post(`/projects/${projectId}/boards/${boardId}/move_card`, {
                        cardId: cardId,
                        fromColumnId: fromColId,
                        toColumnId: toColId
                    });
                    // Re-fetch to get consistent state
                    renderBoard(projectId, boardId);
                } catch(err) {
                    console.error("Move failed", err);
                    renderBoard(projectId, boardId); // revert
                }
            }
        });
    });
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.kanban-card:not(.dragging)')];

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function setupSSE(projectId) {
    connectSSE(projectId, (event) => {
        if (event.type.startsWith('card_') || event.type.startsWith('board_')) {
            if (currentBoardId) {
                renderBoard(projectId, currentBoardId);
            }
        }
    });
}

elements.btnNewCard.addEventListener('click', () => {
    alert("New Card modal would open here.");
});
```

### File: `public/document.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Documents - Muster</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header class="app-header">
        <div class="header-brand">
            <h1>Muster</h1>
        </div>
        <div class="header-controls">
            <select id="project-selector" class="select-input"></select>
            <nav class="main-nav">
                <a href="index.html" class="nav-link">Dashboard</a>
                <a href="board.html" class="nav-link">Boards</a>
                <a href="document.html" class="nav-link active">Documents</a>
                <a href="activity.html" class="nav-link">Activity</a>
            </nav>
        </div>
    </header>

    <div class="doc-container">
        <div class="doc-sidebar">
            <div class="doc-sidebar-header">
                <h3>Project Documents</h3>
            </div>
            <div class="doc-tree" id="doc-tree">
                <div class="loading-spinner">Loading...</div>
            </div>
        </div>
        <div class="doc-main">
            <div class="doc-toolbar">
                <h2 id="doc-title">Select a document</h2>
                <div id="doc-meta"></div>
            </div>
            <div class="doc-content markdown-body" id="doc-content">
                <div class="empty-state">Select a document from the sidebar to view its contents.</div>
            </div>
        </div>
    </div>

    <!-- Basic markdown parser for preview -->
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script src="js/app.js"></script>
    <script src="js/document.js"></script>
</body>
</html>
```

### File: `public/js/document.js`
```javascript
const elements = {
    docTree: document.getElementById('doc-tree'),
    docTitle: document.getElementById('doc-title'),
    docMeta: document.getElementById('doc-meta'),
    docContent: document.getElementById('doc-content')
};

let urlDocId = new URLSearchParams(window.location.search).get('id');

window.addEventListener('projectChanged', async (e) => {
    const projectId = e.detail.projectId;
    if (!projectId) return;

    await loadDocuments(projectId);
});

async function loadDocuments(projectId) {
    try {
        const data = await api.get(`/projects/${projectId}/documents`);
        const docs = data.documents;
        
        elements.docTree.innerHTML = '';
        
        if (docs.length === 0) {
            elements.docTree.innerHTML = '<div class="empty-state">No documents</div>';
            return;
        }

        docs.forEach(doc => {
            const item = document.createElement('div');
            item.className = `tree-item ${doc.id === urlDocId ? 'active' : ''}`;
            item.innerHTML = `📄 ${escapeHtml(doc.title)}`;
            item.onclick = () => {
                document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                window.history.replaceState({}, '', `?id=${doc.id}`);
                loadDocumentContent(projectId, doc.id);
            };
            elements.docTree.appendChild(item);
        });

        // Load specific or first
        if (urlDocId && docs.some(d => d.id === urlDocId)) {
            loadDocumentContent(projectId, urlDocId);
        } else if (docs.length > 0) {
            loadDocumentContent(projectId, docs[0].id);
            elements.docTree.firstChild.classList.add('active');
        }

    } catch (err) {
        console.error(err);
        elements.docTree.innerHTML = '<div class="text-danger">Error loading docs</div>';
    }
}

async function loadDocumentContent(projectId, docId) {
    try {
        elements.docContent.innerHTML = '<div class="loading-spinner">Loading content...</div>';
        const doc = await api.get(`/projects/${projectId}/documents/${docId}`);
        
        elements.docTitle.textContent = doc.title;
        elements.docMeta.innerHTML = `
            ${createBadge(doc.status.replace('_', ' '), doc.status === 'in_review' ? 'review' : doc.status)}
            <span style="margin-left: 1rem; color: var(--text-muted); font-size: 0.8rem;">Version ${doc.version}</span>
        `;
        
        // Use marked.js if available, else plain text fallback
        if (window.marked) {
            elements.docContent.innerHTML = marked.parse(doc.content);
        } else {
            elements.docContent.innerHTML = `<pre>${escapeHtml(doc.content)}</pre>`;
        }
    } catch (err) {
        elements.docContent.innerHTML = '<div class="empty-state text-danger">Failed to load document content.</div>';
    }
}
```

### File: `public/activity.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Activity - Muster</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header class="app-header">
        <div class="header-brand">
            <h1>Muster</h1>
        </div>
        <div class="header-controls">
            <select id="project-selector" class="select-input"></select>
            <nav class="main-nav">
                <a href="index.html" class="nav-link">Dashboard</a>
                <a href="board.html" class="nav-link">Boards</a>
                <a href="document.html" class="nav-link">Documents</a>
                <a href="activity.html" class="nav-link active">Activity</a>
            </nav>
        </div>
    </header>

    <div class="activity-page-container">
        <div class="panel-header" style="background: none; padding: 0 0 1rem 0; border:none;">
            <h2>Project Activity Feed</h2>
            <div class="live-indicator"><span class="pulse-dot"></span> Live Updates</div>
        </div>
        
        <div class="activity-filters">
            <select class="select-input" id="filter-source">
                <option value="all">All Sources</option>
                <option value="system">System</option>
                <option value="agent">Agents</option>
                <option value="user">Users</option>
            </select>
        </div>

        <div class="activity-feed" id="full-activity-list">
            <div class="loading-spinner">Loading activity...</div>
        </div>
    </div>

    <script src="js/app.js"></script>
    <script src="js/activity.js"></script>
</body>
</html>
```

### File: `public/js/activity.js`
```javascript
const elements = {
    activityList: document.getElementById('full-activity-list'),
    filterSource: document.getElementById('filter-source')
};

let allEvents = [];

window.addEventListener('projectChanged', async (e) => {
    const projectId = e.detail.projectId;
    if (!projectId) return;

    await loadActivity(projectId);
    setupSSE(projectId);
});

async function loadActivity(projectId) {
    try {
        const data = await api.get(`/projects/${projectId}/events`);
        allEvents = data.events;
        renderEvents();
    } catch (err) {
        elements.activityList.innerHTML = '<div class="empty-state text-danger">Failed to load events.</div>';
    }
}

function setupSSE(projectId) {
    connectSSE(projectId, (event) => {
        allEvents.unshift(event);
        renderEvents(); // Re-render with new filter applied if any
    });
}

function renderEvents() {
    const sourceFilter = elements.filterSource.value;
    
    let filtered = allEvents;
    if (sourceFilter !== 'all') {
        filtered = allEvents.filter(e => e.source === sourceFilter);
    }

    if (filtered.length === 0) {
        elements.activityList.innerHTML = '<div class="empty-state">No activity found.</div>';
        return;
    }

    elements.activityList.innerHTML = filtered.map(event => {
        let icon = '⚙️';
        if (event.source === 'user') icon = '👤';
        if (event.source === 'agent') icon = '🤖';
        
        let payloadHtml = '';
        if (event.payload) {
            payloadHtml = `<div class="activity-details">${escapeHtml(JSON.stringify(event.payload, null, 2))}</div>`;
        }

        return `
            <div class="activity-item ${event.source}">
                <div class="activity-icon">${icon}</div>
                <div class="activity-content">
                    <div class="activity-header">
                        <span class="activity-author">${escapeHtml(event.source)}</span>
                        <span class="activity-time">${new Date(event.timestamp).toLocaleString()}</span>
                    </div>
                    <div class="activity-message">
                        <strong>${escapeHtml(event.type)}</strong>
                    </div>
                    ${payloadHtml}
                </div>
            </div>
        `;
    }).join('');
}

elements.filterSource.addEventListener('change', renderEvents);
```

## 12. Build & Run Instructions

To build and run the Muster locally:

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Build the project:**
   Compiles TypeScript into the `dist/` directory.
   ```bash
   npm run build
   ```

3. **Start in dev mode:**
   Runs the server using `ts-node` or `tsx` for rapid development (make sure your `package.json` scripts are set up for this, e.g., `"dev": "tsx src/index.ts --port 6878"`).
   ```bash
   npm run dev
   ```

4. **Start with MCP stdio:**
   To expose the platform tools to an LLM host (like Claude Desktop) using standard I/O:
   ```bash
   node dist/index.js --stdio
   ```

5. **Run tests:**
   Executes the Jest test suite.
   ```bash
   npm test
   ```

## 13. Verification Checklist

Follow these steps to verify the implementation works correctly:

1. [ ] `npm run build` succeeds without any TypeScript compilation errors.
2. [ ] `npm run dev` starts the Express server successfully (usually on port 6878).
3. [ ] Opening `http://localhost:6878` in a browser shows the dashboard with the dark theme styling.
4. [ ] Creating a project via `POST /api/v1/projects` (using curl or Postman) updates the project selector in the UI.
5. [ ] Creating a board within that project creates the default columns ("To Do", "In Progress", "Review", "Done").
6. [ ] Navigating to the Boards page shows the created board; cards can be moved between columns using drag-and-drop.
7. [ ] Documents can be created, and their markdown content renders correctly on the Documents page.
8. [ ] Running `node dist/index.js --stdio` and attaching the MCP Inspector confirms that the MCP tools (`create_project`, `create_card`, etc.) are registered and callable.
9. [ ] Making changes via the API triggers SSE events, which immediately update the Activity Feed and corresponding UI panels without a page reload.
