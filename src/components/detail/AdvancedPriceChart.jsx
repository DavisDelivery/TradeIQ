// Advanced charting — finviz-grade, TradingView lightweight-charts v5.
// Panes are built on demand from the indicator toggles:
//   pane 0 — candles/line/area + overlays: SMA 20/50/150/200, EMA 9/21,
//            Bollinger(20,2), VWAP, optional strategy price lines
//   +pane  — volume histogram (toggle)
//   +pane  — RSI(14, Wilder) with 30/70 bands (toggle)
//   +pane  — MACD(12,26,9): line + signal + histogram (toggle)
//
// The indicator toolbar works like a pro charting app — click to toggle any
// overlay/pane; choices persist to localStorage so every chart in the app
// opens the way you left it. Crosshair OHLCV legend, range + chart-type +
// log-scale toggles, autosizing. Data rides the shared usePriceHistory hook.

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
  { key: 'sma20', period: 20, color: '#38bdf8', label: 'MA20' },
  { key: 'sma50', period: 50, color: '#f59e0b', label: 'MA50' },
  { key: 'sma150', period: 150, color: '#a78bfa', label: 'MA150' },
  { key: 'sma200', period: 200, color: '#f43f5e', label: 'MA200' },
];
const EMA_DEFS = [
  { key: 'ema9', period: 9, color: '#22d3ee', label: 'EMA9' },
  { key: 'ema21', period: 21, color: '#e879f9', label: 'EMA21' },
];
const UP = '#14e89a';
const DOWN = '#ff5577';
const BB_COLOR = '#8b9467';
const VWAP_COLOR = '#eab308';

// ---- persisted indicator prefs ----
const IND_KEY = 'tradeiq-chart-indicators';
const IND_DEFAULTS = {
  sma20: false, sma50: true, sma150: false, sma200: true,
  ema9: false, ema21: false, bb: false, vwap: false,
  volume: true, rsi: false, macd: false,
};
function loadInd() {
  try {
    const s = JSON.parse(localStorage.getItem(IND_KEY));
    return s && typeof s === 'object' ? { ...IND_DEFAULTS, ...s } : { ...IND_DEFAULTS };
  } catch { return { ...IND_DEFAULTS }; }
}

