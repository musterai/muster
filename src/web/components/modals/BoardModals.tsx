import React, { useState } from 'react';
import type { Column, ColumnWorkflowRole } from '../../types.js';
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
  const [workflowRole, setWorkflowRole] = useState<ColumnWorkflowRole>('ready');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const limit = wipLimit ? parseInt(wipLimit, 10) : undefined;
      await api.createColumn(boardId, name, limit, workflowRole);
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

          <div>
            <label htmlFor="new-column-role" className="muster-label">Workflow role</label>
            <select
              id="new-column-role"
              value={workflowRole}
              onChange={(e) => setWorkflowRole(e.target.value as ColumnWorkflowRole)}
              className="muster-input"
            >
              <option value="backlog">Backlog — not ready to work</option>
              <option value="ready">Ready — eligible for work</option>
              <option value="active">Active — work in progress</option>
              <option value="review">Review — awaiting verification</option>
              <option value="terminal">Terminal — completed work</option>
            </select>
            <p className="mt-1 text-[10px] muster-text-muted">This role controls claim, move, completion, and Epic progress rules.</p>
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
              {isSubmitting ? 'Adding...' : 'Add Column'}
            </button>
          </div>
        </form>
    </AccessibleDialog>
  );
};

interface EditColumnModalProps {
  column: Column;
  cardCount?: number;
  onClose: () => void;
  onSuccess: () => void;
  onDelete?: (columnId: string) => void;
}

export const EditColumnModal: React.FC<EditColumnModalProps> = ({ column, cardCount = 0, onClose, onSuccess, onDelete }) => {
  const [name, setName] = useState(column.name);
  const [wipLimit, setWipLimit] = useState<string>(column.wip_limit !== null && column.wip_limit !== undefined ? String(column.wip_limit) : '');
  const [workflowRole, setWorkflowRole] = useState<ColumnWorkflowRole | ''>(column.workflow_role ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const limit = wipLimit.trim() !== '' ? parseInt(wipLimit, 10) : null;
      if (!workflowRole) {
        setError('Select a workflow role before saving this lane.');
        return;
      }
      const nextRole = workflowRole;
      const roleChanged = nextRole !== column.workflow_role;
      if (roleChanged && cardCount > 0 && !window.confirm(
        `This lane contains ${cardCount} ${cardCount === 1 ? 'card' : 'cards'}. Changing its workflow role can change blocker enforcement, Epic progress, and completion meaning. Apply this role change?`,
      )) return;
      await api.updateColumn(column.id, {
        name: name.trim(),
        wip_limit: limit,
        workflow_role: nextRole,
        confirm_impact: roleChanged && cardCount > 0,
      });
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

          <div>
            <label htmlFor="edit-column-role" className="muster-label">Workflow role</label>
            <select
              id="edit-column-role"
              value={workflowRole}
              onChange={(e) => setWorkflowRole(e.target.value as ColumnWorkflowRole | '')}
              className="muster-input"
            >
              <option value="" disabled>Select a workflow role</option>
              <option value="backlog">Backlog — not ready to work</option>
              <option value="ready">Ready — eligible for work</option>
              <option value="active">Active — work in progress</option>
              <option value="review">Review — awaiting verification</option>
              <option value="terminal">Terminal — completed work</option>
            </select>
            <p className="mt-1 text-[10px] muster-text-muted">Changing a role on a populated lane requires confirmation.</p>
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
