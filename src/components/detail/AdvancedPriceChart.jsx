// Advanced charting (Chad, 2026-07-14: "far more comprehensive… I want
// candles"). TradingView lightweight-charts v5, three native panes:
//
//   pane 0 — candlesticks (or line/area), SMA 20/50/150/200 overlays,
//            optional strategy price lines (FABLE entry pivot / stop)
//   pane 1 — volume histogram, up/down colored
//   pane 2 — RSI(14, Wilder) with 30/70 bands (toggle)
//
// Plus: crosshair OHLCV legend, range toggles (1M–5Y), chart-type toggle,
// log/linear scale, autosizing. Data rides the existing usePriceHistory
// hook — same dedupe/caching as the rest of the app, no new endpoints.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  HistogramSeries,
  CrosshairMode,
  PriceScaleMode,
} from 'lightweight-charts';
import { AlertTriangle } from 'lucide-react';
import { usePriceHistory } from '../../hooks/usePriceHistory.js';

const RANGES = ['1M', '3M', '6M', '1Y', '5Y'];
const DEFAULT_RANGE = '6M';
const TYPES = ['Candles', 'Line', 'Area'];
const SMA_DEFS = [
  { period: 20, color: '#38bdf8' },
  { period: 50, color: '#f59e0b' },
  { period: 150, color: '#a78bfa' },
  { period: 200, color: '#f43f5e' },
];
const UP = '#14e89a';
const DOWN = '#ff5577';

