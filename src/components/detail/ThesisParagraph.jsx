// Phase 6 W2 — thesis paragraph block.
//
// Renders the server-generated thesis ("why" in plain English) under an
// emerald rule, matching the existing target-board detail thesis styling.
// Loading shows a skeleton; failure shows a graceful retry affordance rather
// than a blank space. When the strategy genuinely has no actionable read the
// server still returns prose (e.g. "No actionable Williams setup …"), so an
// empty thesis falls back to an honest no-read line — never silent.

import React from 'react';

export function ThesisParagraph({ thesis, loading, error, onRetry }) {
  return (
    <div className="border-l-2 border-emerald-500/40 pl-4 py-2">
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">
        Thesis
      </div>

      {loading ? (
        <div className="space-y-2" data-testid="thesis-skeleton">
          <div className="h-2.5 w-full bg-neutral-800/60 animate-pulse" />
          <div className="h-2.5 w-11/12 bg-neutral-800/50 animate-pulse" />
          <div className="h-2.5 w-4/5 bg-neutral-800/40 animate-pulse" />
        </div>
      ) : error ? (
        <button
          type="button"
          onClick={onRetry}
          className="text-[12px] font-mono text-neutral-400 hover:text-neutral-200 text-left"
        >
          Couldn&rsquo;t load the thesis — tap to retry.
        </button>
      ) : thesis ? (
        <p className="text-neutral-200 leading-relaxed">{thesis}</p>
      ) : (
        <p className="text-[12px] italic text-neutral-500 font-mono">
          No thesis available for this ticker.
        </p>
      )}
    </div>
  );
}
