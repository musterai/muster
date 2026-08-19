import React, { useState } from 'react';
import { CardDetails, CardWorkLinkKind, CardWorkLinkProvider } from '../../types.js';
import { GitCommit, ExternalLink, Unlink, Plus } from 'lucide-react';
import {
  WORK_LINK_KIND_ICONS,
  WORK_LINK_KIND_LABELS,
  WORK_LINK_KIND_ORDER,
  WORK_LINK_PROVIDER_LABELS,
} from '../../utils/card-helpers.js';

interface WorkLinkSectionProps {
  cardDetails: CardDetails;
  onAddWorkLink: (data: { kind: CardWorkLinkKind; provider: CardWorkLinkProvider; url: string; external_ref?: string }) => Promise<void>;
  onRemoveWorkLink: (linkId: string) => Promise<void>;
}

export const WorkLinkSection: React.FC<WorkLinkSectionProps> = ({
  cardDetails,
  onAddWorkLink,
  onRemoveWorkLink,
}) => {
  const [kind, setKind] = useState<CardWorkLinkKind>('branch');
  const [provider, setProvider] = useState<CardWorkLinkProvider>('forgejo');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await onAddWorkLink({
        kind,
        provider,
        url: url.trim(),
        external_ref: ref.trim() || undefined,
      });
      setUrl('');
      setRef('');
    } catch (err: any) {
      setError(err.message || 'Failed to add work link.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const workLinks = cardDetails.work_links || [];

  return (
    <div>
      <h4 className="text-xs font-bold muster-text-secondary uppercase mb-3 flex items-center">
        <GitCommit className="w-4 h-4 mr-1.5 muster-text-success" />
        Work Links ({workLinks.length})
      </h4>

      <div className="space-y-3 mb-3">
        {workLinks.length > 0 ? (
          WORK_LINK_KIND_ORDER.filter((k) => workLinks.some((l) => l.kind === k)).map((k) => {
            const KindIcon = WORK_LINK_KIND_ICONS[k];
            const links = workLinks.filter((l) => l.kind === k);
            return (
              <div key={k}>
                <div className="text-[10px] font-semibold muster-text-muted uppercase mb-1.5">{WORK_LINK_KIND_LABELS[k]}</div>
                <div className="space-y-2">
                  {links.map((link) => (
                    <div
                      key={link.id}
                      className="flex items-center justify-between bg-muster-surface p-2.5 rounded-lg border border-success-500/20 hover:border-success-500/60 hover:bg-muster-surface-hover group transition-all min-w-0 gap-2"
                    >
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center space-x-2 min-w-0 flex-1 overflow-hidden"
                      >
                        <KindIcon className="w-3.5 h-3.5 muster-text-success flex-shrink-0 group-hover:scale-110 transition-transform" />
                        <span className="px-1.5 py-0.5 text-[10px] font-mono rounded flex-shrink-0 bg-muster-surface-hover muster-text-muted border border-muster-border">
                          {WORK_LINK_PROVIDER_LABELS[link.provider]}
                        </span>
                        <span className="text-xs font-mono muster-text-primary group-hover:text-success-300 truncate min-w-0">
                          {link.external_ref || link.title || link.url}
                        </span>
                        <ExternalLink className="w-3 h-3 muster-text-muted flex-shrink-0 opacity-0 group-hover:opacity-100" />
                      </a>
                      <button
                        onClick={() => onRemoveWorkLink(link.id)}
                        className="muster-btn muster-btn-icon muster-btn-ghost-danger opacity-0 group-hover:opacity-100 flex-shrink-0"
                        title="Remove work link"
                      >
                        <Unlink className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        ) : (
          <p className="text-xs muster-text-muted italic">No work linked to this card yet.</p>
        )}
      </div>

      {error && <p className="text-xs muster-text-danger mb-2">{error}</p>}

      <form onSubmit={handleSubmit} className="space-y-1.5 min-w-0">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          <select aria-label="Work link kind" value={kind} onChange={(e) => setKind(e.target.value as CardWorkLinkKind)} className="muster-input text-xs py-1 w-full">
            <option value="branch">Branch</option>
            <option value="pull_request">Pull Request</option>
            <option value="commit">Commit</option>
            <option value="pipeline">Pipeline</option>
          </select>
          <select aria-label="Work link provider" value={provider} onChange={(e) => setProvider(e.target.value as CardWorkLinkProvider)} className="muster-input text-xs py-1 w-full">
            <option value="forgejo">Forgejo</option>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="other">Other</option>
          </select>
          <input
            type="text"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="Ref (feat/x, #42, 98bb52e)"
            className="muster-input text-xs py-1 w-full col-span-2 sm:col-span-1"
          />
        </div>
        <div className="flex gap-1.5 min-w-0">
          <input
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            className="muster-input text-xs py-1 flex-1 min-w-0"
          />
          <button type="submit" disabled={isSubmitting || !url.trim()} className="muster-btn muster-btn-primary py-1 px-3 flex-shrink-0 text-xs">
            <Plus className="w-3.5 h-3.5 mr-1" /> Add
          </button>
        </div>
      </form>
    </div>
  );
};