function sma(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function rsi14(closes) {
  const out = new Array(closes.length).fill(null);
  const P = 14;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = Math.max(0, ch);
    const loss = Math.max(0, -ch);
    if (i <= P) {
      avgGain += gain / P;
      avgLoss += loss / P;
      if (i === P) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (P - 1) + gain) / P;
      avgLoss = (avgLoss * (P - 1) + loss) / P;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

/** "YYYY-MM-DD" or "YYYY-MM-DD HH:mm" → lightweight-charts time value. */
function toTime(dateStr) {
  if (dateStr.length > 10) return Math.floor(Date.parse(dateStr.replace(' ', 'T') + ':00Z') / 1000);
  return dateStr;
}

const fmtVol = (v) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : `${v}`;

function Chip({ active, onClick, children, color }) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[11px] font-mono transition-colors ${
        active ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
      }`}
      style={active && color ? { color } : undefined}
    >
      {children}
    </button>
  );
}

export function AdvancedPriceChart({ ticker, priceLines = [] }) {
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [type, setType] = useState('Candles');
  const [smas, setSmas] = useState([50, 200]);
  const [showRsi, setShowRsi] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const [legend, setLegend] = useState(null);
  const elRef = useRef(null);
  const chartRef = useRef(null);

  const query = usePriceHistory(ticker, range);
  const bars = useMemo(() => {
    const raw = query.data?.bars ?? [];
    return raw
      .filter((b) => b && b.close != null && b.open != null && b.high != null && b.low != null)
      .map((b) => ({ ...b, time: toTime(b.date) }));
  }, [query.data]);

  // (Re)build the chart whenever data or display options change. Full
  // rebuild keeps the pane/series lifecycle simple and is fast at ≤1300 bars.
  useEffect(() => {
    const el = elRef.current;
    if (!el || bars.length === 0) return undefined;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: '#737373',
        fontSize: 10,
        panes: { separatorColor: '#262626', enableResize: false },
      },
      grid: {
        vertLines: { color: 'rgba(64,64,64,0.18)' },
        horzLines: { color: 'rgba(64,64,64,0.18)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: '#262626',
        mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      },
      timeScale: { borderColor: '#262626', timeVisible: bars[0]?.date?.length > 10 },
    });
    chartRef.current = chart;

    // --- pane 0: price
    let priceSeries;
    if (type === 'Candles') {
      priceSeries = chart.addSeries(CandlestickSeries, {
        upColor: UP,
        downColor: DOWN,
        wickUpColor: UP,
        wickDownColor: DOWN,
        borderVisible: false,
      });
      priceSeries.setData(
        bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })),
      );
    } else if (type === 'Area') {
      priceSeries = chart.addSeries(AreaSeries, {
        lineColor: UP,
        topColor: 'rgba(20,232,154,0.25)',
        bottomColor: 'rgba(20,232,154,0.02)',
        lineWidth: 2,
      });
      priceSeries.setData(bars.map((b) => ({ time: b.time, value: b.close })));
    } else {
      priceSeries = chart.addSeries(LineSeries, { color: UP, lineWidth: 2 });
      priceSeries.setData(bars.map((b) => ({ time: b.time, value: b.close })));
    }

    // SMA overlays (only those with enough data in-window)
    const closes = bars.map((b) => b.close);
    for (const def of SMA_DEFS) {
      if (!smas.includes(def.period)) continue;
      const values = sma(closes, def.period);
      const pts = bars.map((b, i) => ({ time: b.time, value: values[i] })).filter((p) => p.value != null);
      if (pts.length < 2) continue;
      const s = chart.addSeries(LineSeries, {
        color: def.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      s.setData(pts);
    }

    // Strategy price lines (FABLE entry pivot / stop)
    for (const pl of priceLines) {
      if (pl?.price == null || !Number.isFinite(Number(pl.price))) continue;
      priceSeries.createPriceLine({
        price: Number(pl.price),
        color: pl.color ?? '#38bdf8',
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: pl.title ?? '',
      });
    }

    // --- pane 1: volume
    const volSeries = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceScaleId: 'right', lastValueVisible: false, priceLineVisible: false },
      1,
    );
    volSeries.setData(
      bars.map((b) => ({
        time: b.time,
        value: b.volume ?? 0,
        color: b.close >= b.open ? 'rgba(20,232,154,0.45)' : 'rgba(255,85,119,0.45)',
      })),
    );

    // --- pane 2: RSI
    if (showRsi) {
      const r = rsi14(closes);
      const rsiSeries = chart.addSeries(
        LineSeries,
        { color: '#e2b93b', lineWidth: 1, priceLineVisible: false, lastValueVisible: true },
        2,
      );
      rsiSeries.setData(bars.map((b, i) => ({ time: b.time, value: r[i] })).filter((p) => p.value != null));
      for (const level of [30, 70]) {
        rsiSeries.createPriceLine({
          price: level,
          color: 'rgba(115,115,115,0.6)',
          lineWidth: 1,
          lineStyle: 3,
          axisLabelVisible: false,
          title: '',
        });
      }
    }

    // Pane heights: price gets the room; volume + RSI stay compact.
    try {
      const panes = chart.panes();
      if (panes[1]) panes[1].setHeight(64);
      if (panes[2]) panes[2].setHeight(90);
    } catch {
      /* pane sizing is cosmetic — never fatal */
    }

    // Crosshair legend
    const onMove = (param) => {
      const cd = param?.seriesData?.get(priceSeries);
      if (!cd) {
        setLegend(null);
        return;
      }
      const time = param.time;
      const bar = bars.find((b) => b.time === time);
      if (!bar) {
        setLegend(null);
        return;
      }
      setLegend({
        date: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        chg: bar.open ? ((bar.close - bar.open) / bar.open) * 100 : null,
      });
    };
    chart.subscribeCrosshairMove(onMove);
    chart.timeScale().fitContent();

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, type, smas, showRsi, logScale, priceLines]);

  const last = bars[bars.length - 1];
  const shown = legend ?? (last
    ? {
        date: last.date,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
        volume: last.volume,
        chg: last.open ? ((last.close - last.open) / last.open) * 100 : null,
      }
    : null);

  return (
    <section className="border border-neutral-800/80 bg-neutral-950/30 p-3" data-testid="advanced-price-chart">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">Chart</div>
        {shown && (
          <div className="font-mono text-[11px] text-neutral-400 flex flex-wrap gap-x-2.5" data-testid="ohlc-legend">
            <span className="text-neutral-500">{shown.date}</span>
            <span>O <span className="text-neutral-200">{shown.open?.toFixed(2)}</span></span>
            <span>H <span className="text-neutral-200">{shown.high?.toFixed(2)}</span></span>
            <span>L <span className="text-neutral-200">{shown.low?.toFixed(2)}</span></span>
            <span>C <span className="text-neutral-200">{shown.close?.toFixed(2)}</span></span>
            {shown.volume != null && <span>V <span className="text-neutral-200">{fmtVol(shown.volume)}</span></span>}
            {shown.chg != null && (
              <span style={{ color: shown.chg >= 0 ? UP : DOWN }}>
                {shown.chg >= 0 ? '+' : ''}
                {shown.chg.toFixed(2)}%
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 mb-2">
        {RANGES.map((r) => (
          <Chip key={r} active={range === r} onClick={() => setRange(r)}>{r}</Chip>
        ))}
        <span className="mx-1 h-3 w-px bg-neutral-800" />
        {TYPES.map((t) => (
          <Chip key={t} active={type === t} onClick={() => setType(t)}>{t}</Chip>
        ))}
        <span className="mx-1 h-3 w-px bg-neutral-800" />
        {SMA_DEFS.map((d) => (
          <Chip
            key={d.period}
            color={d.color}
            active={smas.includes(d.period)}
            onClick={() => setSmas((cur) => (cur.includes(d.period) ? cur.filter((p) => p !== d.period) : [...cur, d.period]))}
          >
            MA{d.period}
          </Chip>
        ))}
        <span className="mx-1 h-3 w-px bg-neutral-800" />
        <Chip active={showRsi} onClick={() => setShowRsi(!showRsi)}>RSI</Chip>
        <Chip active={logScale} onClick={() => setLogScale(!logScale)}>Log</Chip>
      </div>

      {query.isLoading && (
        <div className="h-[300px] flex items-center justify-center text-[11px] font-mono uppercase tracking-widest text-neutral-600">
          loading chart…
        </div>
      )}
      {query.isError && (
        <div className="h-[300px] flex flex-col items-center justify-center gap-2 text-[11px] font-mono text-rose-300">
          <AlertTriangle size={16} />
          {String(query.error?.message ?? 'chart data failed')}
          <button onClick={() => query.refetch()} className="underline text-rose-200">retry</button>
        </div>
      )}
      {!query.isLoading && !query.isError && bars.length === 0 && (
        <div className="h-[300px] flex items-center justify-center text-[11px] font-mono uppercase tracking-widest text-neutral-600">
          no price data for this range
        </div>
      )}
      <div
        ref={elRef}
        style={{ height: showRsi ? 460 : 380, display: bars.length ? 'block' : 'none' }}
        data-testid="chart-mount"
      />
      {priceLines.length > 0 && (
        <p className="mt-1 text-[10px] font-mono text-neutral-600">
          dashed lines: {priceLines.map((p) => `${p.title} $${Number(p.price).toFixed(2)}`).join(' · ')}
        </p>
      )}
    </section>
  );
}
