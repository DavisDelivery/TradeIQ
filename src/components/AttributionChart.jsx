import React, { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { ChartPanel } from './KpiCard.jsx';

// AttributionChart — per-analyst weighted P&L contribution.
//
// Each `attribution` row is { ticker, asOfDate, layers, pnl, ... } where
// `layers` is the score breakdown by analyst (fundamental, momentum,
// technical, insider, sentiment, ...). We aggregate by analyst: sum
// pnl × normalized(layers.<analyst>) so contribution scales with both
// outcome and how heavily that analyst weighed in at entry.
//
// Phase 5 will refine this attribution methodology — this is a first-pass
// view; the goal is "make it visible so we can eyeball weight problems
// before Phase 5 starts."

function aggregateByAnalyst(attribution) {
  if (!Array.isArray(attribution) || attribution.length === 0) return [];

  const byAnalyst = new Map();
  for (const row of attribution) {
    const layers = row?.layers ?? {};
    const pnl = Number(row?.pnl ?? 0);
    if (!Number.isFinite(pnl) || pnl === 0) continue;

    // Normalize layer scores so the total weight per row sums to 1
    const layerEntries = Object.entries(layers).filter(
      ([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0,
    );
    const totalWeight = layerEntries.reduce((s, [, v]) => s + v, 0);
    if (totalWeight === 0) continue;

    for (const [analyst, score] of layerEntries) {
      const contribution = pnl * (score / totalWeight);
      byAnalyst.set(analyst, (byAnalyst.get(analyst) ?? 0) + contribution);
    }
  }

  return [...byAnalyst.entries()]
    .map(([analyst, contribution]) => ({ analyst, contribution }))
    .sort((a, b) => b.contribution - a.contribution);
}

const fmtCurrency = (v) =>
  v == null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
        .format(v);

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const { analyst, contribution } = payload[0].payload;
  return (
    <div className="border border-neutral-700 bg-neutral-950/95 px-3 py-2 text-xs font-mono">
      <div className="text-neutral-200">{analyst}</div>
      <div
        className={`tabular-nums ${contribution >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
      >
        {fmtCurrency(contribution)}
      </div>
    </div>
  );
}

export function AttributionChart({ attribution }) {
  const data = useMemo(() => aggregateByAnalyst(attribution), [attribution]);

  if (data.length === 0) {
    return (
      <ChartPanel
        title="Analyst attribution"
        subtitle="Weighted P&L contribution per analyst"
      >
        <div className="h-[200px] flex items-center justify-center text-xs text-neutral-500 font-mono">
          no attribution data
        </div>
      </ChartPanel>
    );
  }

  return (
    <ChartPanel
      title="Analyst attribution"
      subtitle="Weighted P&L per analyst — Phase 5 will refine methodology"
    >
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 5, right: 5, left: 0, bottom: 40 }}
            barCategoryGap="20%"
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis
              dataKey="analyst"
              stroke="#6b7280"
              tick={{ fontSize: 10, fontFamily: 'monospace' }}
              angle={-30}
              textAnchor="end"
              height={50}
              interval={0}
            />
            <YAxis
              stroke="#6b7280"
              tick={{ fontSize: 10, fontFamily: 'monospace' }}
              tickFormatter={fmtCurrency}
              width={70}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
            <Bar dataKey="contribution" isAnimationActive={false}>
              {data.map((row) => (
                <Cell
                  key={row.analyst}
                  fill={row.contribution >= 0 ? '#10b981' : '#f43f5e'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartPanel>
  );
}
