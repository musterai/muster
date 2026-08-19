import React from 'react';
import type { Card, Column } from '../../types.js';

interface MobileLaneSwitcherProps {
  columns: Column[];
  cards: Card[];
  focusedColumnIdx: number;
}

export const MobileLaneSwitcher: React.FC<MobileLaneSwitcherProps> = ({ columns, cards, focusedColumnIdx }) => {
  if (columns.length === 0) return null;
  return (
    <div className="flex md:hidden items-center space-x-1.5 overflow-x-auto no-scrollbar pb-2 shrink-0">
      {columns.map((column, index) => {
        const count = cards.filter((card) => card.column_id === column.id && !card.archived).length;
        return (
          <button
            key={column.id}
            onClick={() => document.getElementById(`kanban-column-${column.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })}
            className={`muster-chip muster-touch-target shrink-0 text-xs font-sans py-1 px-2.5 flex items-center gap-1.5 cursor-pointer ${focusedColumnIdx === index ? 'border-brand-500 bg-brand-950/40 text-brand-300 font-semibold ring-1 ring-brand-500/50' : 'hover:border-brand-500/50'}`}
          >
            <span>{column.name}</span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-neutral-900 muster-text-muted font-mono">{count}</span>
          </button>
        );
      })}
    </div>
  );
};
