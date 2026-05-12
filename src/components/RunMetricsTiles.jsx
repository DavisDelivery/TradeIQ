import React from 'react';
import { KpiCard } from './KpiCard.jsx';

// Phase 4b — top-of-run-detail metrics grid.
//
// Persistence stores Pct fields already-multiplied by 100 (see
// netlify/functions/shared/backtest/metrics.ts:198 — totalReturn * 100,
// cagr * 100, mdd * 100, winRate already in pct). So formatPct is a
// simple toFixed; no *100 multiplication on the client.

const fmt = {
  pct: (v) => (v == null || !Number.isFinite(v) ? '—' : `${Number(v).toFixed(2)}%`),
  num: (v) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(3)),
  int: (v) => (v == null || !Number.isFinite(v) ? '—' : String(v)),
};

// Color predicate for total-return and Sharpe — null/undefined collapse
// to 'neutral' so an in-flight or missing-field run doesn't get a green
// or red signal it doesn't deserve.
function colorByReturn(v) {
  if (v == null || !Number.isFinite(v)) return 'neutral';
  return v >= 0 ? 'emerald' : 'rose';
}
function colorBySharpe(v) {
  if (v == null || !Number.isFinite(v)) return 'neutral';
  if (v > 1) return 'emerald';
  if (v < 0) return 'rose';
  return 'neutral';
}

export function RunMetricsTiles({ metrics, benchmark }) {
  // Defensive against the run doc being mid-write or pre-Phase-4a shape.
  const m = metrics ?? {};
  const tiles = [
    { label: 'Total return', value: fmt.pct(m.totalReturnPct), color: colorByReturn(m.totalReturnPct) },
    { label: 'CAGR', value: fmt.pct(m.cagrPct), color: colorByReturn(m.cagrPct) },
    { label: 'Sharpe', value: fmt.num(m.sharpe), color: colorBySharpe(m.sharpe) },
    { label: 'Max DD', value: fmt.pct(m.maxDrawdownPct), color: 'rose' },
    { label: 'Win rate', value: fmt.pct(m.winRatePct) },
    { label: 'IC', value: fmt.num(m.informationCoefficient) },
    { label: 'IR vs bench', value: fmt.num(m.informationRatio) },
    { label: 'Trades', value: fmt.int(m.tradeCount) },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4" data-testid="run-metrics-tiles">
      {tiles.map((t) => (
        <KpiCard key={t.label} label={t.label} value={t.value} color={t.color} />
      ))}
      {benchmark?.ticker && (
        <KpiCard
          label={`Bench (${benchmark.ticker})`}
          value={fmt.pct(benchmark.totalReturnPct)}
          color={colorByReturn(benchmark.totalReturnPct)}
        />
      )}
    </div>
  );
}
