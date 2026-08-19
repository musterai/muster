import { z } from 'zod';
import { withPermission } from '../../shared/permission-enforcer.js';
import { resolveActor, withMutationAudit, type McpToolContext } from '../tool-context.js';

export function registerWorkspaceTools({ server, services, auth }: McpToolContext): void {
  // --- Project Tools ---
  server.tool('list_projects', {}, withPermission('list_projects', auth, async () => {
    const projects = await services.projectService.list(auth);
    return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
  }));

  server.tool('create_project', { name: z.string(), description: z.string().optional() }, withPermission('create_project', auth, async (args) => {
    const project = await services.projectService.create(args, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
  }));

  server.tool('get_project_summary', { project_id: z.string() }, withPermission('get_project_summary', auth, async ({ project_id }) => {
    const summary = await services.projectService.getSummary(project_id, auth);
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }));

  server.tool(
    'update_project',
    {
      project_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
    },
    withPermission('update_project', auth, async ({ project_id, ...data }) => {
      const project = await services.projectService.update(project_id, data, resolveActor(auth), undefined, auth);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    })
  );

  server.tool('delete_project', { project_id: z.string() }, withPermission('delete_project', auth, async ({ project_id }) => {
    await withMutationAudit(services, auth, {
      action: 'project.delete',
      target_type: 'project',
      target_id: project_id,
    }, tx => services.projectService.delete(project_id, resolveActor(auth), tx, auth));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Project ${project_id} deleted` }) }] };
  }));

  // --- Board & Column Tools ---
  server.tool('list_boards', { project_id: z.string() }, withPermission('list_boards', auth, async ({ project_id }) => {
    const boards = await services.boardService.list(project_id, auth);
    return { content: [{ type: 'text', text: JSON.stringify(boards, null, 2) }] };
  }));

  server.tool(
    'create_board',
    {
      project_id: z.string(),
      name: z.string(),
      template: z.enum(['simple', 'standard']).optional(),
      columns: z.array(z.string()).optional(),
    },
    withPermission('create_board', auth, async (args) => {
      const board = await services.boardService.create(args, resolveActor(auth), undefined, auth);
      return { content: [{ type: 'text', text: JSON.stringify(board, null, 2) }] };
    })
  );

  server.tool('update_board', { board_id: z.string(), name: z.string() }, withPermission('update_board', auth, async ({ board_id, name }) => {
    const board = await services.boardService.update(board_id, { name }, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(board, null, 2) }] };
  }));

  server.tool('delete_board', { board_id: z.string() }, withPermission('delete_board', auth, async ({ board_id }) => {
    await services.boardService.delete(board_id, resolveActor(auth), undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Board ${board_id} deleted` }) }] };
  }));

  server.tool('get_board', { board_id: z.string() }, withPermission('get_board', auth, async ({ board_id }) => {
    const board = await services.boardService.getById(board_id, auth);
    if (!board) throw new Error(`Board ${board_id} not found`);

    const columns = await services.columnService.list(board_id, auth);
    const cards = await services.cardService.list({ board_id }, auth);

    return {
      content: [{ type: 'text', text: JSON.stringify({ ...board, columns, cards }, null, 2) }],
    };
  }));

  server.tool('create_column', {
    board_id: z.string(),
    name: z.string(),
    position: z.string().optional(),
    wip_limit: z.number().optional()
  }, withPermission('create_column', auth, async (args) => {
    const col = await services.columnService.create(args, undefined, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(col, null, 2) }] };
  }));

  server.tool('update_column', {
    column_id: z.string(),
    name: z.string().optional(),
    wip_limit: z.number().nullable().optional(),
    position: z.string().optional()
  }, withPermission('update_column', auth, async ({ column_id, ...data }) => {
    const col = await services.columnService.update(column_id, data, undefined, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(col, null, 2) }] };
  }));

  server.tool('move_column', { column_id: z.string(), position: z.string() }, withPermission('move_column', auth, async ({ column_id, position }) => {
    const col = await services.columnService.update(column_id, { position }, undefined, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify(col, null, 2) }] };
  }));

  server.tool('delete_column', { column_id: z.string() }, withPermission('delete_column', auth, async ({ column_id }) => {
    await services.columnService.delete(column_id, undefined, undefined, auth);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Column ${column_id} deleted` }) }] };
  }));

}
