import React from 'react';
import { AlertCircle, Plus, Settings, Trash2, X } from 'lucide-react';
import type { BoardSettingsController } from '../../hooks/useKanbanChromeController.js';
import { AccessibleDialog } from '../AccessibleDialog.js';

interface BoardSettingsDialogProps {
  controller: BoardSettingsController;
}

export const BoardSettingsDialog: React.FC<BoardSettingsDialogProps> = ({ controller }) => {
  const { board, boardNameInput, columns } = controller.model;
  const { setBoardNameInput, rename, close, openNewColumn, editColumn, deleteBoard } = controller.actions;
  const unclassifiedCount = board.unclassified_column_ids?.length ?? columns.filter((column) => !column.workflow_role).length;
  return (
  <AccessibleDialog onClose={close} titleId="board-settings-title" className="w-full max-w-md p-5 space-y-4 font-sans">
    <div className="flex items-center justify-between border-b border-muster-border pb-3">
      <h2 id="board-settings-title" className="text-sm font-bold muster-text-primary flex items-center">
        <Settings className="w-4 h-4 mr-2 muster-accent" /> Board Settings
      </h2>
      <button onClick={close} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" aria-label="Close board settings"><X className="w-4 h-4" /></button>
    </div>
    <form
      onSubmit={(event) => {
        event.preventDefault();
        rename();
      }}
      className="space-y-2"
    >
      <label className="muster-label">Rename Board</label>
      <div className="flex space-x-2">
        <input type="text" value={boardNameInput} onChange={(event) => setBoardNameInput(event.target.value)} placeholder="Board name" className="muster-input flex-1" />
        <button type="submit" disabled={!boardNameInput.trim() || boardNameInput === board.name} className="muster-btn muster-btn-primary">Save</button>
      </div>
    </form>
    {board.workflow_config_state === 'needs_review' && (
      <div role="alert" className="muster-panel p-3 space-y-1">
        <div className="flex items-start gap-2">
          <span className="muster-badge muster-badge-warning shrink-0"><AlertCircle className="h-3 w-3" /> Workflow configuration required</span>
          <p className="text-xs muster-text-primary leading-relaxed">
            Assign a workflow role to each lane before agents can claim or move cards on this board.
          </p>
        </div>
        <p className="text-[11px] muster-text-muted">
          {unclassifiedCount > 0
            ? `${unclassifiedCount} ${unclassifiedCount === 1 ? 'lane is' : 'lanes are'} waiting for a role.`
            : 'Assign at least one active and one terminal role to enable workflow operations.'}
        </p>
      </div>
    )}
    <div className="border-t border-muster-border/60 pt-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label className="muster-label !mb-0">Workflow lanes</label>
        <span className="text-[10px] muster-text-muted">Roles drive card automation</span>
      </div>
      <div className="space-y-1.5" role="list" aria-label="Workflow lanes">
        {columns.map((column) => (
          <div key={column.id} role="listitem" className="muster-panel flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold muster-text-primary truncate">{column.name}</p>
              <p className="text-[10px] muster-text-muted">{column.workflow_role ? column.workflow_role : 'Needs a role'}</p>
            </div>
            <button
              type="button"
              onClick={() => { close(); editColumn(column); }}
              className="muster-btn muster-btn-ghost text-[10px] px-2 py-1"
            >
              Edit role
            </button>
          </div>
        ))}
      </div>
    </div>
    <div className="border-t border-muster-border/60 pt-3 space-y-2">
      <label className="muster-label">Board Actions</label>
      <div className="flex flex-col space-y-2">
        <button onClick={() => { close(); openNewColumn(); }} className="muster-btn muster-btn-secondary justify-start text-xs py-2">
          <Plus className="w-4 h-4 mr-1.5 muster-accent" /> Add New Column
        </button>
        <button
          onClick={() => {
            close();
            if (confirm(`Are you sure you want to delete board "${board.name}"?\n\nThis will permanently delete all columns and cards on this board.`)) deleteBoard(board.id);
          }}
          className="muster-btn muster-btn-danger-soft justify-start text-xs py-2"
        >
          <Trash2 className="w-4 h-4 mr-1.5" /> Delete Board
        </button>
      </div>
    </div>
  </AccessibleDialog>
  );
};
