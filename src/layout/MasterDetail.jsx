// Phase 4k W2 — master-detail container.
//
// A reusable wrapper around the "board list + selected-row detail" pattern.
// On mobile (below the desktop breakpoint) it preserves the existing
// behavior exactly: the list renders alone and a selected row opens a
// full-screen modal. On desktop (≥1280px) it splits the viewport into a
// board pane and a docked detail pane that pushes/resizes the board —
// the board stays usable, just narrower; selecting another row swaps the
// panel content. The board is never hidden behind the detail.
//
// The consumer owns selection state (`selected` + `onClose`) and supplies
// three slots: `list`, `detailHeader` (the title row that lives in the
// sticky chrome alongside the close button), and `detail` (the scrolling
// content body). The container provides the modal/panel chrome itself so
// callers don't reinvent it.

import React from 'react';
import { X } from 'lucide-react';
import { useBreakpoint } from '../hooks/useBreakpoint.js';

export function MasterDetail({
  list,
  detail,
  detailHeader = null,
  selected,
  onClose,
  closeLabel = 'Close detail',
}) {
  const { isDesktop } = useBreakpoint();
  const isOpen = Boolean(selected);

  if (!isDesktop) {
    return (
      <>
        {list}
        {isOpen && (
          <div
            data-testid="master-detail-modal"
            className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 bg-black/70 backdrop-blur-sm"
            onClick={onClose}
          >
            <div
              className="relative w-full max-w-5xl max-h-[92vh] overflow-y-auto bg-[#0a0b0d] border border-neutral-800"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 z-10 bg-[#0a0b0d] border-b border-neutral-800 px-6 py-4 flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">{detailHeader}</div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={closeLabel}
                  className="text-neutral-400 hover:text-neutral-200 p-1 flex-shrink-0"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="p-4 sm:p-6 space-y-5 sm:space-y-6">{detail}</div>
            </div>
          </div>
        )}
      </>
    );
  }

  // Desktop: board + docked detail panel side-by-side. Board pane narrows
  // when the panel opens (push/resize, not overlay). The panel is sticky
  // so the detail stays in view as the board scrolls underneath.
  return (
    <div className="flex items-start" data-testid="master-detail-split">
      <div className={`min-w-0 ${isOpen ? 'flex-1 border-r border-neutral-800/60' : 'flex-1'}`}>
        {list}
      </div>
      {isOpen && (
        <aside
          data-testid="master-detail-panel"
          className="w-[440px] xl:w-[480px] 2xl:w-[560px] flex-shrink-0 sticky top-8 self-start max-h-[calc(100vh-2.25rem)] overflow-y-auto bg-[#070809] border-l border-neutral-800/60"
        >
          <div className="sticky top-0 z-10 bg-[#070809]/95 backdrop-blur-xl border-b border-neutral-800 px-4 py-3 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">{detailHeader}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="text-neutral-400 hover:text-neutral-200 p-1 flex-shrink-0"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="p-4 space-y-4">{detail}</div>
        </aside>
      )}
    </div>
  );
}
