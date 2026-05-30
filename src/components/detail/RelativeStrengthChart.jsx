// Phase 6 PR-C — relative-strength chart for the StockDetailPanel.
//
// Plots cumulative outperformance vs the broad market (SPY) and the
// ticker's sector ETF, over ~1 year. The data is pre-computed server-
// side and returned by /api/stock-detail under `relativeStrength`:
//   {
//     vsSpy:    [{ date, cumulativeOutperformancePct }, ...],
//     vsSector: [{ date, cumulativeOutperformancePct }, ...],
//     sectorEtf: 'XLK' | null,
//     _reason?: string,
//   }
//
// No second fetch — the same useStockDetail call that powers the metrics
// grid + catalysts feed also carries this series. One ticker = one fetch.
//
// Both series are aligned on the same date scale; a 0% reference line
// makes "is the stock beating its benchmark?" a one-glance answer.
// Honest no-data: when stockDetail is loading the chart shows a skeleton;
// when the relativeStrength series is empty with a `_reason`, that's
// surfaced as an explicit message.

import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid, Legend } from 'recharts';
import { AlertTriangle } from 'lucide-react';
import { useStockDetail } from '../../hooks/useStockDetail.js';

const SPY_COLOR = '#14e89a';   // emerald — broad-market comparison
const SECTOR_COLOR = '#1e5b92'; // brand blue — sector ETF comparison

function formatTickDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleString('en-US', { month: 'short', year: '2-digit' });
}

function formatPctTick(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return `${v > 0 ? '+' : ''}${v.toFixed(0)}%`;
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-neutral-950/95 border border-neutral-800 px-3 py-2 text-[11px] font-mono">
      <div className="text-neutral-500 mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-3" style={{ color: p.color }}>
          <span>{p.name}</span>
          <span>{`${p.value > 0 ? '+' : ''}${Number(p.value).toFixed(2)}%`}</span>
        </div>
      ))}
    </div>
  );
}

export function RelativeStrengthChart({ ticker }) {
  const { data, isLoading, isError, error, refetch } = useStockDetail(ticker);
  const rs = data?.relativeStrength;
  const vsSpy = Array.isArray(rs?.vsSpy) ? rs.vsSpy : [];
  const vsSector = Array.isArray(rs?.vsSector) ? rs.vsSector : [];
  const sectorEtf = rs?.sectorEtf ?? null;

  // Merge the two series by date for a single chart. We keep both even
  // when the sector ETF is unavailable; the sector line just won't render.
  const byDate = new Map();
  for (const p of vsSpy) {
    if (p?.date) byDate.set(p.date, { date: p.date, vsSpy: Number(p.cumulativeOutperformancePct) });
  }
  for (const p of vsSector) {
    if (!p?.date) continue;
    const existing = byDate.get(p.date) ?? { date: p.date };
    existing.vsSector = Number(p.cumulativeOutperformancePct);
    byDate.set(p.date, existing);
  }
  const merged = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));

  const latest = merged[merged.length - 1];

  return (
    <section
      data-testid="relative-strength-chart"
      className="border border-neutral-800/80 bg-neutral-950/30 p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <div className="flex items-baseline gap-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
            Relative Strength
          </div>
          <div className="text-[10px] font-mono text-neutral-500">
            1y cumulative outperformance
          </div>
        </div>
        {latest && (
          <div className="flex gap-3 text-[11px] font-mono">
            {latest.vsSpy != null && Number.isFinite(latest.vsSpy) && (
              <div style={{ color: SPY_COLOR }}>
                vs SPY {latest.vsSpy > 0 ? '+' : ''}{latest.vsSpy.toFixed(1)}%
              </div>
            )}
            {latest.vsSector != null && Number.isFinite(latest.vsSector) && sectorEtf && (
              <div style={{ color: SECTOR_COLOR }}>
                vs {sectorEtf} {latest.vsSector > 0 ? '+' : ''}{latest.vsSector.toFixed(1)}%
              </div>
            )}
          </div>
        )}
      </header>

      <div className="h-56 sm:h-64 w-full">
        {isLoading && (
          <div className="h-full flex items-center justify-center text-[11px] font-mono uppercase tracking-widest text-neutral-600">
            loading relative strength…
          </div>
        )}
        {!isLoading && isError && (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-3">
            <AlertTriangle className="h-4 w-4 text-rose-400" />
            <div className="text-[11px] font-mono uppercase tracking-widest text-rose-300">
              couldn't load detail bundle
            </div>
            <div className="text-[10px] text-neutral-500 font-mono break-all max-w-md">
              {String(error?.message || 'unknown error')}
            </div>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-1 px-3 h-7 border border-neutral-700 text-[10px] font-mono uppercase tracking-widest text-neutral-300 hover:text-neutral-100 hover:border-neutral-500"
            >
              ↻ retry
            </button>
          </div>
        )}
        {!isLoading && !isError && merged.length === 0 && (
          <div className="h-full flex items-center justify-center text-center px-3 text-[11px] font-mono uppercase tracking-widest text-neutral-600">
            no relative-strength data{rs?._reason ? ` — ${rs._reason}` : ''}
          </div>
        )}
        {!isLoading && !isError && merged.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={merged} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 2" stroke="#1f1f23" />
              <XAxis
                dataKey="date"
                stroke="#525252"
                tickFormatter={formatTickDate}
                fontSize={10}
                minTickGap={32}
              />
              <YAxis
                stroke="#525252"
                domain={['auto', 'auto']}
                tickFormatter={formatPctTick}
                fontSize={10}
                width={48}
                orientation="right"
              />
              <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#1e5b92', strokeWidth: 1 }} />
              <Legend
                verticalAlign="bottom"
                height={20}
                wrapperStyle={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 10, color: '#737373' }}
                iconType="plainline"
              />
              <ReferenceLine y={0} stroke="#525252" strokeDasharray="3 3" />
              <Line
                type="monotone"
                dataKey="vsSpy"
                name="vs SPY"
                stroke={SPY_COLOR}
                strokeWidth={1.5}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
              {sectorEtf && (
                <Line
                  type="monotone"
                  dataKey="vsSector"
                  name={`vs ${sectorEtf}`}
                  stroke={SECTOR_COLOR}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
