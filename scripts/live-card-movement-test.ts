// File: scripts/live-card-movement-test.ts
import { createDatabaseAdapter } from '../src/db/factory.js';
import { createApplicationServices } from '../src/application/composition.js';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('===========================================================');
  console.log('   STARTING LIVE KANBAN CARD MOVEMENT TEST (3s Interval)');
  console.log('===========================================================\n');

  const db = createDatabaseAdapter();
  const {
    projectService,
    boardService,
    columnService,
    cardService,
    commentService,
    agentService,
  } = createApplicationServices(db);

  // 1. Get Active Project
  const projects = await projectService.list();
  const project = projects[0];
  if (!project) {
    throw new Error('No projects found');
  }

  console.log(`[Target Project] ID: ${project.id}, Name: "${project.name}"`);

  // 2. Get Agent
  const agents = await agentService.list(project.id);
  const agent = agents[0];

  // 3. Get Board Columns
  const boards = await boardService.list(project.id);
  const board = boards[0];
  const columns = await columnService.list(board.id);

  console.log(`[Board Columns] ${columns.map((c) => `"${c.name}"`).join(' → ')}\n`);

  // 4. Create Card in first column (Backlog)
  const backlogCol = columns[0];
  const card = await cardService.create({
    column_id: backlogCol.id,
    title: '🚀 Live Real-Time Movement Test Card',
    description: 'Demonstrating automated real-time card transitions across all board columns at 3-second intervals.',
    priority: 'critical',
    assignees: agent ? [agent.id] : [],
  });

  console.log(`[Step 1/5] Card Created in column "${backlogCol.name}"! (ID: ${card.id})`);
  if (agent) {
    await commentService.create({
      card_id: card.id,
      author_id: agent.id,
      content: `Card created in "${backlogCol.name}". Starting automated movement test...`,
    });
  }

  // 5. Move through remaining columns with 3s delays
  for (let i = 1; i < columns.length; i++) {
    console.log(`\n⏳ Waiting 3 seconds before next move...`);
    await sleep(3000);

    const nextCol = columns[i];
    await cardService.move(card.id, { target_column_id: nextCol.id });

    if (agent) {
      await commentService.create({
        card_id: card.id,
        author_id: agent.id,
        content: `Moved card to column "${nextCol.name}".`,
      });
    }

    console.log(`[Step ${i + 1}/${columns.length}] Moved card to column "${nextCol.name}"!`);
  }

  await db.close();
  console.log('\n===========================================================');
  console.log('   🎉 LIVE MOVEMENT TEST COMPLETE! All columns traversed.');
  console.log('===========================================================\n');
}

main().catch(console.error);
