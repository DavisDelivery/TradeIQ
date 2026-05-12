import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { ChartPanel } from './KpiCard.jsx';

// EquityCurveChart — strategy NAV over time, optionally overlaid with the
// benchmark NAV. Read from `dailyEquity[]` which the backtest-runs-get
// endpoint returns as an array of { date, value, benchmarkValue? } rows.
//
// Recharts handles thousands of points fine, but we downsample to ~500
// for phone rendering — equity curves don't lose visual fidelity at 500
// points over a 7-year window, and tooltip is more responsive.

const MAX_POINTS = 500;

function downsample(points, target) {
  if (points.length <= target) return points;
  const stride = Math.ceil(points.length / target);
  const out = [];
  for (let i = 0; i < points.length; i += stride) {
    out.push(points[i]);
  }
  // Always include the last point so the visual end matches the metric
  if (out[out.length - 1] !== points[points.length - 1]) {
    out.push(points[points.length - 1]);
  }
  return out;
}

const fmtCurrency = (v) =>
  v == null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
        .format(v);

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="border border-neutral-700 bg-neutral-950/95 px-3 py-2 text-xs font-mono">
      <div className="text-neutral-400 mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2"
            style={{ background: p.color }}
            aria-hidden="true"
          />
          <span className="text-neutral-300">{p.name}:</span>
          <span className="text-neutral-100 tabular-nums">{fmtCurrency(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function EquityCurveChart({ dailyEquity }) {
  const data = useMemo(() => {
    if (!Array.isArray(dailyEquity) || dailyEquity.length === 0) return [];
    return downsample(dailyEquity, MAX_POINTS);
  }, [dailyEquity]);

  const hasBenchmark = data.some((d) => d?.benchmarkValue != null);

  if (data.length === 0) {
    return (
      <ChartPanel title="Equity curve" subtitle="No daily equity data on this run">
        <div className="h-[200px] flex items-center justify-center text-xs text-neutral-500 font-mono">
          empty
        </div>
      </ChartPanel>
    );
  }

  return (
    <ChartPanel
      title="Equity curve"
      subtitle={hasBenchmark ? 'Strategy vs benchmark' : 'Strategy NAV'}
    >
      <div className="h-[250px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis
              dataKey="date"
              stroke="#6b7280"
              tick={{ fontSize: 10, fontFamily: 'monospace' }}
              minTickGap={40}
            />
            <YAxis
              stroke="#6b7280"
              tick={{ fontSize: 10, fontFamily: 'monospace' }}
              tickFormatter={(v) => fmtCurrency(v)}
              width={60}
            />
            <Tooltip content={<CustomTooltip />} />
            {hasBenchmark && (
              <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'monospace' }} />
            )}
            <Line
              type="monotone"
              dataKey="value"
              name="Strategy"
              stroke="#10b981"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            {hasBenchmark && (
              <Line
                type="monotone"
                dataKey="benchmarkValue"
                name="Benchmark"
                stroke="#a1a1aa"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartPanel>
  );
}
