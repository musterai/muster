import React, { useState } from 'react';
import { Column } from '../../types.js';
import { X, Plus, Layers, AlertCircle, Edit2, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import { AccessibleDialog } from '../AccessibleDialog.js';

interface NewBoardModalProps {
  projectId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export const NewBoardModal: React.FC<NewBoardModalProps> = ({ projectId, onClose, onSuccess }) => {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<'simple' | 'standard'>('simple');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await api.createBoard(projectId, name, template);
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('Failed to create board:', err);
      setError(err.message || 'Failed to create board.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog onClose={onClose} titleId="new-board-title" className="w-full max-w-md max-h-[90vh] overflow-y-auto mx-2 p-4 sm:p-5 space-y-4 font-sans">
        <div className="flex items-center justify-between border-b border-muster-border pb-3">
          <h2 id="new-board-title" className="text-sm font-bold muster-text-primary flex items-center">
            <Layers className="w-4 h-4 mr-2 muster-accent" /> Create New Board
          </h2>
          <button onClick={onClose} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" aria-label="Close create board dialog">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div role="alert" className="muster-badge muster-badge-danger normal-case tracking-normal text-xs p-3 w-full">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label htmlFor="new-board-name" className="muster-label">Board Name</label>
            <input
              id="new-board-name"
              data-dialog-initial-focus
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sprint 2, Feature Roadmap"
              className="muster-input muster-input-lg"
            />
          </div>

          <div>
            <label htmlFor="new-board-template" className="muster-label">Board Structure / Lanes</label>
            <select
              id="new-board-template"
              value={template}
              onChange={(e) => setTemplate(e.target.value as 'simple' | 'standard')}
              className="muster-input"
            >
              <option value="simple">⚡ 3 Lanes (To Do → In Progress → Done)</option>
              <option value="standard">📋 5 Lanes (Backlog → To Do → In Progress → In Review → Done)</option>
            </select>
          </div>

          <div className="pt-3 flex justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="muster-btn muster-btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim()}
              className="muster-btn muster-btn-primary"
            >
              {isSubmitting ? 'Creating...' : 'Create Board'}
            </button>
          </div>
        </form>
    </AccessibleDialog>
  );
};

interface NewColumnModalProps {
  boardId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export const NewColumnModal: React.FC<NewColumnModalProps> = ({ boardId, onClose, onSuccess }) => {
  const [name, setName] = useState('');
  const [wipLimit, setWipLimit] = useState<string>('');
  const [isTerminal, setIsTerminal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const limit = wipLimit ? parseInt(wipLimit, 10) : undefined;
      await api.createColumn(boardId, name, limit, isTerminal);
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('Failed to create column:', err);
      setError(err.message || 'Failed to create column.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog onClose={onClose} titleId="new-column-title" className="w-full max-w-md max-h-[90vh] overflow-y-auto mx-2 p-4 sm:p-5 space-y-4 font-sans">
        <div className="flex items-center justify-between border-b border-muster-border pb-3">
          <h2 id="new-column-title" className="text-sm font-bold muster-text-primary flex items-center">
            <Plus className="w-4 h-4 mr-2 muster-accent" /> Add Column
          </h2>
          <button onClick={onClose} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" aria-label="Close add column dialog">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div role="alert" className="muster-badge muster-badge-danger normal-case tracking-normal text-xs p-3 w-full">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label htmlFor="new-column-name" className="muster-label">Column Name</label>
            <input
              id="new-column-name"
              data-dialog-initial-focus
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. In Testing, Blocked, Done"
              className="muster-input muster-input-lg"
            />
          </div>

          <div>
            <label htmlFor="new-column-wip" className="muster-label">WIP Limit (Optional)</label>
            <input
              id="new-column-wip"
              type="number"
              min="1"
              value={wipLimit}
              onChange={(e) => setWipLimit(e.target.value)}
              placeholder="e.g. 3 (leave empty for unlimited)"
              className="muster-input"
            />
          </div>

          <label className="flex items-center space-x-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isTerminal}
              onChange={(e) => setIsTerminal(e.target.checked)}
              className="rounded border-muster-border bg-muster-base text-brand-600 focus:ring-brand-500 focus:ring-offset-0"
            />
            <span className="muster-label !mb-0">Terminal column (counts as "done" for Epic progress)</span>
          </label>

          <div className="pt-3 flex justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="muster-btn muster-btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim()}
              className="muster-btn muster-btn-primary"
            >
              {isSubmitting ? 'Adding...' : 'Add Column'}
            </button>
          </div>
        </form>
    </AccessibleDialog>
  );
};

interface EditColumnModalProps {
  column: Column;
  onClose: () => void;
  onSuccess: () => void;
  onDelete?: (columnId: string) => void;
}

export const EditColumnModal: React.FC<EditColumnModalProps> = ({ column, onClose, onSuccess, onDelete }) => {
  const [name, setName] = useState(column.name);
  const [wipLimit, setWipLimit] = useState<string>(column.wip_limit !== null && column.wip_limit !== undefined ? String(column.wip_limit) : '');
  const [isTerminal, setIsTerminal] = useState(!!column.is_terminal);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const limit = wipLimit.trim() !== '' ? parseInt(wipLimit, 10) : null;
      await api.updateColumn(column.id, { name: name.trim(), wip_limit: limit, is_terminal: isTerminal ? 1 : 0 });
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('Failed to update column:', err);
      setError(err.message || 'Failed to update column.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog onClose={onClose} titleId="edit-column-title" className="w-full max-w-md max-h-[90vh] overflow-y-auto mx-2 p-4 sm:p-5 space-y-4 font-sans">
        <div className="flex items-center justify-between border-b border-muster-border pb-3">
          <h2 id="edit-column-title" className="text-sm font-bold muster-text-primary flex items-center">
            <Edit2 className="w-4 h-4 mr-2 muster-accent" /> Edit Column Settings
          </h2>
          <button onClick={onClose} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" aria-label="Close edit column dialog">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div role="alert" className="muster-badge muster-badge-danger normal-case tracking-normal text-xs p-3 w-full">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label htmlFor="edit-column-name" className="muster-label">Column Name</label>
            <input
              id="edit-column-name"
              data-dialog-initial-focus
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. In Testing, Blocked, Done"
              className="muster-input muster-input-lg"
            />
          </div>

          <div>
            <label htmlFor="edit-column-wip" className="muster-label">WIP Limit (Optional)</label>
            <input
              id="edit-column-wip"
              type="number"
              min="1"
              value={wipLimit}
              onChange={(e) => setWipLimit(e.target.value)}
              placeholder="e.g. 3 (leave empty for unlimited)"
              className="muster-input"
            />
          </div>

          <label className="flex items-center space-x-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isTerminal}
              onChange={(e) => setIsTerminal(e.target.checked)}
              className="rounded border-muster-border bg-muster-base text-brand-600 focus:ring-brand-500 focus:ring-offset-0"
            />
            <span className="muster-label !mb-0">Terminal column (counts as "done" for Epic progress)</span>
          </label>

          <div className="pt-3 flex justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="muster-btn muster-btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim()}
              className="muster-btn muster-btn-primary"
            >
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>

        {onDelete && (
          <div className="border-t border-muster-border pt-3 mt-4">
            <button
              type="button"
              onClick={() => {
                if (confirm(`Are you sure you want to delete column "${column.name}"?\n\nThis will delete the column and all cards inside it.`)) {
                  onDelete(column.id);
                  onClose();
                }
              }}
              className="muster-btn muster-btn-danger-soft text-xs w-full justify-center"
            >
              <Trash2 className="w-4 h-4 mr-1.5" /> Delete Column
            </button>
          </div>
        )}
    </AccessibleDialog>
  );
};
