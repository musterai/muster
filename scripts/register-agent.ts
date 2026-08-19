// File: scripts/register-agent.ts
import { createDatabaseAdapter } from '../src/db/factory.js';
import { createApplicationServices } from '../src/application/composition.js';

async function main() {
  const db = createDatabaseAdapter();
  const { projectService: ps, agentService: as } = createApplicationServices(db);

  const projects = await ps.list();
  if (projects.length === 0) {
    console.log('No projects found.');
    await db.close();
    return;
  }

  for (const project of projects) {
    const agent = await as.register({
      project_id: project.id,
      name: 'Antigravity',
      type: 'ai_agent',
      role: 'contributor',
      capabilities: ['code', 'review', 'refactor', 'testing', 'architecture'],
      status: 'active',
    });
    console.log(`Registered agent Antigravity (ID: ${agent.id}) for project "${project.name}" (ID: ${project.id})`);
  }

  await db.close();
}

main().catch(console.error);
