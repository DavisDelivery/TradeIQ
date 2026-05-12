import React, { useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import { ChartPanel } from './KpiCard.jsx';

// DrawdownChart — underwater equity, shows depth and duration of every
// drawdown. Reads `drawdownPct` from `dailyEquity[]` if the engine wrote
// it; otherwise computes peak-to-current decline on the client from `value`.
//
// Underwater convention: values are <= 0, expressed as decimal fraction
// (e.g. -0.0924 for -9.24% drawdown). Area filled below zero in rose.

const MAX_POINTS = 500;

function downsample(points, target) {
  if (points.length <= target) return points;
  const stride = Math.ceil(points.length / target);
  const out = [];
  for (let i = 0; i < points.length; i += stride) {
    out.push(points[i]);
  }
  if (out[out.length - 1] !== points[points.length - 1]) {
    out.push(points[points.length - 1]);
  }
  return out;
}

function computeDrawdown(rows) {
  let peak = -Infinity;
  return rows.map((row) => {
    const v = row?.value ?? 0;
    if (v > peak) peak = v;
    const dd = peak > 0 ? v / peak - 1 : 0;
    return { ...row, drawdownPct: row.drawdownPct ?? dd };
  });
}

const fmtPct = (v) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="border border-neutral-700 bg-neutral-950/95 px-3 py-2 text-xs font-mono">
      <div className="text-neutral-400 mb-1">{label}</div>
      <div className="text-rose-300 tabular-nums">DD: {fmtPct(payload[0].value)}</div>
    </div>
  );
}

export function DrawdownChart({ dailyEquity }) {
  const data = useMemo(() => {
    if (!Array.isArray(dailyEquity) || dailyEquity.length === 0) return [];
    const withDD = computeDrawdown(dailyEquity);
    return downsample(withDD, MAX_POINTS);
  }, [dailyEquity]);

  const maxDD = useMemo(() => {
    if (data.length === 0) return null;
    return data.reduce((m, r) => Math.min(m, r.drawdownPct ?? 0), 0);
  }, [data]);

  if (data.length === 0) {
    return (
      <ChartPanel title="Drawdown" subtitle="No daily equity data on this run">
        <div className="h-[160px] flex items-center justify-center text-xs text-neutral-500 font-mono">
          empty
        </div>
      </ChartPanel>
    );
  }

  return (
    <ChartPanel title="Drawdown" subtitle={`Max ${fmtPct(maxDD)} underwater`}>
      <div className="h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
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
              tickFormatter={fmtPct}
              width={55}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="drawdownPct"
              stroke="#f43f5e"
              fill="#f43f5e"
              fillOpacity={0.25}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartPanel>
  );
}
