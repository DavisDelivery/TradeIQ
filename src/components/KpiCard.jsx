import React from 'react';

// KpiCard — small numeric tile. Originally co-located in the legacy
// BacktestView; extracted in Phase 4b so the run-detail metrics grid
// and any other view can use the same shape.
//
// Color contract:
//   neutral = default neutral-200
//   emerald = positive (gains, healthy Sharpe)
//   rose    = negative (drawdowns, losing returns, distressed Sharpe)

export function KpiCard({ label, value, color = 'neutral' }) {
  const colorClass =
    color === 'emerald'
      ? 'text-emerald-400'
      : color === 'rose'
        ? 'text-rose-400'
        : 'text-neutral-200';
  return (
    <div className="border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4">
      <div className="text-[9px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-1.5">
        {label}
      </div>
      <div
        className={`text-xl sm:text-2xl font-mono font-semibold tabular-nums ${colorClass}`}
      >
        {value}
      </div>
    </div>
  );
}
