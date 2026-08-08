import React from 'react';
import { X } from 'lucide-react';
import { StockDetailPanel } from './StockDetailPanel.jsx';

// Drop-in full-profile overlay for surfaces that are NOT board list/detail
// layouts (audit 2026-08-04).
//
// MasterDetail is the right container for a board: it owns the whole view and
// splits list from detail. But several surfaces that render tickers — the
// journal, the filing-attribution table, backtest attribution, broker
// positions — are panels nested inside other layouts, and restructuring each
// one around MasterDetail would be a large, risky edit for a small feature.
//
// This renders `position: fixed`, so it can be mounted ANYWHERE in the tree
// and still cover the viewport. Same chrome and same StockDetailPanel as the
// mobile MasterDetail branch, so the profile looks identical wherever the
// user reached it from.

export function TickerDetailModal({ ticker, row = null, board = 'search', onClose }) {
  if (!ticker) return null;
  return (
    <div
      data-testid="ticker-detail-modal"
      // Marks this as a top-layer overlay. MasterDetail's Escape handler
      // stands down while one is mounted, so the key cannot silently resize
      // the panel underneath an open modal.
      data-overlay="modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-5xl max-h-[92vh] overflow-y-auto bg-chrome border border-neutral-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 bg-chrome border-b border-neutral-800 px-6 py-4 flex items-center justify-between gap-4">
          <span className="font-serif text-xl font-bold text-neutral-100">{ticker}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail"
            className="text-neutral-400 hover:text-neutral-200 p-1 flex-shrink-0"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 sm:p-6 space-y-5 sm:space-y-6">
          <StockDetailPanel board={board} ticker={ticker} row={row} />
        </div>
      </div>
    </div>
  );
}
