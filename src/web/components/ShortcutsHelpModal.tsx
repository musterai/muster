// File: src/web/components/ShortcutsHelpModal.tsx
import React from 'react';
import { X, Keyboard } from 'lucide-react';
import { AccessibleDialog } from './AccessibleDialog.js';

interface ShortcutsHelpModalProps {
  onClose: () => void;
}

interface ShortcutItem {
  keys: string[];
  description: string;
  category: 'board' | 'global';
}

const SHORTCUTS: ShortcutItem[] = [
  { keys: ['←', '→'], description: 'Move selection between columns', category: 'board' },
  { keys: ['↑', '↓'], description: 'Move selection between cards in a column', category: 'board' },
  { keys: ['PgUp', 'PgDn'], description: 'Jump 5 cards up/down in a column', category: 'board' },
  { keys: ['Home', 'End'], description: 'Jump to first/last card in a column', category: 'board' },
  { keys: ['Enter'], description: 'Open selected card details', category: 'board' },
  { keys: ['Space', '↑', '↓'], description: 'Lift and reorder a focused card drag handle', category: 'board' },
  { keys: ['N', 'C'], description: 'Create new card in focused column', category: 'board' },
  { keys: ['Del'], description: 'Delete selected card', category: 'board' },
  { keys: ['/'], description: 'Focus quick card search box', category: 'global' },
  { keys: ['Esc'], description: 'Close any open modal or clear selection', category: 'global' },
  { keys: ['?'], description: 'Toggle keyboard shortcuts help', category: 'global' },
];

export const ShortcutsHelpModal: React.FC<ShortcutsHelpModalProps> = ({ onClose }) => {
  const boardShortcuts = SHORTCUTS.filter((s) => s.category === 'board');
  const globalShortcuts = SHORTCUTS.filter((s) => s.category === 'global');

  return (
    <AccessibleDialog
      onClose={onClose}
      titleId="shortcuts-dialog-title"
      descriptionId="shortcuts-dialog-description"
      className="w-full max-w-lg max-h-[85vh] overflow-y-auto mx-2 p-5 space-y-4 font-sans"
    >
        <div className="flex items-center justify-between border-b border-muster-border pb-3">
          <h2 id="shortcuts-dialog-title" className="text-sm font-bold muster-text-primary flex items-center">
            <Keyboard className="w-4 h-4 mr-2 muster-accent" /> Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="muster-btn muster-btn-icon muster-btn-ghost muster-touch-target"
            aria-label="Close keyboard shortcuts"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Board Shortcuts */}
        <div className="space-y-2">
          <h4 className="text-xs font-bold muster-text-secondary uppercase tracking-wider">
            Board & Card Navigation
          </h4>
          <div className="grid grid-cols-1 gap-2">
            {boardShortcuts.map((s, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between bg-muster-surface p-2.5 rounded-lg border border-muster-border"
              >
                <span className="text-xs muster-text-primary">{s.description}</span>
                <div className="flex items-center space-x-1">
                  {s.keys.map((k, kIdx) => (
                    <kbd
                      key={kIdx}
                      className="px-2 py-0.5 text-xs font-mono bg-muster-surface-hover muster-text-primary border border-muster-border rounded shadow-sm font-semibold"
                    >
                      {k}
                    </kbd>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Global Shortcuts */}
        <div className="space-y-2 pt-2">
          <h4 className="text-xs font-bold muster-text-secondary uppercase tracking-wider">
            Global Shortcuts
          </h4>
          <div className="grid grid-cols-1 gap-2">
            {globalShortcuts.map((s, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between bg-muster-surface p-2.5 rounded-lg border border-muster-border"
              >
                <span className="text-xs muster-text-primary">{s.description}</span>
                <div className="flex items-center space-x-1">
                  {s.keys.map((k, kIdx) => (
                    <kbd
                      key={kIdx}
                      className="px-2 py-0.5 text-xs font-mono bg-muster-surface-hover muster-text-primary border border-muster-border rounded shadow-sm font-semibold"
                    >
                      {k}
                    </kbd>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="pt-2 text-center border-t border-muster-border">
          <p id="shortcuts-dialog-description" className="text-[11px] muster-text-muted">
            Press <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muster-surface-hover muster-text-primary border border-muster-border rounded">?</kbd> anytime to open this guide.
          </p>
        </div>
    </AccessibleDialog>
  );
};
