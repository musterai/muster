import React, { useState } from 'react';
import { Card, CardDetails, CardLinkRelationType } from '../../types.js';
import { Link2, Unlink } from 'lucide-react';
import { CardSearch } from '../CardSearch.js';
import { CARD_LINK_BADGE_CLASSES, CARD_LINK_RELATION_LABELS } from '../../utils/card-helpers.js';

interface CardRelationModalProps {
  cardDetails: CardDetails;
  allCards: Card[];
  onOpenCard: (cardId: string) => void;
  onLinkCard: (targetCardId: string, relationType: CardLinkRelationType) => Promise<void>;
  onUnlinkCard: (linkId: string, targetTitle: string) => Promise<void>;
}

export const CardRelationSection: React.FC<CardRelationModalProps> = ({
  cardDetails,
  allCards,
  onOpenCard,
  onLinkCard,
  onUnlinkCard,
}) => {
  const [relationType, setRelationType] = useState<CardLinkRelationType>('relates_to');

  return (
    <div>
      <h4 className="text-xs font-bold muster-text-secondary uppercase mb-3 flex items-center">
        <Link2 className="w-4 h-4 mr-1.5 muster-accent" />
        Linked Cards ({(cardDetails.linked_cards || []).length})
      </h4>

      <div className="space-y-2 mb-3">
        {(cardDetails.linked_cards || []).length > 0 ? (
          (cardDetails.linked_cards || []).map((link) => (
            <div
              key={link.id}
              onClick={() => onOpenCard(link.card.id)}
              className="flex items-center justify-between bg-muster-surface p-2.5 rounded-lg border border-info-500/20 hover:border-info-500/60 hover:bg-muster-surface-hover group cursor-pointer transition-all"
            >
              <div className="flex items-center space-x-2 min-w-0">
                <span className={`muster-badge ${CARD_LINK_BADGE_CLASSES[link.relation_type]} flex-shrink-0`}>
                  {CARD_LINK_RELATION_LABELS[link.relation_type]}
                </span>
                <span className="font-mono text-[10px] muster-text-muted group-hover:text-info-400 flex-shrink-0">
                  {link.card.key}
                </span>
                <span className="text-xs font-sans muster-text-primary group-hover:text-info-300 truncate font-semibold">
                  {link.card.title}
                </span>
                {link.card.archived ? <span className="muster-badge muster-badge-neutral flex-shrink-0">archived</span> : null}
              </div>
              <div className="flex items-center space-x-1.5 flex-shrink-0">
                <span className="muster-badge muster-badge-neutral flex-shrink-0" title="Current lane">
                  {link.card.column_name}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnlinkCard(link.id, link.card.title);
                  }}
                  className="muster-btn muster-btn-icon muster-btn-ghost-danger opacity-0 group-hover:opacity-100 flex-shrink-0"
                  title="Unlink card"
                >
                  <Unlink className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="text-xs muster-text-muted italic">No linked cards.</p>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-1.5 min-w-0">
        <select
          value={relationType}
          aria-label="Card relation type"
          onChange={(e) => setRelationType(e.target.value as CardLinkRelationType)}
          className="muster-input text-xs py-1 w-full sm:w-36 shrink-0"
        >
          <option value="blocks">Blocks</option>
          <option value="blocked_by">Blocked by</option>
          <option value="relates_to">Relates to</option>
          <option value="duplicates">Duplicates</option>
          <option value="parent_of">Parent of</option>
          <option value="child_of">Child of</option>
        </select>
        <CardSearch
          cards={allCards}
          excludeCardId={cardDetails.id}
          placeholder="Search cards to link..."
          onSelectCard={(targetCard) => onLinkCard(targetCard.id, relationType)}
          className="flex-1 min-w-0"
        />
      </div>
    </div>
  );
};
