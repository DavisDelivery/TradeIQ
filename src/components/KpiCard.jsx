import React from 'react';

// KpiCard + ChartPanel — small layout primitives used across the
// backtest viewer (RunMetricsTiles, EquityCurveChart, DrawdownChart, etc).
//
// Extracted from BacktestView.jsx so subcomponents in src/components/
// can render their own tiles/panels without circular-import gymnastics.
// Visual style matches the rest of TradeIQ — neutral dark, narrow borders,
// mono labels with 0.2em tracking. Phone-first sizing on tile typography.

export function KpiCard({ label, value, color = 'neutral' }) {
  const colorClass =
    color === 'emerald'
      ? 'text-emerald-400'
      : color === 'rose'
      ? 'text-rose-400'
      : color === 'amber'
      ? 'text-amber-400'
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

export function ChartPanel({ title, subtitle, children, className = '' }) {
  return (
    <div className={`border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4 ${className}`}>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
            {title}
          </div>
          {subtitle && (
            <div className="text-[10px] text-neutral-600 font-mono mt-0.5">{subtitle}</div>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
