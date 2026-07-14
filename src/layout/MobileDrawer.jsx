// Mobile navigation drawer — replaces the horizontal scroll-snap tab strip.
//
// With 20 views the scroller hid most destinations off-screen and demanded
// a lot of thumb travel; the drawer shows the full nav in one glance,
// grouped exactly like the desktop Sidebar (validated boards, then the
// Unvalidated section). Same single VIEWS source of truth.
//
// Behavior: slides in from the left; closes on selection, backdrop tap,
// Escape, or the X. Body scroll is locked while open. The open state lives
// in TopBar; this component is purely controlled.

import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Logo } from '../components/Badges.jsx';

export function MobileDrawer({ open, onClose, views, activeView, setActiveView, appVersion }) {
  const panelRef = useRef(null);

  // Escape closes; body scroll locks while open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Move focus into the drawer so keyboard/screen-reader users land on it.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 sm:hidden ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <div
        data-testid="drawer-backdrop"
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        data-testid="mobile-drawer"
        className={`absolute left-0 top-0 bottom-0 w-[82vw] max-w-[320px] flex flex-col bg-[#0a0b0d] border-r border-neutral-800 shadow-2xl outline-none transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-4 h-12 border-b border-neutral-800/60 flex-shrink-0">
          <Logo />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="p-2 -mr-2 text-neutral-500 hover:text-neutral-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3 flex flex-col gap-0.5">
          {views.map((v, i) => {
            const active = activeView === v.id;
            const unvalidated = v.section === 'unvalidated';
            const firstUnvalidated = unvalidated && views[i - 1]?.section !== 'unvalidated';
            return (
              <React.Fragment key={v.id}>
                {firstUnvalidated && (
                  <div
                    className="mt-3 mb-1 px-3 text-[9px] font-mono uppercase tracking-[0.18em] text-neutral-600 border-t border-neutral-800/60 pt-3"
                    title="Boards with a measured NO VALIDATED EDGE verdict"
                  >
                    Unvalidated
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => { setActiveView(v.id); onClose(); }}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex items-center gap-3 px-3 h-11 text-[14px] font-medium transition-colors text-left ${
                    active
                      ? 'text-emerald-300 bg-emerald-500/10'
                      : unvalidated
                        ? 'text-neutral-600 active:text-neutral-300'
                        : 'text-neutral-300 active:text-neutral-100 active:bg-neutral-900/60'
                  }`}
                >
                  {active && <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-emerald-400" />}
                  <v.icon className={`h-4 w-4 flex-shrink-0 ${active ? 'stroke-[2.2]' : ''}`} />
                  <span className="truncate">{v.label}</span>
                </button>
              </React.Fragment>
            );
          })}
        </nav>
        <div className="px-4 py-3 border-t border-neutral-800/60 text-[10px] font-mono uppercase tracking-[0.18em] text-neutral-600 flex-shrink-0">
          v{appVersion}
        </div>
      </div>
    </div>
  );
}
