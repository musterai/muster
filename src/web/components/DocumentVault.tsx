// File: src/web/components/DocumentVault.tsx
import React, { useState, useEffect } from 'react';
import { Document, DocumentVersion } from '../types.js';
import { FileText, Edit3, History, CheckCircle, Clock, Save, Plus, X, ArrowLeft, User, Trash2 } from 'lucide-react';
import { renderMarkdown } from '../markdown.js';
import { api } from '../api.js';

interface DocumentVaultProps {
  documents: Document[];
  selectedDocId: string | null;
  onSelectDoc: (docId: string) => void;
  onOpenNewDoc: () => void;
  onRefresh: () => void;
}

export const DocumentVault: React.FC<DocumentVaultProps> = ({
  documents,
  selectedDocId,
  onSelectDoc,
  onOpenNewDoc,
  onRefresh,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [changeSummary, setChangeSummary] = useState('');
  const [history, setHistory] = useState<DocumentVersion[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showMobileDetail, setShowMobileDetail] = useState(false);

  // Find active doc by ID, or fallback to latest doc if no ID is specified
  const foundDoc = documents.find((d) => d.id === selectedDocId);
  const selectedDoc = foundDoc || (selectedDocId ? null : (documents.length > 0 ? documents[documents.length - 1] : null));

  // Sync selectedDocId if auto-selecting fallback when no ID was specified
  useEffect(() => {
    if (!selectedDocId && selectedDoc) {
      onSelectDoc(selectedDoc.id);
    }
  }, [selectedDocId, selectedDoc, onSelectDoc]);

  const handleSelectDoc = (doc: Document) => {
    onSelectDoc(doc.id);
    setIsEditing(false);
    setShowHistory(false);
    setShowMobileDetail(true);
  };

  const handleStartEdit = () => {
    if (!selectedDoc) return;
    setEditTitle(selectedDoc.title);
    setEditContent(selectedDoc.content);
    setChangeSummary('');
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditTitle('');
    setEditContent('');
    setChangeSummary('');
  };

  const handleSaveEdit = async () => {
    if (!selectedDoc) return;
    try {
      await api.updateDocument(selectedDoc.id, {
        title: editTitle,
        content: editContent,
        change_summary: changeSummary || 'Updated content',
      });
      setIsEditing(false);
      onRefresh();
    } catch (err) {
      console.error('Failed to update document:', err);
    }
  };

  const handleStatusChange = async (status: 'in_review' | 'approved') => {
    if (!selectedDoc) return;
    try {
      await api.setDocumentStatus(selectedDoc.id, status, selectedDoc.version);
      onRefresh();
    } catch (err) {
      console.error('Failed to update document status:', err);
    }
  };

  const handleLoadHistory = async () => {
    if (!selectedDoc) return;
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    try {
      const versions = await api.getDocumentHistory(selectedDoc.id);
      setHistory(versions);
      setShowHistory(true);
    } catch (err) {
      console.error('Failed to load version history:', err);
    }
  };

  const handleDeleteDocument = async () => {
    if (!selectedDoc) return;
    if (!confirm(`Are you sure you want to delete document "${selectedDoc.title}"? This action cannot be undone.`)) return;
    try {
      await api.deleteDocument(selectedDoc.id);
      onRefresh();
    } catch (err: any) {
      console.error('Failed to delete document:', err);
      alert(err.message || 'Failed to delete document');
    }
  };

  const getStatusBadge = (status: Document['status']) => {
    switch (status) {
      case 'approved':
        return (
          <span className="muster-badge muster-badge-success">
            <CheckCircle className="w-3 h-3 mr-1" /> Approved
          </span>
        );
      case 'in_review':
        return (
          <span className="muster-badge muster-badge-warning">
            <Clock className="w-3 h-3 mr-1 animate-pulse" /> In Review
          </span>
        );
      case 'draft':
      default:
        return (
          <span className="muster-badge muster-badge-neutral">
            Draft (v{selectedDoc?.version || 1})
          </span>
        );
    }
  };

  return (
    <div className="flex flex-col flex-1 h-full min-h-0 font-sans space-y-4">
      
      {/* Header Bar */}
      <div className="flex-none flex items-center justify-between border-b border-muster-border pb-3">
        <div className="flex items-center space-x-3">
          <FileText className="w-5 h-5 muster-text-warning" />
          <h2 className="text-base font-bold muster-text-primary uppercase tracking-wide">
            Design Documents
          </h2>
        </div>
        <button
          onClick={onOpenNewDoc}
          className="muster-btn muster-btn-primary"
        >
          <Plus className="w-3.5 h-3.5 mr-1" /> Create Document
        </button>
      </div>

      {/* Main View (Stretches 100% height!) */}
      {documents.length === 0 ? (
        <div className="text-center py-16 bg-muster-surface rounded-lg tactical-border">
          <FileText className="w-12 h-12 muster-text-faint mx-auto mb-3" />
          <h3 className="text-sm muster-text-secondary font-semibold">No Design Documents</h3>
          <p className="text-xs text-neutral-500 max-w-sm mx-auto mt-1 mb-4">
            Author and version control system specifications and design docs.
          </p>
          <button
            onClick={onOpenNewDoc}
            className="muster-btn muster-btn-lg muster-btn-primary"
          >
            Create Document
          </button>
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-1 md:grid-cols-4 gap-4 min-h-0 h-full overflow-hidden">
          
          {/* Document Tree Sidebar */}
          <div className={`md:col-span-1 bg-muster-surface rounded-lg p-4 tactical-border flex flex-col h-full min-h-0 overflow-y-auto space-y-2 ${
            showMobileDetail ? 'hidden md:flex' : 'flex'
          }`}>
            <h3 className="flex-none text-xs font-bold muster-text-muted uppercase mb-3 tracking-wider">
              Documents ({documents.length})
            </h3>

            <div className="flex-1 overflow-y-auto space-y-2 pr-0.5">
              {documents.map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => handleSelectDoc(doc)}
                  className={`w-full text-left p-3 rounded-lg border transition-all cursor-pointer ${
                    selectedDoc?.id === doc.id
                      ? 'bg-warning-950/30 border-warning-500/50 text-warning-300 shadow-sm'
                      : 'bg-muster-surface border-muster-border muster-text-secondary hover:border-neutral-700 hover:bg-neutral-900'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-bold truncate">
                    <span className="truncate">{doc.title}</span>
                    <span className="text-[10px] font-mono text-neutral-500 ml-1">v{doc.version}</span>
                  </div>
                  <div className="flex items-center justify-between mt-1 text-[10px] text-neutral-500">
                    <span className="capitalize">{doc.status.replace('_', ' ')}</span>
                    <span>{new Date(doc.updated_at).toLocaleDateString()}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Document Reader / Editor */}
          <div className={`md:col-span-3 bg-muster-surface rounded-lg p-4 sm:p-6 tactical-border flex flex-col h-full min-h-0 overflow-y-auto ${
            showMobileDetail ? 'flex' : 'hidden md:flex'
          }`}>

            {selectedDoc ? (
              <div className="space-y-5">
                
                {/* Mobile Back Button */}
                <button
                  onClick={() => setShowMobileDetail(false)}
                  className="md:hidden muster-btn muster-btn-ghost text-xs inline-flex items-center w-auto py-1"
                >
                  <ArrowLeft className="w-4 h-4 mr-1" /> Back to Documents
                </button>

                {/* Spec Toolbar & Status */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-muster-border pb-4">
                  <div>
                    <h2 className="text-lg font-bold muster-text-primary">{selectedDoc.title}</h2>
                    <div className="flex items-center space-x-3 mt-1 text-xs text-neutral-500">
                      <span>ID: #{selectedDoc.id.substring(selectedDoc.id.length - 8)}</span>
                      <span>•</span>
                      <span>Version {selectedDoc.version}</span>
                      <span>•</span>
                      <span>Updated: {new Date(selectedDoc.updated_at).toLocaleString()}</span>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    {!isEditing && (
                      <>
                        {selectedDoc.status === 'approved' && (
                          <span className="muster-badge muster-badge-success flex items-center py-1 px-2.5 text-xs font-semibold">
                            <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
                            Approved
                          </span>
                        )}

                        {selectedDoc.status === 'in_review' && (
                          <>
                            <span className="muster-badge muster-badge-warning flex items-center py-1 px-2.5 text-xs">
                              <Clock className="w-3.5 h-3.5 mr-1.5 animate-pulse" /> In Review
                            </span>
                            <button
                              onClick={() => handleStatusChange('approved')}
                              className="muster-btn muster-btn-soft text-xs"
                              title="Approve this document"
                            >
                              Approve
                            </button>
                          </>
                        )}

                        {selectedDoc.status === 'draft' && (
                          <>
                            <span className="muster-badge muster-badge-neutral text-xs">
                              Draft
                            </span>
                            <button
                              onClick={() => handleStatusChange('in_review')}
                              className="muster-btn muster-btn-soft text-xs"
                              title="Submit draft for review"
                            >
                              Submit for Review
                            </button>
                          </>
                        )}
                      </>
                    )}

                    {/* Edit mode vs Read mode controls */}
                    {isEditing ? (
                      <>
                        <button
                          onClick={handleSaveEdit}
                          className="muster-btn muster-btn-primary"
                        >
                          <Save className="w-3.5 h-3.5" /> Save Version
                        </button>

                        <button
                          onClick={handleCancelEdit}
                          className="muster-btn muster-btn-secondary"
                          title="Discard changes and exit editor"
                        >
                          <X className="w-3.5 h-3.5 mr-1" /> Cancel
                        </button>
                      </>
                    ) : (
                      <div className="flex items-center space-x-1">
                        <button
                          onClick={handleLoadHistory}
                          className={`muster-btn muster-btn-icon transition-all ${
                            showHistory
                              ? 'bg-warning-950/60 text-warning-300 border-warning-500/50 ring-1 ring-warning-500/40'
                              : 'muster-btn-ghost'
                          }`}
                          title={showHistory ? 'Hide Version History' : 'Show Version History'}
                          aria-pressed={showHistory}
                        >
                          <History className="w-4 h-4" />
                        </button>

                        <div className="h-4 w-px bg-muster-border mx-1" />

                        {selectedDoc.status !== 'approved' && (
                          <button
                            onClick={handleStartEdit}
                            className="muster-btn muster-btn-icon muster-btn-ghost"
                            title="Edit Document"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                        )}

                        <button
                          onClick={handleDeleteDocument}
                          className="muster-btn muster-btn-icon muster-btn-ghost hover:bg-danger-950/40 hover:border-danger-600/50"
                          title="Delete Document"
                        >
                          <Trash2 className="w-4 h-4 text-danger-400" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* History Drawer (renders directly beneath header toolbar when toggled) */}
                {showHistory && (
                  <div className="p-4 bg-muster-surface rounded-lg border border-warning-500/30 space-y-3 shadow-md animate-in fade-in duration-150">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-warning-300 uppercase flex items-center">
                        <History className="w-3.5 h-3.5 mr-1.5" /> Version History ({history.length})
                      </h4>
                      <button
                        onClick={() => setShowHistory(false)}
                        className="muster-btn muster-btn-icon muster-btn-ghost p-1 text-xs"
                        title="Close History"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {history.map((ver) => (
                        <div key={ver.id} className="p-2.5 bg-neutral-900 rounded border border-neutral-800 text-xs flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div>
                              <span className="font-bold muster-text-warning">v{ver.version}</span> - {ver.change_summary || 'Updated'}
                            </div>
                            <div className="flex items-center gap-1.5 mt-1 muster-text-muted text-[10px]">
                              <User className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                              {ver.author_name ? (
                                <span className="muster-chip">{ver.author_name}</span>
                              ) : (
                                <span className="italic">Unknown author</span>
                              )}
                            </div>
                          </div>
                          <span className="text-[10px] text-neutral-500 flex-shrink-0">{new Date(ver.created_at).toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Edit or Render View */}
                {isEditing ? (
                  <div className="space-y-4">
                    <div>
                      <label className="muster-label">Title</label>
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="muster-input muster-input-lg"
                      />
                    </div>
                    <div>
                      <label className="muster-label">Change Summary</label>
                      <input
                        type="text"
                        value={changeSummary}
                        onChange={(e) => setChangeSummary(e.target.value)}
                        placeholder="Summary of changes..."
                        className="muster-input"
                      />
                    </div>
                    <div>
                      <label className="muster-label">Markdown Body</label>
                      <textarea
                        rows={16}
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="muster-input font-sans p-3 leading-relaxed"
                      />
                    </div>
                  </div>
                ) : (
                  <div
                    className="markdown-render max-w-none text-xs leading-relaxed bg-muster-surface p-6 rounded-lg border border-muster-border"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedDoc.content) }}
                  />
                )}

              </div>
            ) : null}
          </div>

        </div>
      )}

    </div>
  );
};
