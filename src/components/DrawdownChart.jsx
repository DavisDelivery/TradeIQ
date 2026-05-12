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
import { ChartPanel } from './ChartPanel.jsx';

// Phase 4b — drawdown ("underwater") chart.
//
// The engine writes dailyEquity {date, value} only — no drawdownPct field.
// We compute it client-side here: running peak from the start, then
// (value / peak) - 1 expressed as a non-positive percent. Max DD value
// matches metrics.maxDrawdownPct (engine's mdd is the min of this series).
//
// Recharts AreaChart with the fill below zero gives the classic underwater
// shape. Y-axis clamps at 0 so the chart visually anchors to the surface.

const DOWNSAMPLE_THRESHOLD = 5000;

function computeUnderwater(rows) {
  let peak = -Infinity;
  return rows.map((r) => {
    const v = Number(r.value);
    if (!Number.isFinite(v)) return { date: r.date, drawdownPct: 0 };
    if (v > peak) peak = v;
    const dd = peak > 0 ? (v / peak - 1) * 100 : 0;
    return { date: r.date, drawdownPct: +dd.toFixed(2) };
  });
}

function downsampleStride(rows, target) {
  if (rows.length <= target) return rows;
  const stride = Math.ceil(rows.length / target);
  const out = [];
  for (let i = 0; i < rows.length; i += stride) out.push(rows[i]);
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out;
}

function TooltipBody({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  const dd = payload[0]?.value;
  return (
    <div className="border border-neutral-700 bg-neutral-950/95 px-2 py-1.5 font-mono text-[10px]">
      <div className="text-neutral-400 mb-1">{label}</div>
      <div className="text-rose-300 tabular-nums">
        {dd == null ? '—' : `${Number(dd).toFixed(2)}%`}
      </div>
    </div>
  );
}

export function DrawdownChart({ dailyEquity }) {
  const data = useMemo(() => {
    const rows = Array.isArray(dailyEquity) ? dailyEquity : [];
    const underwater = computeUnderwater(rows);
    return downsampleStride(underwater, DOWNSAMPLE_THRESHOLD);
  }, [dailyEquity]);

  const worst = useMemo(() => {
    if (data.length === 0) return null;
    return Math.min(...data.map((d) => d.drawdownPct));
  }, [data]);

  if (data.length === 0) {
    return (
      <ChartPanel title="Drawdown" subtitle="Underwater % from running peak">
        <div className="text-neutral-500 font-mono text-[11px] text-center py-8">
          No equity series in run.
        </div>
      </ChartPanel>
    );
  }

  return (
    <ChartPanel
      title="Drawdown"
      subtitle={`Underwater % from running peak${worst != null ? ` · max ${worst.toFixed(2)}%` : ''}`}
    >
      <div className="h-[180px]" data-testid="drawdown-chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="ddGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.05} />
                <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.45} />
              </linearGradient>
            </defs>
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
              tickFormatter={(v) => `${v}%`}
              width={45}
              domain={[(dataMin) => Math.floor(dataMin), 0]}
            />
            <Tooltip content={<TooltipBody />} />
            <Area
              type="monotone"
              dataKey="drawdownPct"
              stroke="#f43f5e"
              strokeWidth={1.25}
              fill="url(#ddGradient)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartPanel>
  );
}
