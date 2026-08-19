// File: scripts/setup-alpha-release-tasks.ts
import { createDatabaseAdapter } from '../src/db/factory.js';
import { createApplicationServices } from '../src/application/composition.js';

async function main() {
  const db = createDatabaseAdapter();
  const {
    projectService,
    boardService,
    documentService,
    columnService,
    cardService,
    agentService,
  } = createApplicationServices(db);

  // 1. Create or Find Release Project
  let project = (await projectService.list()).find(p => p.name.includes('v2.0-alpha'));
  if (!project) {
    project = await projectService.create({
      name: 'Muster (v2.0-alpha)',
      description: 'Open-Source v2.0-alpha Release Roadmap & Production Polish',
    });
  }

  console.log(`[Project] ID: ${project.id}, Name: "${project.name}"`);

  // 2. Register Lead Agent
  let agent = (await agentService.list(project.id)).find(a => a.name.includes('Antigravity'));
  if (!agent) {
    agent = await agentService.register({
      project_id: project.id,
      name: 'Antigravity (Lead AI Architect)',
      type: 'ai_agent',
      role: 'owner',
      capabilities: ['architecture', 'docker', 'ci-cd', 'docs', 'testing'],
      status: 'active',
    });
  }
  console.log(`[Agent] ID: ${agent.id}, Name: "${agent.name}"`);

  // 3. Create Design Specification Document
  const doc = await documentService.create({
    project_id: project.id,
    title: 'v2.0-alpha Open-Source Release Specification & Roadmap',
    content: `# Muster v2.0-alpha Open-Source Release Roadmap

## Overview
This specification details the required components and polish steps for releasing Muster v2.0 as a robust, open-source collaborative agent platform.

## Release Tasks
1. **Health Telemetry Endpoint (\`/api/v1/health\`)**: Expose system uptime, DB connection state, and active project/agent counts.
2. **Containerization (\`Dockerfile\` & \`docker-compose.yml\`)**: Multi-stage build for Node 22+, SQLite WAL data volume persistence, and environment variable configuration.
3. **Open-Source Documentation (\`README.md\`, \`LICENSE\`, \`CONTRIBUTING.md\`)**: Clear quickstart guide for MCP configuration (Cursor, AGY, Claude Desktop).
4. **Seed Utility (\`npm run seed\`)**: Single-command data populator for instant user evaluation.
5. **GitHub Actions CI/CD (\`.github/workflows/ci.yml\`)**: Automated testing, linting, and build verification on push.`,
    author_id: agent.id,
  });
  console.log(`[Document] ID: ${doc.id}, Title: "${doc.title}"`);

  // 4. Get Board & Columns
  const boards = await boardService.list(project.id);
  const board = boards[0];
  const columns = await columnService.list(board.id);
  const backlogCol = columns.find(c => c.name === 'Backlog') || columns[0];
  const inProgressCol = columns.find(c => c.name === 'In Progress') || columns[2];

  // 5. Create Cards for Each Release Task
  const tasks = [
    {
      title: 'Implement /api/v1/health System Telemetry Endpoint',
      description: 'Create health check endpoint returning uptime, database status, and platform telemetry.',
      priority: 'critical' as const,
      colId: inProgressCol.id,
    },
    {
      title: 'Create Production Dockerfile & docker-compose.yml Setup',
      description: 'Multi-stage Dockerfile and docker-compose configuration with WAL volume mounting.',
      priority: 'high' as const,
      colId: inProgressCol.id,
    },
    {
      title: 'Author Comprehensive Open-Source README.md & Quickstart',
      description: 'Complete project documentation with MCP configuration snippets for AGY, Cursor, and Claude Desktop.',
      priority: 'high' as const,
      colId: inProgressCol.id,
    },
    {
      title: 'Create Standalone Seed Script (npm run seed)',
      description: 'Add seed script to quickly populate demo projects, boards, cards, and design docs.',
      priority: 'medium' as const,
      colId: backlogCol.id,
    },
    {
      title: 'Add GitHub Actions CI/CD Pipeline (.github/workflows/ci.yml)',
      description: 'Configure automated build and Vitest execution workflow on GitHub.',
      priority: 'medium' as const,
      colId: backlogCol.id,
    },
  ];

  for (const t of tasks) {
    const card = await cardService.create({
      column_id: t.colId,
      title: t.title,
      description: t.description,
      priority: t.priority,
      assignees: [agent.id],
    });
    console.log(`[Card Created] ID: ${card.id}, Title: "${card.title}"`);
  }

  await db.close();
  console.log('\n✓ Release roadmap project initialized in Muster system successfully!');
}

main().catch(console.error);
