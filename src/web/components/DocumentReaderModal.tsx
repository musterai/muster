import React from 'react';
import { FileText, X, ExternalLink, Clock, ShieldCheck, FileEdit, CheckCircle2, AlertCircle } from 'lucide-react';
import { renderMarkdown } from '../markdown.js';
import { Document } from '../types.js';
import { AccessibleDialog } from './AccessibleDialog.js';

interface DocumentReaderModalProps {
  document: Document;
  onClose: () => void;
  onOpenInVault?: (docId: string) => void;
}

export const DocumentReaderModal: React.FC<DocumentReaderModalProps> = ({
  document: doc,
  onClose,
  onOpenInVault,
}) => {
  const getStatusBadge = (status: Document['status']) => {
    switch (status) {
      case 'approved':
        return (
          <span className="muster-badge muster-badge-success">
            <CheckCircle2 className="w-3 h-3 mr-1 muster-text-success" />
            Approved
          </span>
        );
      case 'in_review':
        return (
          <span className="muster-badge muster-badge-warning">
            <AlertCircle className="w-3 h-3 mr-1 muster-text-warning" />
            In Review
          </span>
        );
      default:
        return (
          <span className="muster-badge muster-badge-neutral">
            <FileEdit className="w-3 h-3 mr-1 muster-text-muted" />
            Draft
          </span>
        );
    }
  };

  return (
    <AccessibleDialog
      onClose={onClose}
      titleId="document-reader-title"
      descriptionId="document-reader-description"
      className="w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
    >
        
        {/* Header */}
        <div className="p-4 border-b border-muster-border flex items-start justify-between bg-muster-surface">
          <div className="flex items-start space-x-3 min-w-0 pr-4">
            <div className="p-2 bg-warning-500/10 border border-warning-500/30 rounded-lg muster-text-warning flex-shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                <h2 id="document-reader-title" className="text-base font-bold muster-text-primary truncate">{doc.title}</h2>
                {getStatusBadge(doc.status)}
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-neutral-800 muster-text-secondary border border-neutral-700">
                  v{doc.version}
                </span>
              </div>
              <div id="document-reader-description" className="flex items-center space-x-3 mt-1 text-xs muster-text-muted">
                <span className="flex items-center">
                  <Clock className="w-3 h-3 mr-1 text-neutral-500" />
                  Updated: {new Date(doc.updated_at).toLocaleString()}
                </span>
                <span>•</span>
                <span className="font-mono text-neutral-500 text-[11px]">ID: #{doc.id.substring(doc.id.length - 8)}</span>
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="muster-btn muster-btn-icon muster-btn-ghost flex-shrink-0"
            title="Close document viewer"
            aria-label="Close document viewer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Viewer Body */}
        <div className="p-6 overflow-y-auto flex-1 bg-muster-surface font-sans text-sm muster-text-secondary leading-relaxed space-y-4">
          {doc.content ? (
            <div
              className="markdown-render max-w-none text-xs leading-relaxed bg-muster-surface p-4 rounded-lg border border-muster-border overflow-x-auto"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.content) }}
            />
          ) : (
            <p className="text-neutral-500 italic text-xs">This document is empty.</p>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-muster-border bg-muster-surface flex items-center justify-between">
          <div>
            {onOpenInVault && (
              <button
                onClick={() => {
                  onClose();
                  onOpenInVault(doc.id);
                }}
                className="muster-btn muster-btn-soft"
              >
                <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Open in Document Vault
              </button>
            )}
          </div>
          <button
            onClick={onClose}
            className="muster-btn muster-btn-lg muster-btn-secondary"
          >
            Close
          </button>
        </div>

    </AccessibleDialog>
  );
};
