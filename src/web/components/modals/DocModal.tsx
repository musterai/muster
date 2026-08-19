import React, { useState } from 'react';
import { X, FileText, AlertCircle } from 'lucide-react';
import { api } from '../../api.js';
import { AccessibleDialog } from '../AccessibleDialog.js';

interface NewDocModalProps {
  projectId: string;
  onClose: () => void;
  onSuccess: (newDoc?: any) => void;
}

export const NewDocModal: React.FC<NewDocModalProps> = ({ projectId, onClose, onSuccess }) => {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('# Document Title\n\n## Overview\nDetails...');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const doc = await api.createDocument(projectId, { title, content });
      onSuccess(doc);
      onClose();
    } catch (err: any) {
      console.error('Failed to create document:', err);
      setError(err.message || 'Failed to create document.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog onClose={onClose} titleId="new-document-title" className="w-full max-w-lg max-h-[90vh] overflow-y-auto mx-2 p-4 sm:p-5 space-y-4 font-sans">
        <div className="flex items-center justify-between border-b border-muster-border pb-3">
          <h2 id="new-document-title" className="text-sm font-bold muster-text-primary flex items-center">
            <FileText className="w-4 h-4 mr-2 muster-accent" /> Create Design Document
          </h2>
          <button onClick={onClose} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" aria-label="Close create document dialog">
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
            <label htmlFor="new-document-name" className="muster-label">Document Title</label>
            <input
              id="new-document-name"
              data-dialog-initial-focus
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Architecture Overview & Schemas"
              className="muster-input muster-input-lg"
            />
          </div>

          <div>
            <label htmlFor="new-document-content" className="muster-label">Markdown Content</label>
            <textarea
              id="new-document-content"
              rows={8}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="muster-input font-mono"
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
              disabled={isSubmitting || !title.trim()}
              className="muster-btn muster-btn-primary"
            >
              {isSubmitting ? 'Creating...' : 'Create Document'}
            </button>
          </div>
        </form>
    </AccessibleDialog>
  );
};
