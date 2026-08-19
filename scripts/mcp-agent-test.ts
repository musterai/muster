// File: scripts/mcp-agent-test.ts
import { fork, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let TEST_PORT = 3198;
const TEST_DB_PATH = path.join(process.cwd(), 'data', `e2e-mcp-${Date.now()}.db`);
let APP_URL = `http://127.0.0.1:${TEST_PORT}`;
let MCP_ENDPOINT = `${APP_URL}/mcp`;
let requestId = 1;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeDbFiles(dbPath: string) {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  }
}

async function callMCPTool(toolName: string, args: Record<string, any> = {}) {
  const payload = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MCP HTTP call failed (${res.status}): ${errText}`);
  }

  const responseText = await res.text();
  const lines = responseText.split('\n');
  const dataLine = lines.find((l) => l.startsWith('data: '));
  const rawJson = dataLine ? dataLine.replace(/^data:\s*/, '') : responseText;

  const jsonResponse = JSON.parse(rawJson);
  if (jsonResponse.error) {
    throw new Error(`MCP tool error [${jsonResponse.error.code}]: ${jsonResponse.error.message}`);
  }

  const content = jsonResponse.result?.content?.[0]?.text;
  if (!content) {
    throw new Error(`Invalid MCP response payload: ${JSON.stringify(jsonResponse)}`);
  }

  return JSON.parse(content);
}

async function callMCPToolExpectValidationError(toolName: string, args: Record<string, any>) {
  const payload = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };
  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`MCP HTTP validation probe failed (${res.status}): ${await res.text()}`);

  const responseText = await res.text();
  const dataLine = responseText.split('\n').find((line) => line.startsWith('data: '));
  const jsonResponse = JSON.parse(dataLine ? dataLine.replace(/^data:\s*/, '') : responseText);
  const message = jsonResponse.error?.message || jsonResponse.result?.content?.[0]?.text;
  if (!message || !/input validation error|invalid arguments/i.test(message)) {
    throw new Error(`Expected MCP validation refusal, got: ${JSON.stringify(jsonResponse)}`);
  }
  return message;
}


async function runMcpAgentTestSuite() {
  console.log('===========================================================');
  console.log('   STARTING MCP E2E TEST SUITE (Isolated Temp DB Mode)');
  console.log('   Target Port Base: ' + TEST_PORT);
  console.log('   Test DB File: ' + TEST_DB_PATH);
  console.log('===========================================================\n');

  removeDbFiles(TEST_DB_PATH);

  // 1. Spawn Isolated Test Server
  console.log(`[Server Setup] Starting isolated Muster server process on port ${TEST_PORT}...`);
  const serverProcess: ChildProcess = fork(path.join(process.cwd(), 'dist', 'index.js'), [], {
    env: {
      ...process.env,
      MUSTER_PORT: String(TEST_PORT),
      MUSTER_HOST: '127.0.0.1',
      MUSTER_DB_PATH: TEST_DB_PATH,
    },
    stdio: 'pipe',
  });

  let activePort = TEST_PORT;
  serverProcess.stdout?.on('data', (data) => {
    const str = data.toString();
    process.stdout.write(str);
    const match = str.match(/REST API:\s*http:\/\/[^:]+:(\d+)/);
    if (match) {
      activePort = parseInt(match[1], 10);
      APP_URL = `http://127.0.0.1:${activePort}`;
      MCP_ENDPOINT = `${APP_URL}/mcp`;
    }
  });

  serverProcess.stderr?.on('data', (data) => process.stderr.write(data));

  try {
    // Wait for server health endpoint
    console.log('[Server Setup] Waiting for health endpoint readiness...');
    let healthy = false;
    const start = Date.now();
    while (Date.now() - start < 15000) {
      try {
        const res = await fetch(`http://127.0.0.1:${activePort}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {}
      await sleep(300);
    }
    if (!healthy) throw new Error(`Server failed to start on port ${activePort}`);

    console.log(`  ✓ Test server online and healthy at port ${activePort}!\n`);


    // Step 1: Create Project
    console.log('[1/12] Creating Project via MCP (create_project)...');
    const project = await callMCPTool('create_project', {
      name: 'Autonomous MCP Test Project',
      description: 'Project created via external agent MCP protocol test',
    });
    console.log(`  ✓ Project Created! ID: ${project.id}, Name: "${project.name}"`);

    // Step 2: Register Agent
    console.log('\n[2/12] Registering AI Agent via MCP (register_agent)...');
    const agent = await callMCPTool('register_agent', {
      name: 'External-Test-Agent-01',
      capabilities: ['code', 'test', 'mcp'],
      status: 'active',
    });
    console.log(`  ✓ Agent Registered! ID: ${agent.id}, Status: ${agent.status}`);

    // Step 3: Agent Heartbeat
    console.log('\n[3/12] Sending Agent Heartbeat via MCP (heartbeat)...');
    const heartbeatRes = await callMCPTool('heartbeat', { agent_id: agent.id });
    console.log(`  ✓ Heartbeat Ack: ID ${heartbeatRes.id}, Status: ${heartbeatRes.status}`);

    // Step 4: List Boards & Default Columns
    console.log('\n[4/12] Listing Project Boards & Columns via MCP (list_boards & get_board)...');
    const boards = await callMCPTool('list_boards', { project_id: project.id });
    console.log(`  ✓ Found ${boards.length} board(s). Board Name: "${boards[0].name}"`);

    const boardDetails = await callMCPTool('get_board', { board_id: boards[0].id });
    console.log(`  ✓ Board Details Loaded! Columns: ${boardDetails.columns.map((c: any) => c.name).join(', ')}`);

    // Multiple boards must be independently addressable over MCP, matching
    // the REST-backed UI board selector.
    const releaseBoard = await callMCPTool('create_board', {
      project_id: project.id,
      name: 'Release Board',
      template: 'simple',
    });
    const boardsAfterCreate = await callMCPTool('list_boards', { project_id: project.id });
    if (!boardsAfterCreate.some((candidate: any) => candidate.id === releaseBoard.id)) {
      throw new Error('MCP list_boards did not return the newly created board');
    }

    const releaseBoardDetails = await callMCPTool('get_board', { board_id: releaseBoard.id });
    const releaseColumns = releaseBoardDetails.columns.map((column: any) => column.name);
    if (
      releaseBoardDetails.id !== releaseBoard.id
      || releaseColumns.join(',') !== 'To Do,In Progress,Done'
    ) {
      throw new Error(`MCP get_board returned incorrect board details: ${releaseColumns.join(', ')}`);
    }
    console.log('  ✓ Second board created, listed, and loaded independently via MCP.');

    const backlogCol = boardDetails.columns.find((c: any) => c.name === 'Backlog');
    const inProgressCol = boardDetails.columns.find((c: any) => c.name === 'In Progress');

    // Step 5: Create Custom Column
    console.log('\n[5/12] Creating Custom Column via MCP (create_column)...');
    const customCol = await callMCPTool('create_column', {
      board_id: boards[0].id,
      name: 'Staging Verification',
      wip_limit: 3,
    });
    console.log(`  ✓ Custom Column Created! ID: ${customCol.id}, Name: "${customCol.name}", WIP Limit: ${customCol.wip_limit}`);

    // Step 6: Create Card
    console.log('\n[6/12] Creating Kanban Card via MCP (create_card)...');
    const card = await callMCPTool('create_card', {
      column_id: backlogCol.id,
      title: 'Verify MCP Streamable HTTP Protocol',
      description: 'Implement end-to-end integration test suite using standard MCP JSON-RPC 2.0 protocol over HTTP.',
      priority: 'high',
      assignees: [agent.id],
    });
    console.log(`  ✓ Card Created! ID: ${card.id}, Title: "${card.title}"`);
    await callMCPToolExpectValidationError('create_card', {
      column_id: 'bad!',
      title: 'x'.repeat(201),
      due_date: 'not-an-iso-date',
      unexpected_attacker_key: true,
    });
    const unknownKeyCanary = 'unknown_mcp_canary_opaque';
    const unknownKeyError = await callMCPToolExpectValidationError('create_card', {
      column_id: boardDetails.columns[0].id,
      title: 'MCP unknown-key redaction probe',
      [unknownKeyCanary]: true,
    });
    if (unknownKeyError.includes(unknownKeyCanary)) {
      throw new Error('MCP validation error reflected an attacker-controlled unknown key name');
    }
    console.log('  ✓ Invalid MCP card input rejected before mutation.');

    // Step 7: Update & Move Card
    console.log('\n[7/12] Updating & Moving Card via MCP (update_card & move_card)...');
    const updatedCard = await callMCPTool('update_card', {
      card_id: card.id,
      priority: 'critical',
    });
    console.log(`  ✓ Card Priority Escalated: ${updatedCard.priority}`);

    const movedCard = await callMCPTool('move_card', {
      card_id: card.id,
      target_column_id: inProgressCol.id,
    });
    console.log(`  ✓ Card Moved to Column ID: ${movedCard.column_id}`);

    // Step 8: Add Comment to Card
    console.log('\n[8/12] Adding Comment to Card via MCP (add_comment)...');
    const comment = await callMCPTool('add_comment', {
      card_id: card.id,
      agent_id: agent.id,
      content: 'Started automated integration verification suite. All tools responding correctly.',
    });
    console.log(`  ✓ Comment Created! ID: ${comment.id}, Content: "${comment.content}"`);

    // Step 9: Create Design Document
    console.log('\n[9/12] Authoring Design Document via MCP (create_document)...');
    const doc = await callMCPTool('create_document', {
      project_id: project.id,
      title: 'MCP Streamable HTTP Transport Specification',
      content: '# MCP Specification\n\nThis document describes the Streamable HTTP transport implementation for Muster.',
    });
    console.log(`  ✓ Document Created! ID: ${doc.id}, Title: "${doc.title}", Version: ${doc.version}`);

    // Step 10: Update Document & Check History
    console.log('\n[10/12] Updating Design Document & History via MCP (update_document & get_document_history)...');
    const updatedDoc = await callMCPTool('update_document', {
      document_id: doc.id,
      title: 'MCP Streamable HTTP Transport Specification v2',
      content: '# MCP Specification v2\n\nUpdated with complete 33-tool schema definitions.',
      change_summary: 'Added detailed tool schema parameters',
    });
    console.log(`  ✓ Document Updated! New Version: ${updatedDoc.version}, Title: "${updatedDoc.title}"`);

    const history = await callMCPTool('get_document_history', { document_id: doc.id });
    console.log(`  ✓ Version History Retreived: ${history.length} historical version(s) archived.`);

    // Step 11: Transition Document Status
    console.log('\n[11/12] Transitioning Document Status via MCP (set_document_status)...');
    const inReviewDoc = await callMCPTool('set_document_status', {
      document_id: doc.id,
      status: 'in_review',
      expected_version: updatedDoc.version,
    });
    console.log(`  ✓ Status set to: ${inReviewDoc.status}`);

    const approvedDoc = await callMCPTool('set_document_status', {
      document_id: doc.id,
      status: 'approved',
      expected_version: inReviewDoc.version,
    });
    console.log(`  ✓ Status set to: ${approvedDoc.status}`);

    // Step 12: Get Project Summary & Activity Logs
    console.log('\n[12/12] Fetching Project Summary & Activity via MCP (get_project_summary & get_activity)...');
    const summary = await callMCPTool('get_project_summary', { project_id: project.id });
    const activity = await callMCPTool('get_activity', { project_id: project.id, limit: 10 });

    console.log(`  ✓ Project Summary:`);
    console.log(`      - Boards: ${summary.board_count}`);
    console.log(`      - Cards: ${summary.card_count}`);
    console.log(`      - Registered Agents: ${summary.agent_count}`);
    console.log(`      - Active Agents: ${summary.active_agent_count}`);
    // Step 13: Knowledge Base & Gained Knowledge Tools
    console.log('\n[13/13] Testing Knowledge Base MCP Tools (create_knowledge_base, add_gained_knowledge, get_entity_knowledge, search_knowledge)...');
    const kb = await callMCPTool('create_knowledge_base', {
      name: 'E2E Test KB',
      description: 'Knowledge base created during automated test run',
      project_ids: [project.id],
    });
    console.log(`  ✓ Knowledge Base Created! ID: ${kb.id}, Name: "${kb.name}"`);

    const fact = await callMCPTool('add_gained_knowledge', {
      kb_id: kb.id,
      title: 'Server Alpha CPU Constraint',
      content: 'Server Alpha on 192.168.1.99 has 1 CPU core and should not build Docker images.',
      category: 'constraint',
    });
    console.log(`  ✓ Gained Knowledge Fact Added! ID: ${fact.id}, Title: "${fact.title}"`);

    const entityKnowledge = await callMCPTool('get_entity_knowledge', {
      query: '192.168.1.99',
      kb_id: kb.id,
    });
    console.log(`  ✓ Canonical Entity Knowledge Retrieved for 192.168.1.99: Entity Type: ${entityKnowledge.entity.type}`);

    const searchRes = await callMCPTool('search_knowledge', {
      query: '192.168.1.99',
      project_id: project.id,
    });
    console.log(`  ✓ Search Knowledge Returned: ${searchRes.facts.length} fact(s) and ${searchRes.entities.length} entity/entities.`);

    console.log('\n===========================================================');
    console.log('   🎉 ALL 13 MCP PROTOCOL TESTS PASSED CLEANLY!');
    console.log('===========================================================\n');
  } finally {
    serverProcess.kill('SIGTERM');
    await sleep(500);
    removeDbFiles(TEST_DB_PATH);
    console.log(`  🧹 Deleted temporary MCP test database files (${path.basename(TEST_DB_PATH)}*).`);
  }
}


runMcpAgentTestSuite().catch((err) => {
  console.error('\n❌ MCP Test Suite Error:', err);
  process.exit(1);
});
