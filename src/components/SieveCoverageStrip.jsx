import React from 'react';
import { Filter } from 'lucide-react';

// 4c-2: visual telemetry for the Russell sieve. Renders only when the
// backend supplied `sieve` metadata (Russell snapshots produced by the
// 3-stage sieve). The ladder shows the universe-funnel honestly:
//   2037 names → s1 survivors → s2 survivors → final qualified
// If any stage stamped `partial: true`, the strip turns amber and the
// PARTIAL marker calls out which stage ran out of budget.

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}

function whichPartial(sieve) {
  if (sieve?.stage1?.partial) return 'Stage 1 budget';
  if (sieve?.stage2?.partial) return 'Stage 2 budget';
  if (sieve?.stage3?.partial) return 'Stage 3 budget';
  return null;
}

export const SieveCoverageStrip = ({ sieve, universeSize }) => {
  if (!sieve) return null;

  const partial = whichPartial(sieve);
  const tone = partial
    ? 'border-amber-500/30 bg-amber-500/5 text-amber-300'
    : 'border-neutral-800 bg-neutral-950/60 text-neutral-400';
  const arrowTone = partial ? 'text-amber-500/70' : 'text-neutral-600';
  const numberTone = partial ? 'text-amber-200' : 'text-neutral-200';

  return (
    <div
      className={`border ${tone} p-2 mb-3 flex items-center justify-between gap-2 text-[11px] font-mono`}
      data-testid="sieve-coverage-strip"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Filter className="h-3 w-3 flex-shrink-0" />
        <span className="uppercase tracking-widest text-[9px] opacity-70 hidden sm:inline">Sieve</span>
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className={numberTone} title="Tickers fed into Stage 1">
            {fmt(universeSize)} names
          </span>
          <span className={arrowTone}>→</span>
          <span className={numberTone} title={`Stage 1 survivors${sieve.stage1.thresholdScore != null ? ` (≥${sieve.stage1.thresholdScore})` : ''}`}>
            s1: {fmt(sieve.stage1.survived)}
          </span>
          <span className={arrowTone}>→</span>
          <span className={numberTone} title={`Stage 2 survivors${sieve.stage2.thresholdScore != null ? ` (≥${sieve.stage2.thresholdScore}, earnings gate)` : ''}`}>
            s2: {fmt(sieve.stage2.survived)}
          </span>
          <span className={arrowTone}>→</span>
          <span className={numberTone} title="Final qualified picks after full 7-layer scoring">
            {fmt(sieve.stage3.survived)} ranked
          </span>
        </div>
      </div>
      {partial && (
        <span className="text-[10px] uppercase tracking-wider flex-shrink-0">
          partial · {partial}
        </span>
      )}
    </div>
  );
};
