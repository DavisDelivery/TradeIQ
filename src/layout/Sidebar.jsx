// Phase 4k W1 — persistent left sidebar for the desktop layout.
//
// Activates at ≥1280px (see useBreakpoint). Below the breakpoint the
// existing TopBar mobile nav renders unchanged — Sidebar is never mounted.
//
// Layout: logo at the top, vertical nav list below. Visual identity stays
// inside the established system (dark, emerald #14e89a accent, IBM Plex
// Mono micro-labels, serif logo).

import React from 'react';
import { Logo } from '../components/Badges.jsx';

export function Sidebar({ views, activeView, setActiveView, appVersion }) {
  return (
    <aside
      className="hidden xl:flex flex-col w-[224px] flex-shrink-0 border-r border-neutral-800/80 bg-[#0a0b0d]/95 backdrop-blur-xl sticky top-0 self-start max-h-screen overflow-y-auto"
      data-testid="desktop-sidebar"
    >
      <div className="px-4 pt-4 pb-3 border-b border-neutral-800/60">
        <Logo appVersion={appVersion} />
      </div>
      <nav className="flex-1 px-2 py-3 flex flex-col gap-0.5">
        {views.map((v) => {
          const active = activeView === v.id;
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => setActiveView(v.id)}
              aria-current={active ? 'page' : undefined}
              className={`group relative flex items-center gap-2.5 px-3 h-9 text-[13px] font-medium transition-colors text-left ${
                active
                  ? 'text-emerald-300 bg-emerald-500/10'
                  : 'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900/60'
              }`}
            >
              {active && (
                <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-emerald-400" />
              )}
              <v.icon className={`h-3.5 w-3.5 flex-shrink-0 ${active ? 'stroke-[2.2]' : ''}`} />
              <span className="truncate">{v.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="px-4 py-3 border-t border-neutral-800/60 text-[10px] font-mono uppercase tracking-[0.18em] text-neutral-600">
        v{appVersion}
      </div>
    </aside>
  );
}
