// File: scripts/seed.ts
import { createDatabaseAdapter } from '../src/db/factory.js';
import { Migrator } from '../src/db/migrator.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplicationServices } from '../src/application/composition.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function seed() {
  console.log('===========================================================');
  console.log('   SEEDING MUSTER DEMO DATA');
  console.log('===========================================================\n');

  const db = createDatabaseAdapter();
  const migrator = new Migrator(db, path.join(__dirname, '../src/db/migrations'));
  await migrator.run();

  const {
    projectService,
    boardService,
    columnService,
    cardService,
    commentService,
    agentService,
  } = createApplicationServices(db);

  // 1. Create Demo Project
  const project = await projectService.create({
    name: 'Autonomous Multi-Agent Systems Platform',
    description: 'Demonstration project showcasing AI agent collaboration, design docs, and Kanban tracking.',
  });
  console.log(`✓ Project Created: ${project.name} (${project.id})`);

  // 2. Register Agents
  const agent1 = await agentService.register({
    project_id: project.id,
    name: 'Claude-Architect',
    type: 'ai_agent',
    role: 'owner',
    capabilities: ['architecture', 'typescript', 'system-design'],
    status: 'active',
  });

  const agent2 = await agentService.register({
    project_id: project.id,
    name: 'Gemini-Frontend',
    type: 'ai_agent',
    role: 'contributor',
    capabilities: ['react', 'tailwind', 'ui-ux', 'a11y'],
    status: 'active',
  });

  const human = await agentService.register({
    project_id: project.id,
    name: 'Erik (Lead Operator)',
    type: 'human',
    role: 'owner',
    capabilities: ['product-management', 'review'],
    status: 'active',
  });

  console.log(`✓ Agents Registered: ${agent1.name}, ${agent2.name}, ${human.name}`);

  // 3. Get Default Board & Columns
  const boards = await boardService.list(project.id);
  const board = boards[0];
  const columns = await columnService.list(board.id);

  const backlog = columns.find(c => c.name === 'Backlog') || columns[0];
  const inProgress = columns.find(c => c.name === 'In Progress') || columns[2];
  const done = columns.find(c => c.name === 'Done') || columns[4];

  // 4. Create Demo Cards
  const c1 = await cardService.create({
    column_id: inProgress.id,
    title: 'Implement Streamable HTTP MCP Endpoint',
    description: 'Connect McpServer to Express HTTP transport for remote JSON-RPC execution.',
    priority: 'critical',
    assignees: [agent1.id],
  });

  const c2 = await cardService.create({
    column_id: inProgress.id,
    title: 'Build Dark Zinc High-Density React 19 UI',
    description: 'Construct full-width Linear-inspired Kanban board, agent grid, and spec vault.',
    priority: 'high',
    assignees: [agent2.id],
  });

  const c3 = await cardService.create({
    column_id: done.id,
    title: 'Upgrade SQLite Engine to better-sqlite3 WAL Mode',
    description: 'Replace WASM driver with native better-sqlite3 for Node 26 compatibility.',
    priority: 'critical',
    assignees: [agent1.id, human.id],
  });

  console.log('✓ Cards Created & Assigned to Agents');

  // 5. Add Comments
  await commentService.create({
    card_id: c1.id,
    author_id: agent1.id,
    content: 'MCP Streamable HTTP transport configured. Exposed 33 tools on /mcp endpoint.',
  });

  await commentService.create({
    card_id: c2.id,
    author_id: agent2.id,
    content: 'React 19 SPA built and compiled into public/ with 0 TypeScript errors.',
  });

  console.log('✓ Task Progress Comments Logged');

  // 6. Create Design Document
  const doc = await documentService.create({
    project_id: project.id,
    title: 'System Architecture Specification (v2.0)',
    content: `# Muster — Architecture

## Overview
Muster provides a unified collaboration layer for autonomous AI agents and human operators.

### Core Stack
- **Backend**: Express + Node.js 22+
- **Database**: SQLite 3 (better-sqlite3 WAL mode)
- **Frontend**: React 19 + Tailwind CSS + Lucide Icons
- **Agent Interface**: Model Context Protocol (MCP) Streamable HTTP Transport`,
    author_id: agent1.id,
  });

  await documentService.setStatus(doc.id, { status: 'in_review', expected_version: doc.version });
  await documentService.setStatus(doc.id, { status: 'approved', expected_version: doc.version });
  console.log('✓ Approved Design Specification Created');

  await db.close();
  console.log('\n===========================================================');
  console.log('   🎉 DEMO DATA SEEDED SUCCESSFULLY!');
  console.log('===========================================================\n');
}

seed().catch(console.error);
