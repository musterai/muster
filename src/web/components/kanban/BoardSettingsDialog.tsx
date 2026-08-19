import React from 'react';
import { Plus, Settings, Trash2, X } from 'lucide-react';
import type { Board } from '../../types.js';
import { AccessibleDialog } from '../AccessibleDialog.js';

interface BoardSettingsDialogProps {
  board: Board;
  boardNameInput: string;
  onBoardNameInput: (name: string) => void;
  onRename: () => void;
  onClose: () => void;
  onOpenNewColumn: () => void;
  onDeleteBoard: (boardId: string) => void;
}

export const BoardSettingsDialog: React.FC<BoardSettingsDialogProps> = ({
  board,
  boardNameInput,
  onBoardNameInput,
  onRename,
  onClose,
  onOpenNewColumn,
  onDeleteBoard,
}) => (
  <AccessibleDialog onClose={onClose} titleId="board-settings-title" className="w-full max-w-md p-5 space-y-4 font-sans">
    <div className="flex items-center justify-between border-b border-muster-border pb-3">
      <h2 id="board-settings-title" className="text-sm font-bold muster-text-primary flex items-center">
        <Settings className="w-4 h-4 mr-2 muster-accent" /> Board Settings
      </h2>
      <button onClick={onClose} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" aria-label="Close board settings"><X className="w-4 h-4" /></button>
    </div>
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onRename();
        onClose();
      }}
      className="space-y-2"
    >
      <label className="muster-label">Rename Board</label>
      <div className="flex space-x-2">
        <input type="text" value={boardNameInput} onChange={(event) => onBoardNameInput(event.target.value)} placeholder="Board name" className="muster-input flex-1" />
        <button type="submit" disabled={!boardNameInput.trim() || boardNameInput === board.name} className="muster-btn muster-btn-primary">Save</button>
      </div>
    </form>
    <div className="border-t border-muster-border/60 pt-3 space-y-2">
      <label className="muster-label">Board Actions</label>
      <div className="flex flex-col space-y-2">
        <button onClick={() => { onClose(); onOpenNewColumn(); }} className="muster-btn muster-btn-secondary justify-start text-xs py-2">
          <Plus className="w-4 h-4 mr-1.5 muster-accent" /> Add New Column
        </button>
        <button
          onClick={() => {
            onClose();
            if (confirm(`Are you sure you want to delete board "${board.name}"?\n\nThis will permanently delete all columns and cards on this board.`)) onDeleteBoard(board.id);
          }}
          className="muster-btn muster-btn-danger-soft justify-start text-xs py-2"
        >
          <Trash2 className="w-4 h-4 mr-1.5" /> Delete Board
        </button>
      </div>
    </div>
  </AccessibleDialog>
);
