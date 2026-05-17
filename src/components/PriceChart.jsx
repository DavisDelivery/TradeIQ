// Phase 4j W4 — PriceChart component for the detail panel.
//
// Default view: area chart of the close price for the selected range.
// Toggle: switch to a candlestick view via a custom recharts shape
// (rectangle body + high/low wick) layered on a ComposedChart.
//
// Range toggle: 1M / 6M / 1Y / All. Default 6M (Chad's decision -
// matches what he sees on first open).
//
// Data source: GET /api/price-history?ticker=X&range=R, which is
// cached per-day in Firestore so a repeat open of the same panel costs
// one Polygon call total per ticker per day.
//
// Responsive: the chart container is height: 16rem on phone and
// 18-20rem on >=sm; width fills the parent. Uses recharts
// ResponsiveContainer so it adapts to whatever the detail panel's
// modal column gives it - phone (narrow) or desktop (wide).

import React, { useState, useEffect, useMemo } from 'react';
import {
  AreaChart, Area, ComposedChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { LineChart as LineChartIcon, Activity, AlertTriangle } from 'lucide-react';

const RANGES = ['1M', '6M', '1Y', 'All'];
const DEFAULT_RANGE = '6M';
const EMERALD = '#14e89a';
const ROSE = '#ff5577';

// ---------------------------------------------------------------------------
// Candlestick custom shape
// ---------------------------------------------------------------------------
//
// Recharts has no built-in candlestick chart. The standard pattern is to
// render each bar with a custom shape: a body rectangle drawn between
// the open and close, with a thin wick line from high to low. We pull
// the precomputed `wickTop`, `wickBottom`, `bodyTop`, `bodyBottom`, and
// the bullish-flag from the data row so the shape function can map them
// to screen Y coords without recomputing per-frame.

function Candle(props) {
  const { x, width, payload, yAxis } = props;
  if (!payload || !yAxis || !yAxis.scale) return null;
  const scale = yAxis.scale;
  const cx = x + width / 2;
  const yHigh = scale(payload.high);
  const yLow = scale(payload.low);
  const yOpen = scale(payload.open);
  const yClose = scale(payload.close);
  const yBodyTop = Math.min(yOpen, yClose);
  const yBodyBottom = Math.max(yOpen, yClose);
  const bullish = payload.close >= payload.open;
  const color = bullish ? EMERALD : ROSE;
  const bodyWidth = Math.max(2, width * 0.7);
  const bodyX = cx - bodyWidth / 2;
  const bodyHeight = Math.max(1, yBodyBottom - yBodyTop);
  return (
    <g>
      <line x1={cx} x2={cx} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1} />
      <rect
        x={bodyX}
        y={yBodyTop}
        width={bodyWidth}
        height={bodyHeight}
        fill={color}
        opacity={bullish ? 0.8 : 0.95}
      />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Tick + tooltip formatters
// ---------------------------------------------------------------------------

function formatPriceTick(v) {
  if (typeof v !== 'number') return '';
  if (v >= 1000) return v.toFixed(0);
  return v.toFixed(2);
}

function formatDateTick(s, range) {
  if (!s) return '';
  // Show "Jan 26" for short ranges, "Jan '24" for >=1Y.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  if (range === '1M' || range === '6M') {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function CustomTooltip({ active, payload, mode }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  if (!row) return null;
  return (
    <div className="border border-neutral-700 bg-[#0a0b0d]/95 px-3 py-2 text-[11px] font-mono text-neutral-200">
      <div className="text-neutral-500 mb-1">{row.date}</div>
      {mode === 'area' ? (
        <div>Close <span className="text-emerald-400 ml-2">${row.close?.toFixed(2)}</span></div>
      ) : (
        <>
          <div>O <span className="text-neutral-300">${row.open?.toFixed(2)}</span></div>
          <div>H <span className="text-neutral-300">${row.high?.toFixed(2)}</span></div>
          <div>L <span className="text-neutral-300">${row.low?.toFixed(2)}</span></div>
          <div>C <span className={row.close >= row.open ? 'text-emerald-400' : 'text-rose-400'}>${row.close?.toFixed(2)}</span></div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PriceChart
// ---------------------------------------------------------------------------

export function PriceChart({ ticker }) {
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [mode, setMode] = useState('area'); // 'area' | 'candle'
  const [bars, setBars] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/price-history?ticker=${encodeURIComponent(ticker)}&range=${range}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
        return json;
      })
      .then((json) => {
        if (cancelled) return;
        setBars(json.bars ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message ?? String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ticker, range]);

  // Derived domain - tight to data so movement is visible. Recharts'
  // 'auto' Y domain on a low-volatility stock can flatten the line.
  const yDomain = useMemo(() => {
    if (!bars?.length) return ['auto', 'auto'];
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of bars) {
      if (b.low < lo) lo = b.low;
      if (b.high > hi) hi = b.high;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return ['auto', 'auto'];
    const pad = Math.max((hi - lo) * 0.05, 0.01);
    return [lo - pad, hi + pad];
  }, [bars]);

  const firstClose = bars?.[0]?.close;

  return (
    <div className="border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">Price History</div>
          {bars && bars.length > 0 && firstClose != null && (
            <PriceDelta from={firstClose} to={bars[bars.length - 1].close} />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Range toggle */}
          <div className="flex items-center bg-neutral-900/60 border border-neutral-800">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-2.5 h-7 text-[11px] font-mono uppercase tracking-wider transition-colors ${
                  range === r ? 'bg-emerald-500/15 text-emerald-400' : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          {/* Chart-type toggle */}
          <button
            onClick={() => setMode((m) => (m === 'area' ? 'candle' : 'area'))}
            className="flex items-center gap-1.5 px-2.5 h-7 border border-neutral-800 bg-neutral-900/60 text-[11px] font-mono uppercase tracking-wider text-neutral-300 hover:text-neutral-100 hover:border-neutral-700"
            title={mode === 'area' ? 'Switch to candlestick' : 'Switch to area'}
            aria-label="Toggle chart type"
          >
            {mode === 'area' ? <Activity className="h-3 w-3" /> : <LineChartIcon className="h-3 w-3" />}
            {mode === 'area' ? 'Candle' : 'Area'}
          </button>
        </div>
      </div>

      <div className="h-56 sm:h-64 md:h-72">
        {loading ? (
          <ChartSkeleton />
        ) : error ? (
          <ChartError message={error} />
        ) : !bars || bars.length === 0 ? (
          <ChartEmpty />
        ) : mode === 'area' ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={bars} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={EMERALD} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={EMERALD} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                stroke="#404245"
                tick={{ fill: '#737373', fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                tickFormatter={(v) => formatDateTick(v, range)}
                minTickGap={32}
              />
              <YAxis
                domain={yDomain}
                stroke="#404245"
                tick={{ fill: '#737373', fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                tickFormatter={formatPriceTick}
                width={48}
              />
              <Tooltip content={<CustomTooltip mode="area" />} />
              {firstClose != null && (
                <ReferenceLine y={firstClose} stroke="#404245" strokeDasharray="3 3" />
              )}
              <Area
                type="monotone"
                dataKey="close"
                stroke={EMERALD}
                strokeWidth={1.5}
                fill="url(#priceFill)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={bars} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="date"
                stroke="#404245"
                tick={{ fill: '#737373', fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                tickFormatter={(v) => formatDateTick(v, range)}
                minTickGap={32}
              />
              <YAxis
                domain={yDomain}
                stroke="#404245"
                tick={{ fill: '#737373', fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                tickFormatter={formatPriceTick}
                width={48}
              />
              <Tooltip content={<CustomTooltip mode="candle" />} />
              <Bar
                dataKey="high"
                shape={Candle}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function PriceDelta({ from, to }) {
  if (from == null || to == null || from === 0) return null;
  const pct = ((to - from) / from) * 100;
  const cls = pct >= 0 ? 'text-emerald-400' : 'text-rose-400';
  return (
    <span className={`text-[11px] font-mono tabular-nums ${cls}`}>
      {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
    </span>
  );
}

function ChartSkeleton() {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="inline-block h-5 w-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
    </div>
  );
}

function ChartError({ message }) {
  return (
    <div className="h-full w-full flex items-center justify-center text-center px-4">
      <div>
        <AlertTriangle className="h-4 w-4 mx-auto text-rose-500 mb-2" />
        <div className="text-[12px] text-neutral-400">Price history unavailable</div>
        <div className="text-[10px] text-neutral-600 font-mono mt-1 break-all">{message}</div>
      </div>
    </div>
  );
}

function ChartEmpty() {
  return (
    <div className="h-full w-full flex items-center justify-center text-center px-4">
      <div className="text-[12px] text-neutral-500 font-mono">
        No price history for this range
      </div>
    </div>
  );
}

// Exposed for tests.
export const _internals = { RANGES, DEFAULT_RANGE, Candle };
