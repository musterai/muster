import React, { useState } from 'react';
import { Project } from '../../types.js';
import { X, FolderPlus, Edit2, AlertCircle, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import { AccessibleDialog } from '../AccessibleDialog.js';

interface NewProjectModalProps {
  onClose: () => void;
  onSuccess: (newProjectId: string) => void;
}

export const NewProjectModal: React.FC<NewProjectModalProps> = ({ onClose, onSuccess }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const proj = await api.createProject({ name, description });
      onSuccess(proj.id);
      onClose();
    } catch (err: any) {
      console.error('Failed to create project:', err);
      setError(err.message || 'Failed to create project. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog onClose={onClose} titleId="new-project-title" className="w-full max-w-md max-h-[90vh] overflow-y-auto mx-2 p-4 sm:p-5 space-y-4 font-sans">
        <div className="flex items-center justify-between border-b border-muster-border pb-3">
          <h2 id="new-project-title" className="text-sm font-bold muster-text-primary flex items-center">
            <FolderPlus className="w-4 h-4 mr-2 muster-accent" /> Create New Project
          </h2>
          <button onClick={onClose} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" aria-label="Close create project dialog">
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
            <label htmlFor="new-project-name" className="muster-label">Project Name</label>
            <input
              id="new-project-name"
              data-dialog-initial-focus
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Collaborative Platform v2"
              className="muster-input muster-input-lg"
            />
          </div>

          <div>
            <label htmlFor="new-project-description" className="muster-label">Description</label>
            <textarea
              id="new-project-description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Project goals, scope, and target deliverables..."
              className="muster-input"
            />
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
              {isSubmitting ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
    </AccessibleDialog>
  );
};

interface EditProjectModalProps {
  project: Project;
  onClose: () => void;
  onSuccess: () => void;
  onDeleteProject?: (projectId: string) => void;
}

export const EditProjectModal: React.FC<EditProjectModalProps> = ({ project, onClose, onSuccess, onDeleteProject }) => {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description || '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await api.updateProject(project.id, { name: name.trim(), description: description.trim() || undefined });
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('Failed to edit project:', err);
      setError(err.message || 'Failed to edit project. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog onClose={onClose} titleId="edit-project-title" className="w-full max-w-md max-h-[90vh] overflow-y-auto mx-2 p-4 sm:p-5 space-y-4 font-sans">
        <div className="flex items-center justify-between border-b border-muster-border pb-3">
          <h2 id="edit-project-title" className="text-sm font-bold muster-text-primary flex items-center">
            <Edit2 className="w-4 h-4 mr-2 muster-accent" /> Edit Project Details
          </h2>
          <button onClick={onClose} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" aria-label="Close edit project dialog">
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
            <label htmlFor="edit-project-name" className="muster-label">Project Name</label>
            <input
              id="edit-project-name"
              data-dialog-initial-focus
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Collaborative Platform v2"
              className="muster-input muster-input-lg"
            />
          </div>

          <div>
            <label htmlFor="edit-project-description" className="muster-label">Description</label>
            <textarea
              id="edit-project-description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Project goals, scope, and target deliverables..."
              className="muster-input"
            />
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

        {onDeleteProject && (
          <div className="border-t border-muster-border pt-3 mt-4">
            <button
              type="button"
              onClick={() => {
                if (confirm(`Are you sure you want to delete project "${project.name}"?\n\nThis will permanently delete all boards, cards, documents, and knowledge base links in this project.`)) {
                  onDeleteProject(project.id);
                  onClose();
                }
              }}
              className="muster-btn muster-btn-danger-soft text-xs w-full justify-center"
            >
              <Trash2 className="w-4 h-4 mr-1.5" /> Delete Project
            </button>
          </div>
        )}
    </AccessibleDialog>
  );
};
