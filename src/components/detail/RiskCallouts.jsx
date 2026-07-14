// Phase 6 PR-E — RiskCallouts for the StockDetailPanel.
//
// Renders the strategy's falsifiable risk-callout array surfaced by the
// rationale endpoint (Phase 6 PR-A surface-only generators):
//   - Williams: technical/momentum invalidation conditions
//   - Lynch:    GARP invalidation thresholds
//   - Target:   board-row rationale string used directly; no per-component
//               risk array on the composite endpoint, so the panel falls
//               through to a "no callouts" state with an explicit reason.
//
// The component is rationale-shape-agnostic — it expects `riskCallouts:
// string[]` on the rationale data. No transformations.

import React from 'react';
import { XCircle } from 'lucide-react';
import { useWilliamsRationale } from '../../hooks/useWilliamsRationale.js';
import { useLynchRationale } from '../../hooks/useLynchRationale.js';

export function RiskCallouts({ board, ticker }) {
  const isWilliams = board === 'williams';
  const isLynch = board === 'lynch';
  // Mount both hooks unconditionally (Rules of Hooks); enabled-gate to the
  // board so the panel never double-fetches.
  const williams = useWilliamsRationale(ticker, { enabled: isWilliams });
  const lynch = useLynchRationale(ticker, { enabled: isLynch });
  const q = isWilliams ? williams : isLynch ? lynch : null;

  const callouts = Array.isArray(q?.data?.riskCallouts) ? q.data.riskCallouts : [];

  return (
    <section
      data-testid="risk-callouts"
      className="border border-neutral-800/80 bg-neutral-950/30 p-4"
    >
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
          Risk Callouts
        </div>
      </header>

      {!q && (
        <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-600">
          {board === 'fable'
            ? 'risk is mechanical here — 12% stop, exit below 60th pctile, 126-day max hold'
            : 'target composite — no falsifiable per-component callouts'}
        </div>
      )}

      {q && q.isLoading && (
        <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-600">loading callouts…</div>
      )}
      {q && q.isError && (
        <div className="space-y-2">
          <div className="text-[11px] font-mono uppercase tracking-widest text-rose-300">couldn't load callouts</div>
          <button onClick={() => q.refetch()} className="px-3 h-7 border border-neutral-700 text-[10px] font-mono uppercase tracking-widest text-neutral-300 hover:text-neutral-100 hover:border-neutral-500">↻ retry</button>
        </div>
      )}
      {q && !q.isLoading && !q.isError && callouts.length === 0 && (
        <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-600">
          no callouts surfaced
        </div>
      )}
      {q && !q.isLoading && !q.isError && callouts.length > 0 && (
        <ul className="space-y-2" data-testid="risk-list">
          {callouts.map((c, i) => (
            <li key={i} className="flex items-start gap-2">
              <XCircle className="h-3.5 w-3.5 text-rose-400 mt-[2px] shrink-0" aria-hidden />
              <span className="text-[12px] font-mono text-neutral-200 leading-snug">{c}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
