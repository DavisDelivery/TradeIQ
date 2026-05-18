// Phase 4k W1 — desktop shell wrapper.
//
// Mounted only above the desktop breakpoint (see useBreakpoint). Lays out
// the persistent left sidebar against the main content pane and pins a
// slim top strip (regime ticker / status) above the scrolling content.
//
// Below the breakpoint this component is not mounted; App.jsx renders the
// existing mobile TopBar + content tree exactly as it did before Phase 4k.

import React from 'react';

export function DesktopShell({ sidebar, topStrip, children }) {
  return (
    <div className="flex min-h-screen" data-testid="desktop-shell">
      {sidebar}
      <div className="flex-1 min-w-0 flex flex-col">
        {topStrip && (
          <div className="sticky top-0 z-30 border-b border-neutral-800/80 bg-[#0a0b0d]/95 backdrop-blur-xl">
            {topStrip}
          </div>
        )}
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
