// Phase 4j W4 — PriceChart component for the detail panel.
// DESK-1 W3 — upgraded IN PLACE (shared component, not a fork):
//   - volume sub-pane (recharts syncId panes — no new dependency)
//   - SMA 20/50/200 overlays (pure math from src/lib/indicators.js)
//   - optional RSI(14) pane toggle
//   - crosshair tooltip with full OHLC + volume in both modes
//   - range toggles 1D 5D 1M 6M 1Y All; 1D/5D hide themselves when the
//     backend reports intradayUnavailable (Polygon plan-gated)
//
// Default view: area chart of the close price for the selected range.
// Toggle: switch to a candlestick view via a custom recharts shape.
// Default range 6M (Chad's decision - matches what he sees on first open).
//
// Data source: GET /api/price-history?ticker=X&range=R (Firestore-cached
// per day for daily ranges; 5-min TTL for intraday).

import React, { useState, useEffect, useMemo } from 'react';
import {
  ComposedChart, Area, Line, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { LineChart as LineChartIcon, Activity, AlertTriangle } from 'lucide-react';
import { sma, rsi } from '../lib/indicators.js';

const RANGES = ['1D', '5D', '1M', '6M', '1Y', 'All'];
const INTRADAY_RANGES = new Set(['1D', '5D']);
const DEFAULT_RANGE = '6M';
const EMERALD = '#14e89a';
const ROSE = '#ff5577';
const SMA_STYLES = [
  { key: 'sma20', period: 20, color: '#4dbaf2', label: 'SMA20' },
  { key: 'sma50', period: 50, color: '#e2b93b', label: 'SMA50' },
  { key: 'sma200', period: 200, color: '#b06ee8', label: 'SMA200' },
];

// ---------------------------------------------------------------------------
// Candlestick custom shape
// ---------------------------------------------------------------------------
//
// Recharts has no built-in candlestick chart. The standard pattern is to
// render each bar with a custom shape: a body rectangle drawn between
// the open and close, with a thin wick line from high to low.

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

function formatVolumeTick(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(v);
}

function formatDateTick(s, range) {
  if (!s) return '';
  if (INTRADAY_RANGES.has(range) && s.includes(' ')) {
    // "YYYY-MM-DD HH:mm" — show the time for 1D, day+time for 5D.
    const [day, time] = s.split(' ');
    if (range === '1D') return time;
    const d = new Date(`${day}T00:00:00Z`);
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${time}`;
  }
  // Show "Jan 26" for short ranges, "Jan '24" for >=1Y.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  if (range === '1M' || range === '6M' || INTRADAY_RANGES.has(range)) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

// DESK-1 W3 — full OHLC + volume crosshair tooltip in BOTH modes.
function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  if (!row) return null;
  return (
    <div className="border border-neutral-700 bg-[#0a0b0d]/95 px-3 py-2 text-[11px] font-mono text-neutral-200 tabular-nums">
      <div className="text-neutral-500 mb-1">{row.date}</div>
      <div>O <span className="text-neutral-300">${row.open?.toFixed(2)}</span></div>
      <div>H <span className="text-neutral-300">${row.high?.toFixed(2)}</span></div>
      <div>L <span className="text-neutral-300">${row.low?.toFixed(2)}</span></div>
      <div>C <span className={row.close >= row.open ? 'text-emerald-400' : 'text-rose-400'}>${row.close?.toFixed(2)}</span></div>
      <div>V <span className="text-neutral-300">{formatVolumeTick(row.volume) || '—'}</span></div>
      {SMA_STYLES.map(({ key, label, color }) =>
        row[key] != null ? (
          <div key={key}>{label} <span style={{ color }}>${row[key].toFixed(2)}</span></div>
        ) : null,
      )}
      {row.rsi14 != null && <div>RSI <span className="text-neutral-300">{row.rsi14.toFixed(1)}</span></div>}
    </div>
  );
}

function RsiTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  if (!row || row.rsi14 == null) return null;
  return (
    <div className="border border-neutral-700 bg-[#0a0b0d]/95 px-2 py-1 text-[11px] font-mono text-neutral-200 tabular-nums">
      RSI(14) {row.rsi14.toFixed(1)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PriceChart
// ---------------------------------------------------------------------------

export function PriceChart({ ticker }) {
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [mode, setMode] = useState('area'); // 'area' | 'candle'
  const [showRsi, setShowRsi] = useState(false);
  const [bars, setBars] = useState(null);
  const [intradayUnavailable, setIntradayUnavailable] = useState(false);
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
        // Plan-gated intraday: hide the 1D/5D toggles and, if we're ON
        // one of them, fall back to 6M so the label matches the data.
        if (json.intradayUnavailable) {
          setIntradayUnavailable(true);
          if (INTRADAY_RANGES.has(range)) setRange(DEFAULT_RANGE);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message ?? String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ticker, range]);

  const visibleRanges = intradayUnavailable
    ? RANGES.filter((r) => !INTRADAY_RANGES.has(r))
    : RANGES;

  // Enrich bars with indicator series (index-aligned nulls) — pure math,
  // memoized per bars payload.
  const data = useMemo(() => {
    if (!bars?.length) return [];
    const closes = bars.map((b) => b.close);
    const smaSeries = SMA_STYLES.map(({ key, period }) => ({ key, values: sma(closes, period) }));
    const rsiSeries = rsi(closes, 14);
    return bars.map((b, i) => {
      const row = { ...b, rsi14: rsiSeries[i] };
      for (const { key, values } of smaSeries) row[key] = values[i];
      return row;
    });
  }, [bars]);

  // Derived domain - tight to data so movement is visible.
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
  const hasVolume = useMemo(
    () => (bars ?? []).some((b) => typeof b.volume === 'number' && b.volume > 0),
    [bars],
  );
  const syncId = `pricechart-${ticker}`;

  const xAxisProps = {
    dataKey: 'date',
    stroke: '#404245',
    tick: { fill: '#737373', fontSize: 10, fontFamily: 'IBM Plex Mono' },
    tickFormatter: (v) => formatDateTick(v, range),
    minTickGap: 32,
  };
  const yAxisProps = {
    domain: yDomain,
    stroke: '#404245',
    tick: { fill: '#737373', fontSize: 10, fontFamily: 'IBM Plex Mono' },
    tickFormatter: formatPriceTick,
    width: 48,
  };

  const smaLines = SMA_STYLES.map(({ key, color }) => (
    <Line
      key={key}
      type="monotone"
      dataKey={key}
      stroke={color}
      strokeWidth={1}
      dot={false}
      connectNulls={false}
      isAnimationActive={false}
    />
  ));

  return (
    <div className="border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">Price History</div>
          {bars && bars.length > 0 && firstClose != null && (
            <PriceDelta from={firstClose} to={bars[bars.length - 1].close} />
          )}
          {/* SMA legend */}
          <div className="hidden sm:flex items-center gap-2">
            {SMA_STYLES.map(({ key, label, color }) => (
              <span key={key} className="text-[9px] font-mono uppercase tracking-wider" style={{ color }}>
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Range toggle */}
          <div className="flex items-center bg-neutral-900/60 border border-neutral-800">
            {visibleRanges.map((r) => (
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
          {/* RSI pane toggle */}
          <button
            onClick={() => setShowRsi((v) => !v)}
            aria-label="Toggle RSI pane"
            className={`px-2.5 h-7 border text-[11px] font-mono uppercase tracking-wider transition-colors ${
              showRsi
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                : 'border-neutral-800 bg-neutral-900/60 text-neutral-500 hover:text-neutral-300'
            }`}
          >
            RSI
          </button>
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

      {loading ? (
        <div className="h-56 sm:h-64 md:h-72"><ChartSkeleton /></div>
      ) : error ? (
        <div className="h-56 sm:h-64 md:h-72"><ChartError message={error} /></div>
      ) : !bars || bars.length === 0 ? (
        <div className="h-56 sm:h-64 md:h-72"><ChartEmpty /></div>
      ) : (
        <>
          {/* Main price pane */}
          <div className="h-48 sm:h-56 md:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} syncId={syncId} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={EMERALD} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={EMERALD} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis {...xAxisProps} hide={hasVolume || showRsi} />
                <YAxis {...yAxisProps} />
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ stroke: '#525252', strokeDasharray: '2 2' }}
                />
                {firstClose != null && (
                  <ReferenceLine y={firstClose} stroke="#404245" strokeDasharray="3 3" />
                )}
                {mode === 'area' ? (
                  <Area
                    type="monotone"
                    dataKey="close"
                    stroke={EMERALD}
                    strokeWidth={1.5}
                    fill="url(#priceFill)"
                    isAnimationActive={false}
                  />
                ) : (
                  <Bar dataKey="high" shape={Candle} isAnimationActive={false} />
                )}
                {smaLines}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Volume sub-pane */}
          {hasVolume && (
            <div className="h-16 sm:h-20 mt-1" data-testid="volume-pane">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} syncId={syncId} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                  <XAxis {...xAxisProps} hide={showRsi} />
                  <YAxis
                    stroke="#404245"
                    tick={{ fill: '#737373', fontSize: 9, fontFamily: 'IBM Plex Mono' }}
                    tickFormatter={formatVolumeTick}
                    width={48}
                  />
                  <Tooltip content={() => null} cursor={{ fill: 'rgba(82,82,82,0.15)' }} />
                  <Bar dataKey="volume" isAnimationActive={false} fill="#3f4650" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Optional RSI pane */}
          {showRsi && (
            <div className="h-16 sm:h-20 mt-1" data-testid="rsi-pane">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} syncId={syncId} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                  <XAxis {...xAxisProps} />
                  <YAxis
                    domain={[0, 100]}
                    ticks={[30, 70]}
                    stroke="#404245"
                    tick={{ fill: '#737373', fontSize: 9, fontFamily: 'IBM Plex Mono' }}
                    width={48}
                  />
                  <Tooltip content={<RsiTooltip />} cursor={{ stroke: '#525252', strokeDasharray: '2 2' }} />
                  <ReferenceLine y={70} stroke="#7f1d1d" strokeDasharray="3 3" />
                  <ReferenceLine y={30} stroke="#14532d" strokeDasharray="3 3" />
                  <Line
                    type="monotone"
                    dataKey="rsi14"
                    stroke="#4dbaf2"
                    strokeWidth={1}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
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
export const _internals = { RANGES, DEFAULT_RANGE, Candle, INTRADAY_RANGES, SMA_STYLES };
