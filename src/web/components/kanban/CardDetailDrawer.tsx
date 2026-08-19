import React, { useState } from 'react';
import {
  Card,
  CardDetails,
  Column,
  Document,
  User,
  Agent,
  AuthMe,
  CardLinkRelationType,
  CardWorkLinkKind,
  CardWorkLinkProvider,
} from '../../types.js';
import {
  Layout,
  Layers,
  Edit2,
  Trash2,
  X,
  Copy,
  Check,
  Plus,
  FileText,
  Eye,
  Unlink,
  Link2,
  MessageSquare,
} from 'lucide-react';
import { PrincipalChip } from '../PrincipalChip.js';
import { renderMarkdown } from '../../markdown.js';
import { CardRelationSection } from './CardRelationSection.js';
import { WorkLinkSection } from './WorkLinkSection.js';
import { PRIORITY_BADGE_CLASSES } from '../../utils/card-helpers.js';
import { AccessibleDialog } from '../AccessibleDialog.js';

interface CardDetailDrawerProps {
  cardDetails: CardDetails | null;
  columns: Column[];
  allCards: Card[];
  users: User[];
  agents: Agent[];
  documents: Document[];
  currentUser: AuthMe['user'] | null;
  copiedKeyCardId: string | null;
  isEditingCard: boolean;
  isCreatingCard: boolean;
  editCardTitle: string;
  editCardDescription: string;
  editCardPriority: 'critical' | 'high' | 'medium' | 'low';
  editCardIsEpic: boolean;
  editCardColumnId: string;
  newCardColumnId: string;
  loadingDocumentId: string | null;
  onClose: () => void;
  onCopyKey: (key: string, cardId: string, e: React.MouseEvent) => void;
  onMoveCard: (cardId: string, targetColId: string) => Promise<void>;
  onStartEditingCard: () => void;
  onDeleteCard: (cardId: string, title: string) => void;
  onSaveCard: (e: React.FormEvent) => void;
  onCreateCard: (e: React.FormEvent) => void;
  setEditCardTitle: (v: string) => void;
  setEditCardDescription: (v: string) => void;
  setEditCardPriority: (v: 'critical' | 'high' | 'medium' | 'low') => void;
  setEditCardIsEpic: (v: boolean) => void;
  setEditCardColumnId: (v: string) => void;
  setNewCardColumnId: (v: string) => void;
  setIsEditingCard: (v: boolean) => void;
  onAssignAgent: (agentId: string) => Promise<void>;
  onUnassignAgent: (agentId: string) => Promise<void>;
  onOpenLinkedDocument: (docId: string) => void;
  onLinkDocument: (docId: string) => Promise<void>;
  onUnlinkDocument: (docId: string) => Promise<void>;
  onLinkCard: (targetCardId: string, relationType: CardLinkRelationType) => Promise<void>;
  onUnlinkCard: (linkId: string, targetTitle: string) => Promise<void>;
  onAddWorkLink: (data: { kind: CardWorkLinkKind; provider: CardWorkLinkProvider; url: string; external_ref?: string }) => Promise<void>;
  onRemoveWorkLink: (linkId: string) => Promise<void>;
  onOpenCard: (cardId: string) => void;
  onAddComment: (authorId: string, content: string) => Promise<void>;
  onUpdateComment: (commentId: string, content: string) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
}

