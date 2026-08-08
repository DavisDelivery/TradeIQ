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
//
// ---------------------------------------------------------------------------
// EXPAND
//
// The docked panel is 440-560px. That is right for a metrics glance and
// cramped for the two things people actually READ in it — the Camillo panel
// and the chart. The expand control gives the detail the full content area.
//
// IT EXPANDS TO THE CONTENT AREA, NOT OVER THE WHOLE VIEWPORT. A
// `fixed inset-0` panel is the obvious implementation and it is wrong here:
// the app header is `sticky top-0 z-40`, so a fixed overlay either ties with
// it (z-40, where paint order decides the winner by accident) or covers it
// (z-50+, which also sits on top of the ticker modal that opens from INSIDE
// this panel). Covering the header means a trader reading a name loses the
// nav bar and every filter with it. Taking the content area instead gives the
// same width, keeps the chrome usable, and needs no z-index at all.
//
// The preference is persisted because it is a workspace choice rather than a
// per-row one: someone who wants the wide view wants it for the next ticker
// too, and re-clicking it on every row is the annoyance being removed.

import React from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { useBreakpoint } from '../hooks/useBreakpoint.js';

export const EXPAND_KEY = 'tradeiq-detail-expanded';

/**
 * Declared at module scope ON PURPOSE.
 *
 * Defined inside MasterDetail it would be a new component type on every
 * render, so React would unmount and remount the button each time instead of
 * updating it — which drops keyboard focus the moment you activate it, the
 * one interaction where focus matters most.
 */
function ExpandToggle({ expanded, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={expanded ? 'Exit full screen' : 'Expand to full screen'}
      aria-pressed={expanded}
      title={expanded ? 'Exit full screen (Esc)' : 'Expand to full screen'}
      className="text-neutral-400 hover:text-neutral-200 p-1 flex-shrink-0"
    >
      {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
    </button>
  );
}

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

  const [expanded, setExpanded] = React.useState(() => {
    try {
      return localStorage.getItem(EXPAND_KEY) === '1';
    } catch {
      return false; // private mode — default to docked
    }
  });

  const toggleExpanded = React.useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try { localStorage.setItem(EXPAND_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, []);

  // Escape collapses the expanded view FIRST and only closes the panel once it
  // is already docked. Escaping straight to closed from the wide view loses
  // the row you were reading, which is the opposite of what the key is
  // usually reached for.
  //
  // It also stands down entirely while a higher overlay is mounted. The ticker
  // profile modal opens from inside this panel and has no Escape handler of
  // its own, so without this guard the key would quietly resize the panel
  // UNDERNEATH the modal — a keypress with no visible effect.
  React.useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (typeof document !== 'undefined' && document.querySelector('[data-overlay="modal"]')) return;
      if (expanded) { toggleExpanded(); return; }
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, expanded, toggleExpanded, onClose]);

  if (!isDesktop) {
    return (
      <>
        {list}
        {isOpen && (
          <div
            data-testid="master-detail-modal"
            data-overlay="modal"
            className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 bg-black/70 backdrop-blur-sm"
            onClick={onClose}
          >
            <div
              data-testid="master-detail-modal-inner"
              data-expanded={expanded ? 'true' : 'false'}
              className={`relative overflow-y-auto bg-chrome border border-neutral-800 ${
                expanded ? 'w-full h-full max-w-none max-h-none' : 'w-full max-w-5xl max-h-[92vh]'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 z-10 bg-chrome border-b border-neutral-800 px-6 py-4 flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">{detailHeader}</div>
                <ExpandToggle expanded={expanded} onToggle={toggleExpanded} />
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
  //
  // Expanded, the board pane is hidden and the panel takes the content area.
  // The list is UNMOUNTED rather than width-zeroed so a wide board does not
  // keep forcing a horizontal scrollbar on a container it no longer occupies.
  const showList = !(isOpen && expanded);

  return (
    <div className="flex items-start" data-testid="master-detail-split">
      {showList && (
        <div className={`min-w-0 ${isOpen ? 'flex-1 border-r border-neutral-800/60' : 'flex-1'}`}>
          {list}
        </div>
      )}
      {isOpen && (
        <aside
          data-testid="master-detail-panel"
          data-expanded={expanded ? 'true' : 'false'}
          className={
            expanded
              ? 'flex-1 min-w-0 self-stretch overflow-y-auto bg-rail'
              : 'w-[440px] xl:w-[480px] 2xl:w-[560px] flex-shrink-0 sticky top-8 self-start max-h-[calc(100vh-2.25rem)] overflow-y-auto bg-rail border-l border-neutral-800/60'
          }
        >
          <div className="sticky top-0 z-10 bg-rail/95 backdrop-blur-xl border-b border-neutral-800 px-4 py-3 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">{detailHeader}</div>
            <ExpandToggle expanded={expanded} onToggle={toggleExpanded} />
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="text-neutral-400 hover:text-neutral-200 p-1 flex-shrink-0"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className={expanded ? 'p-6 space-y-5 max-w-6xl mx-auto' : 'p-4 space-y-4'}>{detail}</div>
        </aside>
      )}
    </div>
  );
}
