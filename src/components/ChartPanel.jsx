import React from 'react';

// ChartPanel — card wrapper for charts with a small monospace title
// and optional subtitle. Originally co-located in the legacy BacktestView;
// extracted in Phase 4b for reuse across run-detail charts (equity curve,
// drawdown, attribution).

export function ChartPanel({ title, subtitle, children, className = '' }) {
  return (
    <div className={`border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4 ${className}`}>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
            {title}
          </div>
          {subtitle && (
            <div className="text-[10px] text-neutral-600 font-mono mt-0.5">
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
