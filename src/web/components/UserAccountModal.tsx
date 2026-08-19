import React, { useState, useEffect, useRef } from 'react';
import { AuthMe, User as UserType } from '../types.js';
import { api } from '../api.js';
import { ThemePicker } from './ThemePicker.js';
import { TokensView } from './TokensView.js';
import { WorkspaceAdmin } from './WorkspaceAdmin.js';
import { PrincipalChip } from './PrincipalChip.js';
import { X, User, Palette, KeyRound, ShieldCheck, UserCircle, Check, Trash2 } from 'lucide-react';
import { AccessibleDialog } from './AccessibleDialog.js';

type AccountTab = 'appearance' | 'tokens' | 'admin' | 'profile';

interface UserAccountModalProps {
  currentUser: AuthMe['user'] | null;
  workspaceId: string | null;
  authMode?: AuthMe['auth_mode'] | null;
  onClose: () => void;
  onSetLocalIdentity?: (identity: string | { displayName?: string; userId?: string }) => Promise<void>;
  initialTab?: AccountTab;
}

export const UserAccountModal: React.FC<UserAccountModalProps> = ({
  currentUser,
  workspaceId,
  authMode,
  onClose,
  onSetLocalIdentity,
  initialTab = 'appearance',
}) => {
  const [activeTab, setActiveTab] = useState<AccountTab>(initialTab);
  const [name, setName] = useState(currentUser?.display_name || '');
  const [saving, setSaving] = useState(false);
  const [existingUsers, setExistingUsers] = useState<UserType[]>([]);
  const tabRefs = useRef<Partial<Record<AccountTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (activeTab === 'profile' && authMode === 'open') {
      api.getUsers().then(setExistingUsers).catch(console.error);
    }
  }, [activeTab, authMode]);

  const displayName = currentUser?.display_name || 'Operator';
  const accountTabs: Array<{ id: AccountTab; label: string; icon: React.ElementType }> = [
    { id: 'appearance', label: 'Appearance & Theme', icon: Palette },
    { id: 'tokens', label: 'API Tokens', icon: KeyRound },
    ...(workspaceId ? [{ id: 'admin' as const, label: 'Workspace Admin', icon: ShieldCheck }] : []),
    ...(authMode === 'open' && onSetLocalIdentity
      ? [{ id: 'profile' as const, label: 'Switch User & Profile', icon: UserCircle }]
      : []),
  ];

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: AccountTab) => {
    const currentIndex = accountTabs.findIndex((tab) => tab.id === current);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % accountTabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + accountTabs.length) % accountTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = accountTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = accountTabs[nextIndex].id;
    tabRefs.current[next]?.focus();
    setActiveTab(next);
  };

  const handleSelectUser = async (u: UserType) => {
    if (!onSetLocalIdentity || saving) return;
    setSaving(true);
    try {
      await onSetLocalIdentity({ userId: u.id, displayName: u.display_name });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteUser = async (u: UserType) => {
    if (!workspaceId || saving) return;
    if (!confirm(`Delete user "${u.display_name}"?`)) return;
    setSaving(true);
    try {
      await api.removeMember(workspaceId, u.id);
      const updated = await api.getUsers();
      setExistingUsers(updated);
    } catch (err) {
      console.error('Failed to remove member:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AccessibleDialog
      onClose={onClose}
      titleId="account-dialog-title"
      descriptionId="account-dialog-description"
      className="w-full max-w-3xl max-h-[85vh] flex flex-col font-sans overflow-hidden"
    >
        {/* Header */}
        <div className="p-4 border-b border-muster-border flex items-center justify-between bg-muster-surface">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-full bg-brand-500/10 border border-brand-500/30 flex items-center justify-center shrink-0">
              <User className="w-5 h-5 muster-accent" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 id="account-dialog-title" className="text-sm font-bold muster-text-primary">{displayName}</h2>
                <PrincipalChip name={displayName} kind="user" />
              </div>
              <p id="account-dialog-description" className="text-[11px] muster-text-muted">Account Preferences & Workspace Settings</p>
            </div>
          </div>

          <button onClick={onClose} className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target" aria-label="Close account settings">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Navigation Tabs */}
        <div role="tablist" aria-label="Account settings sections" className="flex border-b border-muster-border/80 px-4 bg-muster-surface/60 overflow-x-auto no-scrollbar">
          {accountTabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              id={`account-tab-${id}`}
              ref={(element) => { tabRefs.current[id] = element; }}
              role="tab"
              tabIndex={activeTab === id ? 0 : -1}
              aria-selected={activeTab === id}
              aria-controls={`account-panel-${id}`}
              onKeyDown={(event) => handleTabKeyDown(event, id)}
              onClick={() => setActiveTab(id)}
              className={`muster-account-tab px-3 py-2 text-xs font-medium border-b-2 inline-flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer ${
                activeTab === id
                  ? 'border-brand-500 muster-accent font-semibold'
                  : 'border-transparent muster-text-muted hover:muster-text-primary'
              }`}
            >
              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Tab Body Content */}
        <div id={`account-panel-${activeTab}`} role="tabpanel" aria-labelledby={`account-tab-${activeTab}`} className="p-5 overflow-y-auto flex-1">
          {activeTab === 'appearance' && (
            <ThemePicker />
          )}

          {activeTab === 'tokens' && (
            <TokensView />
          )}

          {activeTab === 'admin' && workspaceId && (
            <WorkspaceAdmin workspaceId={workspaceId} currentUser={currentUser} authMode={authMode} />
          )}

          {activeTab === 'profile' && authMode === 'open' && onSetLocalIdentity && (
            <div className="space-y-6 max-w-md">
              {/* Existing Users Selection */}
              {existingUsers.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold muster-text-secondary uppercase tracking-wider mb-2">
                    Switch to Existing User
                  </h3>
                  <div className="space-y-1.5">
                    {existingUsers.map((u) => {
                      const isCurrent = currentUser?.id === u.id;
                      return (
                        <div
                          key={u.id}
                          className={`flex items-center justify-between p-2.5 rounded-lg border text-xs transition-colors ${
                            isCurrent
                              ? 'bg-brand-500/10 border-brand-500/30'
                              : 'bg-muster-surface border-muster-border hover:border-brand-500/40'
                          }`}
                        >
                          <div className="flex items-center space-x-2">
                            <PrincipalChip name={u.display_name} kind="user" />
                            {isCurrent && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/20 muster-accent font-medium">
                                Current Active
                              </span>
                            )}
                          </div>
                          {!isCurrent && (
                            <div className="flex items-center space-x-1.5">
                              <button
                                type="button"
                                onClick={() => handleSelectUser(u)}
                                disabled={saving}
                                className="muster-btn muster-btn-soft text-xs py-1 px-2.5"
                              >
                                Switch
                              </button>
                              {workspaceId && (
                                <button
                                  type="button"
                                  onClick={() => handleDeleteUser(u)}
                                  disabled={saving}
                                  title="Delete user"
                                  className="muster-btn muster-btn-icon muster-btn-ghost-danger py-1 px-1.5"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Create or Re-claim New Display Name */}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const trimmed = name.trim();
                  if (!trimmed || saving) return;
                  setSaving(true);
                  try {
                    await onSetLocalIdentity(trimmed);
                    onClose();
                  } finally {
                    setSaving(false);
                  }
                }}
                className="space-y-3 pt-2 border-t border-muster-border/60"
              >
                <div>
                  <label className="muster-label">
                    {existingUsers.length > 0 ? 'Or Set / Create Display Name' : 'Local Display Name'}
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your display name"
                    className="muster-input muster-input-lg"
                  />
                  <p className="text-[11px] muster-text-muted mt-1">
                    Entering an existing display name will re-bind your session to that user.
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={!name.trim() || saving}
                  className="muster-btn muster-btn-primary"
                >
                  {saving ? 'Saving…' : 'Save / Switch Name'}
                </button>
              </form>
            </div>
          )}
        </div>
    </AccessibleDialog>
  );
};
