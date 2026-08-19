import React, { useState } from 'react';
import { Role, Invitation } from '../../types.js';
import { api, ApiError } from '../../api.js';
import { Mail, Trash2, Copy, Check } from 'lucide-react';
import { AccessibleDialog } from '../AccessibleDialog.js';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

interface InvitationsPanelProps {
  workspaceId: string;
  roles: Role[];
  invitations: Invitation[];
  onChange: () => void;
  onError: (msg: string) => void;
}

export const InvitationsPanel: React.FC<InvitationsPanelProps> = ({
  workspaceId,
  roles,
  invitations,
  onChange,
  onError,
}) => {
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [invited, setInvited] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name || id;
  const signInUrl = `${window.location.origin}/`;

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !roleId) return;
    setSubmitting(true);
    try {
      await api.createInvitation(workspaceId, email.trim(), roleId);
      setInvited(email.trim());
      setEmail('');
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Failed to create invitation');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async (invitation: Invitation) => {
    if (!confirm(`Revoke the invitation for ${invitation.email}?`)) return;
    try {
      await api.revokeInvitation(invitation.id);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Failed to revoke invitation');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(signInUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the URL is still selectable text.
    }
  };

  const isExpired = (i: Invitation) => new Date(i.expires_at) <= new Date();

  return (
    <div className="space-y-4">
      <form onSubmit={handleInvite} className="flex items-end gap-2 bg-muster-surface p-3 rounded-lg tactical-border">
        <div className="flex-1">
          <label className="muster-label uppercase">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            className="muster-input"
          />
        </div>
        <div>
          <label className="muster-label uppercase">Role</label>
          <select
            required
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            className="muster-input font-mono cursor-pointer"
          >
            <option value="">Select role…</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={submitting} className="muster-btn muster-btn-primary">
          <Mail className="w-3.5 h-3.5 mr-1.5" /> Invite
        </button>
      </form>

      {invitations.length === 0 ? (
        <div className="text-center py-16 bg-muster-surface rounded-lg tactical-border">
          <Mail className="w-12 h-12 muster-text-faint mx-auto mb-3" />
          <h3 className="text-sm font-sans muster-text-secondary font-semibold">No Invitations Yet</h3>
        </div>
      ) : (
        <div className="w-full overflow-x-auto no-scrollbar">
          <table className="w-full text-xs font-sans border-collapse">
            <thead>
              <tr className="border-b border-muster-border muster-text-muted uppercase text-[10px] tracking-wide">
                <th className="text-left py-2 pr-4 font-semibold">Email</th>
                <th className="text-left py-2 pr-4 font-semibold">Role</th>
                <th className="text-left py-2 pr-4 font-semibold">Expires</th>
                <th className="text-left py-2 pr-4 font-semibold">Status</th>
                <th className="text-right py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((i) => (
                <tr key={i.id} className="border-b border-muster-border/60">
                  <td className="py-2.5 pr-4 muster-text-primary font-medium">{i.email}</td>
                  <td className="py-2.5 pr-4 muster-text-secondary">{roleName(i.role_id)}</td>
                  <td className="py-2.5 pr-4 muster-text-muted">{formatDate(i.expires_at)}</td>
                  <td className="py-2.5 pr-4">
                    {i.accepted_at ? (
                      <span className="muster-badge muster-badge-success">Accepted</span>
                    ) : isExpired(i) ? (
                      <span className="muster-badge muster-badge-neutral">Expired</span>
                    ) : (
                      <span className="muster-badge muster-badge-warning">Pending</span>
                    )}
                  </td>
                  <td className="py-2.5 text-right">
                    {!i.accepted_at && (
                      <button onClick={() => handleRevoke(i)} title="Revoke invitation" className="muster-btn muster-btn-icon muster-btn-ghost-danger">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {invited && (
        <AccessibleDialog
          onClose={() => { setInvited(null); setCopied(false); }}
          titleId="invitation-created-title"
          descriptionId="invitation-created-description"
          closeOnBackdrop={false}
          className="w-full max-w-lg p-6 space-y-4"
        >
            <div className="flex items-center space-x-2 border-b border-muster-border pb-3">
              <Mail className="w-5 h-5 muster-text-warning" />
              <h2 id="invitation-created-title" className="text-base font-bold muster-text-primary uppercase tracking-wide">Invitation Created</h2>
            </div>
            <p id="invitation-created-description" className="text-xs muster-text-muted">
              No email is sent yet — tell <span className="font-semibold muster-text-primary">{invited}</span> to sign in at the URL below with an
              identity provider account using that exact email address. They are admitted automatically on their first login; no separate link or
              code is needed.
            </p>
            <div className="flex items-center gap-2 bg-muster-base border border-muster-border rounded-md px-3 py-2">
              <code className="flex-1 font-mono text-xs muster-text-primary break-all select-all">{signInUrl}</code>
              <button data-dialog-initial-focus onClick={handleCopy} className="muster-btn muster-btn-icon muster-btn-ghost" title="Copy to clipboard" aria-label="Copy sign-in URL to clipboard">
                {copied ? <Check className="w-4 h-4 muster-text-success" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex justify-end pt-3 border-t border-muster-border">
              <button
                onClick={() => {
                  setInvited(null);
                  setCopied(false);
                }}
                className="muster-btn muster-btn-lg muster-btn-primary"
              >
                Done
              </button>
            </div>
        </AccessibleDialog>
      )}
    </div>
  );
};
