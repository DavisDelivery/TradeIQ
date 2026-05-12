import React from 'react';
import { KpiCard } from './KpiCard.jsx';

// RunMetricsTiles — 8-tile grid of headline metrics for a backtest run.
//
// 2 columns on phone, 4 on sm+. Colors:
//   - totalReturn / CAGR positive → emerald, negative → rose
//   - maxDrawdown always rose
//   - Sharpe > 1 emerald, < 0 rose, else neutral
//   - everything else neutral
//
// `metrics` follows the BacktestResult.metrics schema (totalReturn, cagr,
// sharpe, sortino, maxDrawdown, winRate, ic, informationRatio, trades).
// Missing values render as '—'.

const fmt = {
  pct: (v) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(2)}%`),
  num: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(3)),
  int: (v) => (v == null || Number.isNaN(v) ? '—' : String(v)),
};

function signColor(value, mode = 'profit') {
  if (value == null || Number.isNaN(value)) return 'neutral';
  if (mode === 'profit') return value >= 0 ? 'emerald' : 'rose';
  if (mode === 'sharpe') {
    if (value > 1) return 'emerald';
    if (value < 0) return 'rose';
    return 'neutral';
  }
  return 'neutral';
}

export function RunMetricsTiles({ metrics }) {
  if (!metrics) return null;

  const tiles = [
    {
      label: 'Total return',
      value: fmt.pct(metrics.totalReturn),
      color: signColor(metrics.totalReturn, 'profit'),
    },
    {
      label: 'CAGR',
      value: fmt.pct(metrics.cagr),
      color: signColor(metrics.cagr, 'profit'),
    },
    {
      label: 'Sharpe',
      value: fmt.num(metrics.sharpe),
      color: signColor(metrics.sharpe, 'sharpe'),
    },
    {
      label: 'Sortino',
      value: fmt.num(metrics.sortino),
      color: signColor(metrics.sortino, 'sharpe'),
    },
    {
      label: 'Max DD',
      value: fmt.pct(metrics.maxDrawdown),
      color: 'rose',
    },
    {
      label: 'Win rate',
      value: fmt.pct(metrics.winRate),
    },
    {
      label: 'IC',
      value: fmt.num(metrics.ic),
    },
    {
      label: 'IR vs bench',
      value: fmt.num(metrics.informationRatio),
    },
    {
      label: 'Trades',
      value: fmt.int(metrics.trades),
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
      {tiles.map((t) => (
        <KpiCard key={t.label} {...t} />
      ))}
    </div>
  );
}
