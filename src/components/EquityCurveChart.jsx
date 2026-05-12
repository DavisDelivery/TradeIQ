import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import { ChartPanel } from './ChartPanel.jsx';

// Phase 4b — equity curve over the backtest window.
//
// Reads dailyEquity[{date, value, benchmarkValue?}]. The Phase 4a engine
// writes {date, value}; if benchmarkValue is added later, this chart
// auto-renders the overlay.
//
// Performance: 1700+ daily points renders fine in Recharts. Above 5000
// points (longer than ~20 years daily) we stride-downsample to every other
// point on the client — cheap, and keeps mobile responsive at 375px wide.

const DOWNSAMPLE_THRESHOLD = 5000;

function downsampleStride(rows, target) {
  if (rows.length <= target) return rows;
  const stride = Math.ceil(rows.length / target);
  const out = [];
  for (let i = 0; i < rows.length; i += stride) out.push(rows[i]);
  // Always include the last point so the chart ends on the true final NAV,
  // not whatever the stride landed on.
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out;
}

function formatDollars(v) {
  if (v == null || !Number.isFinite(v)) return '';
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${Math.round(v)}`;
}

function TooltipBody({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="border border-neutral-700 bg-neutral-950/95 px-2 py-1.5 font-mono text-[10px]">
      <div className="text-neutral-400 mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2"
            style={{ background: p.color }}
            aria-hidden="true"
          />
          <span className="text-neutral-200 tabular-nums">{formatDollars(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function EquityCurveChart({ dailyEquity }) {
  const data = useMemo(() => {
    const rows = Array.isArray(dailyEquity) ? dailyEquity : [];
    return downsampleStride(rows, DOWNSAMPLE_THRESHOLD);
  }, [dailyEquity]);

  const hasBenchmark = data.some((d) => d?.benchmarkValue != null);

  if (data.length === 0) {
    return (
      <ChartPanel title="Equity curve" subtitle="Portfolio NAV ($)">
        <div className="text-neutral-500 font-mono text-[11px] text-center py-8">
          No equity series in run.
        </div>
      </ChartPanel>
    );
  }

  return (
    <ChartPanel
      title="Equity curve"
      subtitle={`Portfolio NAV ($) · ${data.length} points${hasBenchmark ? ' · benchmark overlay' : ''}`}
    >
      <div className="h-[250px]" data-testid="equity-curve-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#262626" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              stroke="#525252"
              tick={{ fontSize: 9, fill: '#737373', fontFamily: 'monospace' }}
              tickMargin={4}
              minTickGap={40}
            />
            <YAxis
              stroke="#525252"
              tick={{ fontSize: 9, fill: '#737373', fontFamily: 'monospace' }}
              tickFormatter={formatDollars}
              width={50}
              domain={['auto', 'auto']}
            />
            <Tooltip content={<TooltipBody />} />
            <Line
              type="monotone"
              dataKey="value"
              stroke="#34d399"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              name="Portfolio"
            />
            {hasBenchmark && (
              <Line
                type="monotone"
                dataKey="benchmarkValue"
                stroke="#737373"
                strokeWidth={1}
                strokeDasharray="3 3"
                dot={false}
                isAnimationActive={false}
                name="Benchmark"
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartPanel>
  );
}
