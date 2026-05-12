import React, { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
} from 'recharts';
import { ChartPanel } from './ChartPanel.jsx';

// Phase 4b — per-analyst attribution.
//
// Each attribution row has {weight, segmentReturn, contribution, layers}.
// `contribution` is the portfolio-level P&L impact of that position
// (weight × segmentReturn). `layers` is the per-analyst score at entry.
//
// Bucketing methodology (deliberately simple for Phase 4b):
//   - For each attribution row, find the analyst layer with the highest
//     score. Attribute the row's `contribution` to that analyst.
//   - Sum contributions per analyst. Display bars sorted by total
//     contribution.
//
// Why this works: a position picked primarily because (say) the momentum
// analyst scored it highly should plausibly "belong" to momentum's track
// record. Phase 5 will refine — likely by weighting each analyst's
// contribution by its normalized share of the composite — but for the
// first read-out, a single-attribution bucket is the simplest honest
// shape that lets Chad eyeball which analysts look miscalibrated before
// Phase 5 starts. The chart's subtitle states this caveat in plain text.

function aggregate(attribution) {
  const totals = new Map(); // analyst -> sum of contribution
  for (const row of attribution || []) {
    const layers = row?.layers ?? {};
    let topAnalyst = null;
    let topScore = -Infinity;
    for (const [k, v] of Object.entries(layers)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > topScore) {
        topScore = n;
        topAnalyst = k;
      }
    }
    if (!topAnalyst) continue;
    const contrib = Number(row?.contribution);
    if (!Number.isFinite(contrib)) continue;
    totals.set(topAnalyst, (totals.get(topAnalyst) ?? 0) + contrib);
  }
  return [...totals.entries()]
    .map(([analyst, sum]) => ({
      analyst,
      // Convert contribution (fractional, e.g. -0.0034) to percent for display.
      contributionPct: +(sum * 100).toFixed(3),
    }))
    .sort((a, b) => b.contributionPct - a.contributionPct);
}

function TooltipBody({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  const v = payload[0]?.value;
  return (
    <div className="border border-neutral-700 bg-neutral-950/95 px-2 py-1.5 font-mono text-[10px]">
      <div className="text-neutral-300 mb-0.5">{label}</div>
      <div className={`tabular-nums ${v >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
        {v == null ? '—' : `${Number(v).toFixed(3)}%`}
      </div>
    </div>
  );
}

export function AttributionChart({ attribution }) {
  const rows = useMemo(() => aggregate(attribution), [attribution]);

  if (rows.length === 0) {
    return (
      <ChartPanel
        title="Per-analyst attribution"
        subtitle="Cumulative P&L contribution (%) bucketed by top-scoring analyst at entry"
      >
        <div className="text-neutral-500 font-mono text-[11px] text-center py-8">
          No attribution data in run.
        </div>
      </ChartPanel>
    );
  }

  return (
    <ChartPanel
      title="Per-analyst attribution"
      subtitle="Cumulative P&L contribution (%) bucketed by top-scoring analyst at entry · Phase 5 will refine"
    >
      <div className="h-[240px]" data-testid="attribution-chart">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#262626" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="analyst"
              stroke="#525252"
              tick={{ fontSize: 9, fill: '#a3a3a3', fontFamily: 'monospace' }}
              tickMargin={4}
              interval={0}
              angle={-25}
              textAnchor="end"
              height={50}
            />
            <YAxis
              stroke="#525252"
              tick={{ fontSize: 9, fill: '#737373', fontFamily: 'monospace' }}
              tickFormatter={(v) => `${v}%`}
              width={45}
            />
            <Tooltip content={<TooltipBody />} cursor={{ fill: '#171717' }} />
            <Bar dataKey="contributionPct" isAnimationActive={false}>
              {rows.map((r) => (
                <Cell
                  key={r.analyst}
                  fill={r.contributionPct >= 0 ? '#34d399' : '#f43f5e'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartPanel>
  );
}

// Exported for testing the aggregation logic directly.
export const __test_aggregate = aggregate;
