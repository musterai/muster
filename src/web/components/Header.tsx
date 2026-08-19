import React, { useState } from 'react';
import { Project, ProjectSummary, AuthMe } from '../types.js';
import { Bot, Layout, FileText, Activity, Plus, FolderPlus, Layers, Database, UserPlus, Trash2, Edit2, KeyRound, ShieldCheck, UserCircle, HelpCircle, Bell, BellRing, BellOff } from 'lucide-react';
import { ThemePicker } from './ThemePicker.js';
import { PrincipalChip } from './PrincipalChip.js';

type TabId = 'agents' | 'board' | 'docs' | 'activity' | 'kb' | 'tokens' | 'admin';

interface HeaderProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onOpenEditProject?: () => void;
  summary: ProjectSummary | null;
  activeBoardNotDoneCount?: number | null;
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  onOpenNewProject: () => void;
  onOpenNewBoard: () => void;
  onOpenRegisterAgent: () => void;
  onOpenNewCard: () => void;
  onOpenNewDoc: () => void;
  currentUser?: AuthMe['user'] | null;
  authMode?: AuthMe['auth_mode'] | null;
  onSetLocalIdentity?: (identity: string | { displayName?: string; userId?: string }) => Promise<void>;
  onOpenUserAccount?: (tab?: 'appearance' | 'tokens' | 'admin' | 'profile') => void;
  onOpenShortcutsHelp?: () => void;
  /** MUS-45: browser-notification permission for card-completion alerts. */
  notificationState?: 'granted' | 'denied' | 'default' | 'unsupported';
  onNotificationToggle?: () => void;
}

/** Open-mode-only "who are you" control — sits where a signed-in user's chip would go. */
const IdentityPicker: React.FC<{ onSubmit: (displayName: string) => Promise<void> }> = ({ onSubmit }) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="muster-btn muster-btn-ghost muster-touch-target font-sans text-xs"
        title="Set your name so comments and assignments show who you are"
      >
        <UserCircle className="w-3.5 h-3.5 muster-accent" /> Who are you?
      </button>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || saving) return;
        setSaving(true);
        try {
          await onSubmit(trimmed);
          setOpen(false);
        } finally {
          setSaving(false);
        }
      }}
      className="flex items-center space-x-1.5"
    >
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name"
        autoFocus
        className="muster-input text-xs py-1 px-2 w-36"
      />
      <button
        type="submit"
        disabled={!name.trim() || saving}
        className="muster-btn muster-btn-primary text-xs py-1 px-2"
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="muster-btn muster-btn-ghost text-xs py-1 px-2"
      >
        Cancel
      </button>
    </form>
  );
};

/** Vertical rule between header groups. Decorative, so it carries no text. */
const Divider: React.FC = () => (
  <span className="muster-divider w-px h-4 shrink-0" aria-hidden="true" />
);

/** Small dot separator in the telemetry strip. */
const Dot: React.FC = () => (
  <span className="muster-divider w-1 h-1 rounded-full shrink-0" aria-hidden="true" />
);