export const CardDetailDrawer: React.FC<CardDetailDrawerProps> = ({
  cardDetails,
  columns,
  allCards,
  users,
  agents,
  documents,
  currentUser,
  copiedKeyCardId,
  isEditingCard,
  isCreatingCard,
  editCardTitle,
  editCardDescription,
  editCardPriority,
  editCardIsEpic,
  editCardColumnId,
  newCardColumnId,
  loadingDocumentId,
  onClose,
  onCopyKey,
  onMoveCard,
  onStartEditingCard,
  onDeleteCard,
  onSaveCard,
  onCreateCard,
  setEditCardTitle,
  setEditCardDescription,
  setEditCardPriority,
  setEditCardIsEpic,
  setEditCardColumnId,
  setNewCardColumnId,
  setIsEditingCard,
  onAssignAgent,
  onUnassignAgent,
  onOpenLinkedDocument,
  onLinkDocument,
  onUnlinkDocument,
  onLinkCard,
  onUnlinkCard,
  onAddWorkLink,
  onRemoveWorkLink,
  onOpenCard,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
}) => {
  const [assignAgentId, setAssignAgentId] = useState('');
  const [linkDocumentId, setLinkDocumentId] = useState('');
  const [commentText, setCommentText] = useState('');
  const [selectedAuthorId, setSelectedAuthorId] = useState<string>('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  const [savingCommentId, setSavingCommentId] = useState<string | null>(null);

  const getPriorityBadge = (priority: string) => {
    const cls = PRIORITY_BADGE_CLASSES[priority] || 'muster-badge-neutral';
    return <span className={`muster-badge ${cls}`}>{priority}</span>;
  };

  const handleAssign = async () => {
    if (!assignAgentId) return;
    await onAssignAgent(assignAgentId);
    setAssignAgentId('');
  };

  const handleLinkDoc = async () => {
    if (!linkDocumentId) return;
    await onLinkDocument(linkDocumentId);
    setLinkDocumentId('');
  };

  const handleCommentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    const authorId = currentUser ? currentUser.id : selectedAuthorId;
    if (!authorId) return;

    await onAddComment(authorId, commentText);
    setCommentText('');
  };

  const canManageComment = (c: CardDetails['comments'][number]) => {
    if (!currentUser) return false;
    return c.author_id === currentUser.id;
  };

  return (
    <AccessibleDialog
      onClose={onClose}
      titleId="card-detail-title"
      descriptionId="card-detail-description"
      className="w-full max-w-4xl max-h-[90vh] flex flex-col mx-2 font-sans overflow-hidden"
    >
        <h2 id="card-detail-title" className="sr-only">
          {cardDetails ? `${cardDetails.key}: ${cardDetails.title}` : 'Create card'}
        </h2>
        <p id="card-detail-description" className="sr-only">
          {cardDetails ? 'View and edit card details, assignments, links, and comments.' : 'Enter details for the new card.'}
        </p>
        {/* Drawer Header */}
        <div className="p-4 border-b border-muster-border flex items-center justify-between bg-muster-surface flex-shrink-0">
          <div className="flex items-center space-x-3 min-w-0">
            {cardDetails ? (
              <>
                <button
                  onClick={(e) => onCopyKey(cardDetails.key, cardDetails.id, e)}
                  className="flex items-center space-x-1 font-mono text-xs muster-accent font-bold hover:opacity-75"
                  title="Copy card key"
                >
                  <span>{cardDetails.key}</span>
                  {copiedKeyCardId === cardDetails.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                </button>
                <div className="flex items-center space-x-1 text-xs muster-badge muster-badge-neutral border border-muster-border py-0.5 px-1.5">
                  <Layout className="w-3 h-3 text-neutral-400 shrink-0" aria-hidden="true" />
                  <select
                    value={cardDetails.column_id}
                    onChange={async (e) => {
                      const targetColId = e.target.value;
                      if (targetColId && targetColId !== cardDetails.column_id) {
                        await onMoveCard(cardDetails.id, targetColId);
                      }
                    }}
                    className="bg-transparent muster-text-primary text-xs focus:outline-none cursor-pointer font-sans"
                    title="Change card column / lane"
                  >
                    {columns.map((col) => (
                      <option key={col.id} value={col.id} className="bg-muster-surface muster-text-primary font-sans">
                        {col.name} {col.is_terminal ? '(Done)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                {!!cardDetails.is_epic && (
                  <span className="muster-badge muster-badge-accent flex items-center" title="Epic — a container for related work">
                    <Layers className="w-3 h-3 mr-1" aria-hidden="true" />
                    EPIC
                  </span>
                )}
                {cardDetails.epic_progress && (
                  <span
                    className="muster-badge muster-badge-neutral"
                    title={`${cardDetails.epic_progress.done} of ${cardDetails.epic_progress.total} child cards in a terminal column`}
                  >
                    {cardDetails.epic_progress.done}/{cardDetails.epic_progress.total}
                  </span>
                )}
                {getPriorityBadge(cardDetails.priority)}
              </>
            ) : (
              <span className="font-mono text-xs muster-accent font-bold flex items-center">
                <Plus className="w-3.5 h-3.5 mr-1" /> New Card
              </span>
            )}
          </div>
          <div className="flex items-center space-x-2">
            {cardDetails && (
              <>
                <button
                  onClick={onStartEditingCard}
                  className="inline-flex items-center px-2.5 py-1 bg-brand-950/80 hover:bg-brand-900 text-brand-300 border border-brand-500/40 rounded text-xs font-semibold transition-all cursor-pointer"
                  title="Edit Task Text & Properties"
                >
                  <Edit2 className="w-3.5 h-3.5 mr-1" /> Edit Task
                </button>
                <button
                  onClick={() => onDeleteCard(cardDetails.id, cardDetails.title)}
                  className="inline-flex items-center px-2.5 py-1 bg-danger-950/80 hover:bg-danger-900 text-danger-300 border border-danger-500/40 rounded text-xs font-semibold transition-all cursor-pointer"
                  title="Delete Task"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete Task
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target"
              title="Close Task"
              aria-label="Close card details"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Drawer Body */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1 font-sans">
          {isEditingCard ? (
            <form
              onSubmit={isCreatingCard ? onCreateCard : onSaveCard}
              className="space-y-3 bg-muster-surface p-4 rounded-lg border border-brand-500/40"
            >
              <div>
                <label className="muster-label">Column / State</label>
                <select
                  value={isCreatingCard ? newCardColumnId : editCardColumnId}
                  onChange={(e) => (isCreatingCard ? setNewCardColumnId(e.target.value) : setEditCardColumnId(e.target.value))}
                  className="w-full bg-muster-base border border-muster-border muster-text-primary text-xs rounded p-2"
                >
                  {columns.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.name} {col.is_terminal ? '(Done)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="muster-label">Task Title</label>
                <input
                  type="text"
                  required
                  value={editCardTitle}
                  onChange={(e) => setEditCardTitle(e.target.value)}
                  className="w-full bg-muster-base border border-muster-border muster-text-primary font-sans font-semibold text-xs rounded p-2 focus:border-brand-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="muster-label">Priority</label>
                  <select
                    value={editCardPriority}
                    onChange={(e) => setEditCardPriority(e.target.value as any)}
                    className="w-full bg-muster-base border border-muster-border muster-text-primary text-xs rounded p-2"
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
              </div>

              <label className="flex items-center space-x-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={editCardIsEpic}
                  onChange={(e) => setEditCardIsEpic(e.target.checked)}
                  className="rounded border-muster-border bg-muster-base text-brand-600 focus:ring-brand-500 focus:ring-offset-0"
                />
                <span className="muster-label !mb-0 flex items-center">
                  <Layers className="w-3.5 h-3.5 mr-1 muster-accent" />
                  Epic — a container for related work
                </span>
              </label>

              <div>
                <label className="muster-label">Description (Markdown)</label>
                <textarea
                  rows={5}
                  value={editCardDescription}
                  onChange={(e) => setEditCardDescription(e.target.value)}
                  placeholder="Task description (markdown supported)..."
                  className="w-full bg-muster-base border border-muster-border muster-text-primary font-sans text-xs rounded p-2.5 focus:border-brand-500 focus:outline-none resize-y"
                />
              </div>

              <div className="flex justify-end space-x-2 pt-1">
                <button
                  type="button"
                  onClick={isCreatingCard ? onClose : () => setIsEditingCard(false)}
                  className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 muster-text-secondary rounded text-xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!editCardTitle.trim() || (isCreatingCard && !newCardColumnId)}
                  className="muster-btn muster-btn-lg muster-btn-primary"
                >
                  {isCreatingCard ? 'Create Card' : 'Save Task'}
                </button>
              </div>
            </form>
          ) : (
            cardDetails && (
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold muster-text-primary">{cardDetails.title}</h3>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={onStartEditingCard}
                      className="p-1 text-neutral-500 hover:text-brand-400 transition-colors cursor-pointer"
                      title="Edit Title & Description"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div
                  className="markdown-render text-xs muster-text-secondary mt-2 bg-muster-surface p-3 rounded-lg border border-muster-border leading-relaxed overflow-x-auto [&>p:last-child]:mb-0"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(cardDetails.description, 'No description provided.') }}
                />
              </div>
            )
          )}

          {cardDetails && (
            <>
              {/* Assignees & Assign Control */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="text-xs font-semibold muster-text-muted uppercase mb-2">Assignees</h4>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {cardDetails.assignees.length > 0 ? (
                      cardDetails.assignees.map((agent) => (
                        <span key={agent.id} className="inline-flex items-center gap-1">
                          <PrincipalChip name={agent.name} kind={agent.kind} status={agent.status} />
                          <button
                            type="button"
                            onClick={() => onUnassignAgent(agent.id)}
                            className="muster-btn muster-btn-icon muster-btn-ghost-danger p-0.5"
                            title={`Remove ${agent.name} from card`}
                            aria-label={`Remove ${agent.name} from card`}
                          >
                            <X className="w-3 h-3" aria-hidden="true" />
                          </button>
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-neutral-500 italic">Unassigned</span>
                    )}
                  </div>

                  <div className="flex space-x-1.5">
                    <select
                      value={assignAgentId}
                      onChange={(e) => setAssignAgentId(e.target.value)}
                      className="muster-input text-xs py-1 flex-1"
                    >
                      <option value="">Assign to...</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.display_name}
                        </option>
                      ))}
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                    <button onClick={handleAssign} disabled={!assignAgentId} className="muster-btn muster-btn-primary">
                      Assign
                    </button>
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-semibold muster-text-muted uppercase mb-2">Labels</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {cardDetails.labels.length > 0 ? (
                      cardDetails.labels.map((label) => (
                        <span key={label.id} className="px-2 py-1 bg-muster-surface-hover muster-text-primary border border-muster-border text-xs rounded">
                          🏷️ {label.name}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs muster-text-muted italic">No labels</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Linked Documents */}
              <div>
                <h4 className="text-xs font-bold muster-text-secondary uppercase mb-3 flex items-center justify-between">
                  <span className="flex items-center">
                    <FileText className="w-4 h-4 mr-1.5 muster-text-warning" />
                    Linked Documents ({(cardDetails.linked_documents || []).length})
                  </span>
                  <span className="text-[10px] muster-text-muted font-normal">Click document to read</span>
                </h4>

                <div className="space-y-2 mb-3">
                  {(cardDetails.linked_documents || []).length > 0 ? (
                    cardDetails.linked_documents.map((doc) => (
                      <div
                        key={doc.id}
                        onClick={() => onOpenLinkedDocument(doc.id)}
                        aria-busy={loadingDocumentId === doc.id}
                        className="flex items-center justify-between bg-muster-surface p-2.5 rounded-lg border border-warning-500/20 hover:border-warning-500/60 hover:bg-muster-surface-hover group cursor-pointer transition-all"
                      >
                        <div className="flex items-center space-x-2 min-w-0">
                          <FileText className="w-3.5 h-3.5 muster-text-warning flex-shrink-0 group-hover:scale-110 transition-transform" />
                          <span className="text-xs font-sans muster-text-primary group-hover:text-warning-300 truncate font-semibold">
                            {doc.title}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 text-[10px] font-mono rounded flex-shrink-0 ${
                              doc.status === 'approved'
                                ? 'bg-success-950 muster-text-success border border-success-600/40'
                                : doc.status === 'in_review'
                                ? 'bg-warning-950 muster-text-warning border border-warning-600/40'
                                : 'bg-muster-surface-hover muster-text-muted border border-muster-border'
                            }`}
                          >
                            {doc.status}
                          </span>
                        </div>
                        <div className="flex items-center space-x-2 flex-shrink-0">
                          <span className="text-[11px] muster-text-warning font-medium opacity-80 group-hover:opacity-100 flex items-center">
                            {loadingDocumentId === doc.id ? (
                              'Loading…'
                            ) : (
                              <>
                                Read <Eye className="w-3 h-3 ml-1" />
                              </>
                            )}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onUnlinkDocument(doc.id);
                            }}
                            className="muster-btn muster-btn-icon muster-btn-ghost-danger opacity-0 group-hover:opacity-100"
                            title="Unlink document"
                          >
                            <Unlink className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs muster-text-muted italic">No documents linked to this card.</p>
                  )}
                </div>

                {documents.length > 0 && (
                  <div className="flex space-x-1.5">
                    <select
                      value={linkDocumentId}
                      onChange={(e) => setLinkDocumentId(e.target.value)}
                      className="muster-input text-xs py-1 flex-1"
                    >
                      <option value="">Link a document...</option>
                      {documents
                        .filter((d) => !(cardDetails.linked_documents || []).some((ld) => ld.id === d.id))
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.title}
                          </option>
                        ))}
                    </select>
                    <button onClick={handleLinkDoc} disabled={!linkDocumentId} className="muster-btn muster-btn-primary">
                      <Link2 className="w-3 h-3" />
                      <span>Link</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Linked Cards Section */}
              <CardRelationSection
                cardDetails={cardDetails}
                allCards={allCards}
                onOpenCard={onOpenCard}
                onLinkCard={onLinkCard}
                onUnlinkCard={onUnlinkCard}
              />

              {/* Work Links Section */}
              <WorkLinkSection
                cardDetails={cardDetails}
                onAddWorkLink={onAddWorkLink}
                onRemoveWorkLink={onRemoveWorkLink}
              />

              {/* Comments Section */}
              <div>
                <h4 className="text-xs font-bold muster-text-secondary uppercase mb-3 flex items-center">
                  <MessageSquare className="w-4 h-4 mr-1.5 muster-accent" />
                  Comments ({cardDetails.comments.length})
                </h4>

                <div className="space-y-3 mb-4">
                  {cardDetails.comments.map((c) => (
                    <div key={c.id} className="bg-muster-surface p-3 rounded-lg border border-muster-border space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-[11px] muster-text-muted">
                        <div className="flex items-center gap-2 min-w-0">
                          <PrincipalChip name={c.author_name || 'Unknown'} kind={c.author_kind || 'agent'} />
                          <span>{new Date(c.created_at).toLocaleString()}</span>
                        </div>
                        {canManageComment(c) && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              className="muster-btn muster-btn-icon muster-btn-ghost"
                              title="Edit comment"
                              disabled={savingCommentId === c.id}
                              onClick={() => {
                                setEditingCommentId(c.id);
                                setEditingCommentText(c.content);
                              }}
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              className="muster-btn muster-btn-icon muster-btn-ghost-danger"
                              title="Delete comment"
                              disabled={savingCommentId === c.id}
                              onClick={() => onDeleteComment(c.id)}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </div>
                      {editingCommentId === c.id ? (
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            setSavingCommentId(c.id);
                            await onUpdateComment(c.id, editingCommentText);
                            setEditingCommentId(null);
                            setSavingCommentId(null);
                          }}
                          className="space-y-2"
                        >
                          <textarea
                            autoFocus
                            rows={3}
                            value={editingCommentText}
                            onChange={(e) => setEditingCommentText(e.target.value)}
                            className="muster-input text-xs p-3 leading-relaxed w-full resize-y"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              className="muster-btn muster-btn-secondary"
                              onClick={() => setEditingCommentId(null)}
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              className="muster-btn muster-btn-primary"
                              disabled={!editingCommentText.trim() || savingCommentId === c.id}
                            >
                              {savingCommentId === c.id ? 'Saving…' : 'Save'}
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div
                          className="markdown-render text-xs muster-text-primary leading-relaxed overflow-x-auto [&>p:last-child]:mb-0"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(c.content) }}
                        />
                      )}
                    </div>
                  ))}
                </div>

                <form onSubmit={handleCommentSubmit} className="flex flex-col space-y-2">
                  {currentUser ? (
                    <div className="flex items-center space-x-1.5 text-[11px] muster-text-muted">
                      <span>Commenting as</span>
                      <PrincipalChip name={currentUser.display_name} kind="user" />
                    </div>
                  ) : (
                    <div className="flex space-x-2">
                      <select
                        value={selectedAuthorId}
                        onChange={(e) => setSelectedAuthorId(e.target.value)}
                        className="muster-input text-xs py-1.5 px-2.5"
                      >
                        <option value="">Select Author...</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.display_name}
                          </option>
                        ))}
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="flex space-x-2 items-start">
                    <textarea
                      rows={2}
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="Add comment (Markdown supported)..."
                      className="muster-input text-xs p-3 leading-relaxed flex-1 resize-y"
                    />
                    <button
                      type="submit"
                      disabled={!commentText.trim() || (!currentUser && !selectedAuthorId)}
                      className="muster-btn muster-btn-lg muster-btn-primary"
                    >
                      Comment
                    </button>
                  </div>
                </form>
              </div>
            </>
          )}
        </div>
    </AccessibleDialog>
  );
};
