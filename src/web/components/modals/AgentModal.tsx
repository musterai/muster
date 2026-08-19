import React, { useState } from 'react';
import { X, UserPlus, AlertCircle } from 'lucide-react';
import { api } from '../../api.js';
import { useEscapeKey } from './useEscapeKey.js';

interface NewAgentModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export const NewAgentModal: React.FC<NewAgentModalProps> = ({ onClose, onSuccess }) => {
  useEscapeKey(onClose);
  const [name, setName] = useState('');
  const [capabilities, setCapabilities] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await api.registerAgent({
        name: name.trim(),
        ...(capabilities.trim() ? { capabilities: capabilities.trim() } : {}),
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('Failed to register agent:', err);
      setError(err.message || 'Failed to register agent.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="muster-scrim">
      <div className="muster-dialog w-full max-w-md max-h-[90vh] overflow-y-auto mx-2 p-4 sm:p-5 space-y-4 font-sans">
        <div className="flex items-center justify-between border-b border-muster-border pb-3">
          <h3 className="text-sm font-bold muster-text-primary flex items-center">
            <UserPlus className="w-4 h-4 mr-2 muster-accent" /> Register Agent
          </h3>
          <button onClick={onClose} className="muster-btn muster-btn-icon muster-btn-ghost">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="muster-badge muster-badge-danger normal-case tracking-normal text-xs p-3 w-full">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="p-3 bg-muster-base border border-muster-border rounded-md text-[11px] muster-text-muted">
          💡 <span className="font-semibold muster-text-primary">Note:</span> This registers an AI agent. AI agents (Claude, Cursor, Antigravity) usually register themselves programmatically over MCP — use this form only for a manual/offline registration. Humans join the workspace via invitation and sign-in, never through agent registration.
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label className="muster-label">Agent Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. my-agent"
              className="muster-input muster-input-lg"
            />
          </div>

          <div>
            <label className="muster-label">Capabilities (comma-separated)</label>
            <input
              type="text"
              value={capabilities}
              onChange={(e) => setCapabilities(e.target.value)}
              placeholder="e.g. code, testing, architecture"
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
              disabled={isSubmitting}
              className="muster-btn muster-btn-primary"
            >
              {isSubmitting ? 'Adding...' : 'Add User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
