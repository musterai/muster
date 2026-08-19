// File: scripts/cleanup-test-projects.ts
import { createDatabaseAdapter } from '../src/db/factory.js';
import { createApplicationServices } from '../src/application/composition.js';

async function cleanup() {
  console.log('===========================================================');
  console.log('   CLEANING UP TEST PROJECTS FROM Muster DATABASE');
  console.log('===========================================================\n');

  const db = createDatabaseAdapter();
  const { projectService } = createApplicationServices(db);

  const projects = await projectService.list();
  console.log(`Found ${projects.length} total projects in database.`);

  let deletedCount = 0;
  for (const project of projects) {
    if (
      project.name.includes('E2E Browser Verification Project') ||
      project.name.includes('Test Project') ||
      project.name.startsWith('Test')
    ) {
      await projectService.delete(project.id);
      console.log(`  ✓ Deleted test project: "${project.name}" (${project.id})`);
      deletedCount++;
    }
  }

  await db.close();
  console.log(`\n🎉 Successfully deleted ${deletedCount} test project(s). Database clean!`);
}

cleanup().catch(console.error);
