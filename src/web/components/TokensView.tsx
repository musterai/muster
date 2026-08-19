// File: src/web/components/TokensView.tsx
//
// Personal Access Token management UI (MUS-24).
// List, mint (secret shown once), and revoke bearer tokens for the
// authenticated principal.

import React, { useEffect, useState, useCallback } from 'react';
import { ApiToken } from '../types.js';
import { api, ApiError } from '../api.js';
import { KeyRound, Plus, Trash2, X, Copy, Check, ShieldAlert } from 'lucide-react';
import { AccessibleDialog } from './AccessibleDialog.js';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export const TokensView: React.FC = () => {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newExpiry, setNewExpiry] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // The plaintext secret is held only transiently, in memory, and never persisted.
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadTokens = useCallback(async () => {
    try {
      const list = await api.getTokens();
      setTokens(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load tokens');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setIsCreating(true);
    try {
      const created = await api.createToken({
        name: newName.trim(),
        expires_at: newExpiry ? new Date(newExpiry).toISOString() : null,
      });
      setShowCreateModal(false);
      setNewName('');
      setNewExpiry('');
      setRevealedSecret(created.token);
      await loadTokens();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create token');
    } finally {
      setIsCreating(false);
    }
  };

  const handleRevoke = async (token: ApiToken) => {
    if (!confirm(`Revoke token "${token.name}"? Any client using it will be refused on its next request.`)) return;
    try {
      await api.revokeToken(token.id);
      await loadTokens();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke token');
    }
  };

  const handleCopy = async () => {
    if (!revealedSecret) return;
    try {
      await navigator.clipboard.writeText(revealedSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the secret is still selectable text.
    }
  };

  const isExpired = (t: ApiToken) => !!t.expires_at && new Date(t.expires_at) <= new Date();

  return (
    <div className="flex flex-col flex-1 h-full min-h-0 font-sans space-y-6">

      {/* Header */}
      <div className="flex-none flex items-center justify-between border-b border-muster-border pb-4">
        <div>
          <h2 className="text-lg font-sans font-bold muster-text-primary flex items-center">
            <KeyRound className="w-5 h-5 mr-2 muster-accent" />
            Personal Access Tokens
          </h2>
          <p className="text-xs font-sans muster-text-muted mt-0.5">
            Bearer tokens for local clients and directly-connected agents
          </p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="muster-btn muster-btn-primary">
          <Plus className="w-3.5 h-3.5 mr-1.5" /> New Token
        </button>
      </div>

      {error && (
        <div className="muster-badge muster-badge-danger w-fit">{error}</div>
      )}

      {/* Table */}
      {loading ? (
        <div className="text-center py-16 muster-text-muted text-sm">Loading tokens…</div>
      ) : tokens.length === 0 ? (
        <div className="text-center py-16 bg-muster-surface rounded-lg tactical-border">
          <KeyRound className="w-12 h-12 muster-text-faint mx-auto mb-3" />
          <h3 className="text-sm font-sans muster-text-secondary font-semibold">No Tokens Yet</h3>
          <p className="text-xs font-sans text-neutral-500 max-w-sm mx-auto mt-1 mb-4">
            Create a token to authenticate a local client or agent over the API.
          </p>
          <button onClick={() => setShowCreateModal(true)} className="muster-btn muster-btn-lg muster-btn-primary">
            New Token
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0 pr-1">
          <table className="w-full text-xs font-sans border-collapse">
            <thead>
              <tr className="border-b border-muster-border muster-text-muted uppercase text-[10px] tracking-wide">
                <th className="text-left py-2 pr-4 font-semibold">Name</th>
                <th className="text-left py-2 pr-4 font-semibold">Prefix</th>
                <th className="text-left py-2 pr-4 font-semibold">Created</th>
                <th className="text-left py-2 pr-4 font-semibold">Last Used</th>
                <th className="text-left py-2 pr-4 font-semibold">Expires</th>
                <th className="text-left py-2 pr-4 font-semibold">Status</th>
                <th className="text-right py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-b border-muster-border/60">
                  <td className="py-2.5 pr-4 muster-text-primary font-medium">{t.name}</td>
                  <td className="py-2.5 pr-4 font-mono muster-text-secondary">{TOKEN_BRAND_DISPLAY}{t.prefix}…</td>
                  <td className="py-2.5 pr-4 muster-text-muted">{formatDate(t.created_at)}</td>
                  <td className="py-2.5 pr-4 muster-text-muted">{formatDate(t.last_used_at)}</td>
                  <td className="py-2.5 pr-4 muster-text-muted">{formatDate(t.expires_at)}</td>
                  <td className="py-2.5 pr-4">
                    {t.revoked_at ? (
                      <span className="muster-badge muster-badge-danger">Revoked</span>
                    ) : isExpired(t) ? (
                      <span className="muster-badge muster-badge-warning">Expired</span>
                    ) : (
                      <span className="muster-badge muster-badge-success">Active</span>
                    )}
                  </td>
                  <td className="py-2.5 text-right">
                    {!t.revoked_at && (
                      <button
                        onClick={() => handleRevoke(t)}
                        title="Revoke token"
                        className="muster-btn muster-btn-icon muster-btn-ghost-danger"
                      >
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

      {/* Create Token Modal */}
      {showCreateModal && (
        <AccessibleDialog onClose={() => setShowCreateModal(false)} titleId="new-token-title" className="w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-muster-border pb-3">
              <div className="flex items-center space-x-2">
                <KeyRound className="w-5 h-5 muster-accent" />
                <h2 id="new-token-title" className="text-base font-bold muster-text-primary uppercase tracking-wide">New Token</h2>
              </div>
              <button onClick={() => setShowCreateModal(false)} className="muster-btn muster-btn-icon muster-btn-ghost" aria-label="Close new token dialog">
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label htmlFor="new-token-name" className="muster-label uppercase">Name</label>
                <input
                  id="new-token-name"
                  data-dialog-initial-focus
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="muster-input muster-input-lg"
                  placeholder="e.g. Laptop CLI"
                />
              </div>

              <div>
                <label htmlFor="new-token-expiry" className="muster-label uppercase">Expiry (optional)</label>
                <input
                  id="new-token-expiry"
                  type="datetime-local"
                  value={newExpiry}
                  onChange={(e) => setNewExpiry(e.target.value)}
                  className="muster-input font-mono"
                />
                <p className="text-[11px] text-neutral-500 mt-1">Leave blank for a token that never expires.</p>
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-muster-border">
                <button type="button" onClick={() => setShowCreateModal(false)} className="muster-btn muster-btn-lg muster-btn-secondary">
                  Cancel
                </button>
                <button type="submit" disabled={isCreating} className="muster-btn muster-btn-lg muster-btn-primary">
                  {isCreating ? 'Creating…' : 'Create Token'}
                </button>
              </div>
            </form>
        </AccessibleDialog>
      )}

      {/* Reveal-once secret modal */}
      {revealedSecret && (
        <AccessibleDialog
          onClose={() => { setRevealedSecret(null); setCopied(false); }}
          titleId="token-created-title"
          descriptionId="token-created-description"
          closeOnBackdrop={false}
          className="w-full max-w-lg p-6 space-y-4"
        >
            <div className="flex items-center space-x-2 border-b border-muster-border pb-3">
              <ShieldAlert className="w-5 h-5 muster-text-warning" />
              <h2 id="token-created-title" className="text-base font-bold muster-text-primary uppercase tracking-wide">Token Created</h2>
            </div>

            <p id="token-created-description" className="text-xs muster-text-muted">
              Copy this token now. <span className="font-semibold muster-text-warning">You will not be able to see it again.</span>
            </p>

            <div className="flex items-center gap-2 bg-muster-base border border-muster-border rounded-md px-3 py-2">
              <code className="flex-1 font-mono text-xs muster-text-primary break-all select-all">{revealedSecret}</code>
              <button data-dialog-initial-focus onClick={handleCopy} className="muster-btn muster-btn-icon muster-btn-ghost" title="Copy to clipboard" aria-label="Copy token to clipboard">
                {copied ? <Check className="w-4 h-4 muster-text-success" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            <div className="flex justify-end pt-3 border-t border-muster-border">
              <button onClick={() => { setRevealedSecret(null); setCopied(false); }} className="muster-btn muster-btn-lg muster-btn-primary">
                Done — I've saved it
              </button>
            </div>
        </AccessibleDialog>
      )}

    </div>
  );
};

const TOKEN_BRAND_DISPLAY = 'muster_pat_';