export const Header: React.FC<HeaderProps> = ({
  projects,
  selectedProjectId,
  onSelectProject,
  onDeleteProject,
  onOpenEditProject,
  summary,
  activeBoardNotDoneCount,
  activeTab,
  onSelectTab,
  onOpenNewProject,
  onOpenNewBoard,
  onOpenRegisterAgent,
  onOpenNewCard,
  onOpenNewDoc,
  currentUser,
  authMode,
  onSetLocalIdentity,
  onOpenUserAccount,
  onOpenShortcutsHelp,
  notificationState,
  onNotificationToggle,
}) => {
  const kanbanCount = activeBoardNotDoneCount !== undefined && activeBoardNotDoneCount !== null
    ? activeBoardNotDoneCount
    : summary?.not_done_card_count ?? summary?.card_count;

  const tabs: { id: TabId; icon: React.ElementType; label: string }[] = [
    { id: 'board', icon: Layout, label: `Kanban Board ${kanbanCount !== undefined ? `(${kanbanCount})` : ''}` },
    { id: 'docs', icon: FileText, label: `Design Documents ${summary ? `(${summary.document_count})` : ''}` },
    { id: 'kb', icon: Database, label: 'Knowledge Base' },
    { id: 'activity', icon: Activity, label: 'Activity Log' },
    { id: 'agents', icon: Bot, label: `Agents ${summary ? `(${summary.active_agent_count}/${summary.agent_count})` : ''}` },
  ];

  return (
    <header className="bg-muster-surface border-b border-muster-border sticky top-0 z-40 backdrop-blur-md w-full">
      <div className="w-full px-3 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14 gap-2">

          {/* Left Side: Brand & Project Selector */}
          <div className="flex items-center space-x-2 sm:space-x-4 min-w-0">

            {/* Logo */}
            <div className="flex items-center space-x-2 shrink-0">
              <div
                className="w-8 h-8 shrink-0 rounded-md muster-accent-bg border muster-accent flex items-center justify-center"
              >
                <svg viewBox="0 0 32 32" className="w-6 h-6 muster-accent" fill="none" role="img" aria-label="Muster logo">
                  <title>Muster logo</title>
                  <path d="M6 23V9l10 10L26 9v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <circle cx="6" cy="23" r="2.5" fill="currentColor" />
                  <circle cx="6" cy="9" r="2.5" fill="currentColor" />
                  <circle cx="16" cy="19" r="2.5" fill="currentColor" />
                  <circle cx="26" cy="9" r="2.5" fill="currentColor" />
                  <circle cx="26" cy="23" r="2.5" fill="currentColor" />
                </svg>
              </div>
            </div>

            {/* Project Selector Dropdown */}
            <div className="flex items-center space-x-1 min-w-0">
              <select
                value={selectedProjectId || ''}
                onChange={(e) => onSelectProject(e.target.value)}
                className="muster-input muster-touch-target max-w-[140px] sm:max-w-[220px] font-sans font-medium cursor-pointer truncate text-xs sm:text-sm py-1.5 px-2"
                aria-label="Select active project"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id} className="bg-muster-surface muster-text-primary">
                    {p.name}
                  </option>
                ))}
              </select>

              {/* Desktop Project Actions */}
              <div className="hidden lg:flex items-center space-x-1">
                {selectedProjectId && projects.length > 0 && onOpenEditProject && (
                  <button
                    onClick={onOpenEditProject}
                    className="muster-btn muster-btn-icon muster-btn-ghost"
                    title="Edit Selected Project Details"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  onClick={onOpenNewProject}
                  className="muster-btn muster-btn-soft font-sans text-xs"
                  title="Create New Project"
                >
                  <FolderPlus className="w-3.5 h-3.5" /> + Project
                </button>
              </div>
            </div>

          </div>

          {/* Right Side: Card-Completion Notifications, Keyboard Shortcuts Help & User Account Button at Top Right */}
          <div className="flex items-center space-x-2 shrink-0">
            {onNotificationToggle && (() => {
              const bell =
                notificationState === 'granted'
                  ? { Icon: BellRing, title: 'Browser notifications are on for card completions', active: true }
                  : notificationState === 'denied'
                    ? { Icon: BellOff, title: 'Browser notifications are blocked — allow them in your browser site settings', active: false }
                    : notificationState === 'unsupported'
                      ? { Icon: BellOff, title: 'This browser does not support notifications', active: false }
                      : { Icon: Bell, title: 'Enable browser notifications when cards reach Done', active: false };
              return (
                <button
                  onClick={onNotificationToggle}
                  className="muster-touch-target inline-flex items-center justify-center rounded-md hover:bg-muster-surface-hover border border-muster-border/60 text-xs cursor-pointer transition-colors muster-text-muted hover:muster-text-primary"
                  title={bell.title}
                  aria-label={bell.title}
                >
                  <bell.Icon className={`w-4 h-4 ${bell.active ? 'muster-accent' : ''}`} />
                </button>
              );
            })()}

            {onOpenShortcutsHelp && (
              <button
                onClick={onOpenShortcutsHelp}
                className="muster-touch-target inline-flex items-center justify-center rounded-md hover:bg-muster-surface-hover border border-muster-border/60 text-xs font-mono font-bold cursor-pointer transition-colors muster-text-muted hover:muster-text-primary"
                title="Keyboard Shortcuts & Help (?)"
                aria-label="Keyboard shortcuts"
              >
                <HelpCircle className="w-4 h-4 muster-accent" />
              </button>
            )}

            {currentUser ? (
              <button
                onClick={() => onOpenUserAccount?.('appearance')}
                className="muster-touch-target inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-muster-surface-hover border border-muster-border/60 text-xs font-sans font-semibold cursor-pointer transition-colors"
                title="Account Settings & Appearance"
              >
                <PrincipalChip name={currentUser.display_name} kind="user" />
              </button>
            ) : authMode === 'open' && onSetLocalIdentity ? (
              <button
                onClick={() => onOpenUserAccount?.('profile')}
                className="muster-touch-target inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-muster-surface-hover border border-muster-border/60 text-xs font-sans font-semibold cursor-pointer transition-colors"
                title="Account & Identity Settings"
              >
                <UserCircle className="w-4 h-4 muster-accent" />
                <span className="muster-text-primary text-xs font-medium">Set Name</span>
              </button>
            ) : (
              <button
                onClick={() => onOpenUserAccount?.('appearance')}
                className="muster-btn muster-btn-secondary muster-touch-target text-xs"
                title="Account & Appearance Settings"
              >
                <UserCircle className="w-4 h-4 muster-accent" />
                <span>Account</span>
              </button>
            )}
          </div>

        </div>

        {/* Sub-Navigation Bar — Shown on desktop (≥768px) where bottom bar is hidden */}
        <div className="hidden md:flex items-center border-t border-muster-border/60 py-1.5 w-full">
          <nav aria-label="Primary workspace navigation" className="flex flex-wrap items-center gap-1.5 py-0.5 w-full">
            {tabs.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => onSelectTab(id)}
                aria-current={activeTab === id ? 'page' : undefined}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-sans font-medium muster-tab shrink-0 whitespace-nowrap ${
                  activeTab === id ? 'muster-tab-active' : ''
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </div>

      </div>
    </header>
  );
};