// ---- indicator math ----
function sma(v, period) {
  const out = new Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= period) sum -= v[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function ema(v, period) {
  const out = new Array(v.length).fill(null);
  const k = 2 / (period + 1);
  let sum = 0, prev = null;
  for (let i = 0; i < v.length; i++) {
    if (i < period) { sum += v[i]; if (i === period - 1) { prev = sum / period; out[i] = prev; } continue; }
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) { const d = closes[j] - mid[i]; s += d * d; }
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}
function vwapSeries(bars) {
  const out = new Array(bars.length).fill(null);
  let cumPV = 0, cumV = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tp = (b.high + b.low + b.close) / 3;
    const v = b.volume ?? 0;
    cumPV += tp * v; cumV += v;
    out[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return out;
}
function rsi14(closes) {
  const out = new Array(closes.length).fill(null);
  const P = 14;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = Math.max(0, ch), loss = Math.max(0, -ch);
    if (i <= P) {
      avgGain += gain / P; avgLoss += loss / P;
      if (i === P) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (P - 1) + gain) / P;
      avgLoss = (avgLoss * (P - 1) + loss) / P;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}
function macd(closes) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const line = closes.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
  const sig = new Array(closes.length).fill(null);
  const k = 2 / (9 + 1);
  let prev = null, count = 0, sum = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] == null) continue;
    count++;
    if (count < 9) { sum += line[i]; if (count === 9) { prev = sum / 9; sig[i] = prev; } continue; }
    prev = line[i] * k + prev * (1 - k);
    sig[i] = prev;
  }
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { line, sig, hist };
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
  const [logScale, setLogScale] = useState(false);
  const [ind, setInd] = useState(loadInd);
  const [legend, setLegend] = useState(null);
  const elRef = useRef(null);
  const chartRef = useRef(null);

  const toggle = (key) => setInd((cur) => {
    const next = { ...cur, [key]: !cur[key] };
    try { localStorage.setItem(IND_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });

  const query = usePriceHistory(ticker, range);
  const bars = useMemo(() => {
    const raw = query.data?.bars ?? [];
    return raw
      .filter((b) => b && b.close != null && b.open != null && b.high != null && b.low != null)
      .map((b) => ({ ...b, time: toTime(b.date) }));
  }, [query.data]);

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
    const closes = bars.map((b) => b.close);
    const overlay = (values, opts) => {
      const pts = bars.map((b, i) => ({ time: b.time, value: values[i] })).filter((p) => p.value != null);
      if (pts.length < 2) return;
      const s = chart.addSeries(LineSeries, {
        lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opts,
      });
      s.setData(pts);
    };

    // --- pane 0: price
    let priceSeries;
    if (type === 'Candles') {
      priceSeries = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false,
      });
      priceSeries.setData(bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
    } else if (type === 'Area') {
      priceSeries = chart.addSeries(AreaSeries, {
        lineColor: UP, topColor: 'rgba(20,232,154,0.25)', bottomColor: 'rgba(20,232,154,0.02)', lineWidth: 2,
      });
      priceSeries.setData(bars.map((b) => ({ time: b.time, value: b.close })));
    } else {
      priceSeries = chart.addSeries(LineSeries, { color: UP, lineWidth: 2 });
      priceSeries.setData(bars.map((b) => ({ time: b.time, value: b.close })));
    }

    // Overlays: SMA, EMA, Bollinger, VWAP
    for (const d of SMA_DEFS) if (ind[d.key]) overlay(sma(closes, d.period), { color: d.color });
    for (const d of EMA_DEFS) if (ind[d.key]) overlay(ema(closes, d.period), { color: d.color });
    if (ind.bb) {
      const b = bollinger(closes, 20, 2);
      overlay(b.upper, { color: BB_COLOR });
      overlay(b.lower, { color: BB_COLOR });
      overlay(b.mid, { color: BB_COLOR, lineStyle: 2 });
    }
    if (ind.vwap) overlay(vwapSeries(bars), { color: VWAP_COLOR, lineWidth: 2 });

    // Strategy price lines (FABLE entry pivot / stop)
    for (const pl of priceLines) {
      if (pl?.price == null || !Number.isFinite(Number(pl.price))) continue;
      priceSeries.createPriceLine({
        price: Number(pl.price), color: pl.color ?? '#38bdf8', lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: pl.title ?? '',
      });
    }

    // Sub-panes are assigned in order so there are never empty panes.
    let paneIdx = 1;
    const volPane = ind.volume ? paneIdx++ : null;
    const rsiPane = ind.rsi ? paneIdx++ : null;
    const macdPane = ind.macd ? paneIdx++ : null;

    if (volPane != null) {
      const volSeries = chart.addSeries(
        HistogramSeries,
        { priceFormat: { type: 'volume' }, priceScaleId: 'right', lastValueVisible: false, priceLineVisible: false },
        volPane,
      );
      volSeries.setData(bars.map((b) => ({
        time: b.time, value: b.volume ?? 0,
        color: b.close >= b.open ? 'rgba(20,232,154,0.45)' : 'rgba(255,85,119,0.45)',
      })));
    }

    if (rsiPane != null) {
      const r = rsi14(closes);
      const rsiSeries = chart.addSeries(
        LineSeries, { color: '#e2b93b', lineWidth: 1, priceLineVisible: false, lastValueVisible: true }, rsiPane,
      );
      rsiSeries.setData(bars.map((b, i) => ({ time: b.time, value: r[i] })).filter((p) => p.value != null));
      for (const level of [30, 70]) {
        rsiSeries.createPriceLine({ price: level, color: 'rgba(115,115,115,0.6)', lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: '' });
      }
    }

    if (macdPane != null) {
      const m = macd(closes);
      const histSeries = chart.addSeries(
        HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, macdPane,
      );
      histSeries.setData(bars.map((b, i) => ({
        time: b.time, value: m.hist[i], color: (m.hist[i] ?? 0) >= 0 ? 'rgba(20,232,154,0.5)' : 'rgba(255,85,119,0.5)',
      })).filter((p) => p.value != null));
      const macdLine = chart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, macdPane);
      macdLine.setData(bars.map((b, i) => ({ time: b.time, value: m.line[i] })).filter((p) => p.value != null));
      const sigLine = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, macdPane);
      sigLine.setData(bars.map((b, i) => ({ time: b.time, value: m.sig[i] })).filter((p) => p.value != null));
    }

    // Sub-pane heights stay compact; price keeps the room.
    try {
      const panes = chart.panes();
      if (volPane != null && panes[volPane]) panes[volPane].setHeight(64);
      if (rsiPane != null && panes[rsiPane]) panes[rsiPane].setHeight(90);
      if (macdPane != null && panes[macdPane]) panes[macdPane].setHeight(90);
    } catch { /* pane sizing is cosmetic — never fatal */ }

    const onMove = (param) => {
      const cd = param?.seriesData?.get(priceSeries);
      if (!cd) { setLegend(null); return; }
      const bar = bars.find((b) => b.time === param.time);
      if (!bar) { setLegend(null); return; }
      setLegend({
        date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
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
  }, [bars, type, logScale, ind, priceLines]);

  const last = bars[bars.length - 1];
  const shown = legend ?? (last
    ? { date: last.date, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume,
        chg: last.open ? ((last.close - last.open) / last.open) * 100 : null }
    : null);

  const subPanes = [ind.volume, ind.rsi, ind.macd].filter(Boolean).length;
  const mountHeight = 320 + subPanes * 96;

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
                {shown.chg >= 0 ? '+' : ''}{shown.chg.toFixed(2)}%
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 mb-2">
        {RANGES.map((r) => <Chip key={r} active={range === r} onClick={() => setRange(r)}>{r}</Chip>)}
        <span className="mx-1 h-3 w-px bg-neutral-800" />
        {TYPES.map((t) => <Chip key={t} active={type === t} onClick={() => setType(t)}>{t}</Chip>)}
        <span className="mx-1 h-3 w-px bg-neutral-800" />
        {SMA_DEFS.map((d) => <Chip key={d.key} color={d.color} active={ind[d.key]} onClick={() => toggle(d.key)}>{d.label}</Chip>)}
        {EMA_DEFS.map((d) => <Chip key={d.key} color={d.color} active={ind[d.key]} onClick={() => toggle(d.key)}>{d.label}</Chip>)}
        <Chip color={BB_COLOR} active={ind.bb} onClick={() => toggle('bb')}>BB</Chip>
        <Chip color={VWAP_COLOR} active={ind.vwap} onClick={() => toggle('vwap')}>VWAP</Chip>
        <span className="mx-1 h-3 w-px bg-neutral-800" />
        <Chip active={ind.volume} onClick={() => toggle('volume')}>Vol</Chip>
        <Chip active={ind.rsi} onClick={() => toggle('rsi')}>RSI</Chip>
        <Chip active={ind.macd} onClick={() => toggle('macd')}>MACD</Chip>
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
      <div ref={elRef} style={{ height: mountHeight, display: bars.length ? 'block' : 'none' }} data-testid="chart-mount" />
      {priceLines.length > 0 && (
        <p className="mt-1 text-[10px] font-mono text-neutral-600">
          dashed lines: {priceLines.map((p) => `${p.title} $${Number(p.price).toFixed(2)}`).join(' · ')}
        </p>
      )}
    </section>
  );
}
