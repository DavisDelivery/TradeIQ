// Phase 6 PR-C — price chart for the StockDetailPanel.
//
// A focused, range-toggleable line chart of the close price. Deliberately
// lighter-weight than the legacy Phase 4j PriceChart component (which adds
// a candlestick view + raw-fetch path); this one reads through the
// usePriceHistory hook so per-(ticker, range) fetches are deduped across
// the whole app — every consumer of the same window shares one fetch.
//
// Range toggles match the Phase-6 brief exactly: 1M / 3M / 6M / 1Y / 5Y.
// The 6M window is the default Chad sees on first open (mirrors the
// Phase 4j Chad-default). All-time is intentionally omitted from the
// toggle: it's a 25-year+ pull on a thumb-tap; keep it lean.
//
// Honest no-data: the underlying endpoint emits 400/404/error envelopes;
// loading/error/empty all render explicit states, never a blank panel.

import React, { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceDot, CartesianGrid } from 'recharts';
import { AlertTriangle } from 'lucide-react';
import { usePriceHistory } from '../../hooks/usePriceHistory.js';

const RANGES = ['1M', '3M', '6M', '1Y', '5Y'];
const DEFAULT_RANGE = '6M';
const EMERALD = '#14e89a';
const ROSE = '#ff5577';

function formatTickDate(d, range) {
  if (!d) return '';
  const dt = new Date(d);
  if (range === '5Y' || range === '1Y') {
    return dt.toLocaleString('en-US', { month: 'short', year: '2-digit' });
  }
  return dt.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

function formatPriceTick(v) {
  if (v == null || !Number.isFinite(v)) return '';
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  if (v >= 100) return `$${v.toFixed(0)}`;
  return `$${v.toFixed(2)}`;
}

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.[0]?.payload) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-neutral-950/95 border border-neutral-800 px-3 py-2 text-[11px] font-mono">
      <div className="text-neutral-500 mb-1">{p.date}</div>
      <div className="text-neutral-100">{`Close $${Number(p.close).toFixed(2)}`}</div>
      {p.volume != null && (
        <div className="text-neutral-500">{`Vol ${Number(p.volume).toLocaleString()}`}</div>
      )}
    </div>
  );
}

export function DetailPriceChart({ ticker }) {
  const [range, setRange] = useState(DEFAULT_RANGE);
  const { data, isLoading, isError, error, refetch } = usePriceHistory(ticker, range);

  const bars = Array.isArray(data?.bars) ? data.bars : [];
  const lastBar = bars[bars.length - 1];
  const firstBar = bars[0];
  const deltaPct = firstBar && lastBar && firstBar.close > 0
    ? ((lastBar.close - firstBar.close) / firstBar.close) * 100
    : null;
  const deltaColor = deltaPct == null ? 'text-neutral-500' : deltaPct >= 0 ? 'text-emerald-400' : 'text-rose-400';
  const lineColor = deltaPct == null || deltaPct >= 0 ? EMERALD : ROSE;

  return (
    <section
      data-testid="detail-price-chart"
      className="border border-neutral-800/80 bg-neutral-950/30 p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <div className="flex items-baseline gap-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
            Price Chart
          </div>
          {lastBar && (
            <div className="text-[12px] text-neutral-100 font-mono">
              ${Number(lastBar.close).toFixed(2)}
            </div>
          )}
          {deltaPct != null && (
            <div className={`text-[11px] font-mono ${deltaColor}`}>
              {deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(2)}% {range}
            </div>
          )}
        </div>
        <div role="tablist" aria-label="Time range" className="flex gap-1">
          {RANGES.map((r) => {
            const active = r === range;
            return (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setRange(r)}
                className={
                  'px-2 h-7 text-[10px] font-mono uppercase tracking-widest border transition-colors ' +
                  (active
                    ? 'border-emerald-500/60 text-emerald-300 bg-emerald-500/10'
                    : 'border-neutral-800 text-neutral-500 hover:text-neutral-200 hover:border-neutral-600')
                }
              >
                {r}
              </button>
            );
          })}
        </div>
      </header>

      <div className="h-56 sm:h-64 w-full">
        {isLoading && (
          <div className="h-full flex items-center justify-center text-[11px] font-mono uppercase tracking-widest text-neutral-600">
            loading bars…
          </div>
        )}
        {!isLoading && isError && (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-3">
            <AlertTriangle className="h-4 w-4 text-rose-400" />
            <div className="text-[11px] font-mono uppercase tracking-widest text-rose-300">
              couldn't load bars
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
        {!isLoading && !isError && bars.length === 0 && (
          <div className="h-full flex items-center justify-center text-[11px] font-mono uppercase tracking-widest text-neutral-600">
            no bars in this window
          </div>
        )}
        {!isLoading && !isError && bars.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={bars} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 2" stroke="#1f1f23" />
              <XAxis
                dataKey="date"
                stroke="#525252"
                tickFormatter={(d) => formatTickDate(d, range)}
                fontSize={10}
                minTickGap={28}
              />
              <YAxis
                stroke="#525252"
                domain={['auto', 'auto']}
                tickFormatter={formatPriceTick}
                fontSize={10}
                width={48}
                orientation="right"
              />
              <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#1e5b92', strokeWidth: 1 }} />
              <Line
                type="monotone"
                dataKey="close"
                stroke={lineColor}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              {firstBar && (
                <ReferenceDot x={firstBar.date} y={firstBar.close} r={2} fill="#525252" stroke="none" />
              )}
              {lastBar && (
                <ReferenceDot x={lastBar.date} y={lastBar.close} r={3} fill={lineColor} stroke="none" />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
