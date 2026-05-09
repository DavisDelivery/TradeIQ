import React, { useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, ComposedChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  ReferenceLine, Cell,
} from 'recharts';
import {
  LineChart as LineChartIcon, TrendingUp, TrendingDown, Minus,
  Brain, Zap, AlertCircle, Search, RefreshCw,
} from 'lucide-react';
import { LogButton } from './components/LogButton.jsx';
import { useChartAnalysis } from './hooks/useChartAnalysis.js';

const QUICK_TICKERS = ['NVDA', 'AAPL', 'MSFT', 'TSLA', 'META', 'GOOGL', 'AMZN', 'SPY'];

export const ChartView = () => {
  const [ticker, setTicker] = useState('NVDA');
  const [input, setInput] = useState('NVDA');

  const { data, error, isLoading: loading, refetch } = useChartAnalysis(ticker, 180);

  const submit = () => {
    const t = input.trim().toUpperCase();
    if (t && t !== ticker) setTicker(t);
    else refetch();
  };

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto pb-20 sm:pb-6">
      <header className="mb-4">
        <div className="flex items-baseline gap-3 mb-2">
          <LineChartIcon className="h-4 w-4 text-emerald-400" />
          <h1 className="text-xl sm:text-2xl font-serif font-semibold text-neutral-100">Chart</h1>
        </div>
        <p className="text-[12px] text-neutral-500 leading-relaxed max-w-2xl">
          Price + indicators + rule-stack signal + Claude narrative. One analysis per ticker, cached 10 minutes.
        </p>
      </header>

      {/* Ticker selector */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex items-center border border-neutral-800 bg-neutral-950/40 flex-1 max-w-xs">
          <Search className="h-3.5 w-3.5 text-neutral-600 ml-2" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="Ticker"
            className="bg-transparent px-2 py-1.5 text-[13px] font-mono text-neutral-100 placeholder-neutral-600 focus:outline-none flex-1 uppercase"
          />
          <button onClick={submit} className="px-2 py-1.5 text-[10px] font-mono text-neutral-400 hover:text-neutral-100 border-l border-neutral-800">GO</button>
        </div>
        <button
          onClick={() => refetch()}
          disabled={loading}
          className="px-2 py-1.5 border border-neutral-800 text-neutral-500 hover:text-neutral-200 disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1 mb-4">
        {QUICK_TICKERS.map((t) => (
          <button
            key={t}
            onClick={() => { setInput(t); setTicker(t); }}
            className={`px-2 py-0.5 text-[10px] font-mono border ${ticker === t ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400' : 'bg-neutral-950/40 border-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
          >{t}</button>
        ))}
      </div>

      {error && (
        <div className="border border-rose-500/30 bg-rose-500/10 p-3 flex items-start gap-2 mb-4">
          <AlertCircle className="h-4 w-4 text-rose-400 flex-shrink-0 mt-0.5" />
          <div className="text-[12px] text-rose-300">{error?.message ?? String(error)}</div>
        </div>
      )}

      {loading && !data && (
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Fetching bars + computing indicators + Claude narrative…
        </div>
      )}

      {data && data.ok && (
        <>
          <SignalHeader data={data} />
          <PricePanel data={data} />
          <VolumePanel data={data} />
          <RsiPanel data={data} />
          <MacdPanel data={data} />
          <NarrativeCard data={data} />
          <SetupsCard data={data} />
        </>
      )}
    </div>
  );
};

const SignalHeader = ({ data }) => {
  const { signal, price, priceChangePct, ticker } = data;
  const sigColor = signal.action === 'BUY' ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
    : signal.action === 'SELL' ? 'text-rose-400 border-rose-500/40 bg-rose-500/10'
    : 'text-neutral-400 border-neutral-700 bg-neutral-900/40';
  const changeColor = (priceChangePct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400';
  const SignalIcon = signal.action === 'BUY' ? TrendingUp : signal.action === 'SELL' ? TrendingDown : Minus;
  const bullPoints = signal.bullPoints ?? [];
  const bearPoints = signal.bearPoints ?? [];
  return (
    <div className="border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4 mb-3">
      <div className="flex items-baseline justify-between flex-wrap gap-3">
        <div className="flex items-baseline gap-3">
          <span className="font-serif font-bold text-2xl sm:text-3xl text-neutral-100">{ticker}</span>
          <span className="font-mono text-lg text-neutral-200">${Number.isFinite(price) ? price.toFixed(2) : '—'}</span>
          <span className={`font-mono text-[13px] ${changeColor}`}>
            {(priceChangePct ?? 0) >= 0 ? '+' : ''}{priceChangePct ?? 0}%
          </span>
        </div>
        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-mono font-bold uppercase tracking-wider border ${sigColor}`}>
          <SignalIcon className="h-3.5 w-3.5" />
          {signal.action}
          <span className="text-[10px] opacity-70 ml-1">{Number.isFinite(signal.confidence) ? (signal.confidence * 100).toFixed(0) : '—'}%</span>
        </div>
        <LogButton
          size="sm"
          payload={{
            ticker,
            source: 'chart',
            loggedPrice: price,
            composite: Math.round((signal.confidence ?? 0) * 100),
            direction: signal.action === 'BUY' ? 'long' : signal.action === 'SELL' ? 'short' : 'neutral',
            rationale: data.narrative || `Rule-stack ${signal.action}: ${bullPoints.concat(bearPoints.map((b) => `(bear: ${b})`)).join('; ')}`,
            signalAction: signal.action,
            signalConfidence: signal.confidence,
          }}
        />
      </div>
      {(bullPoints.length > 0 || bearPoints.length > 0) && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          {bullPoints.map((p, i) => (
            <div key={`bull-${i}`} className="flex items-baseline gap-1.5">
              <span className="text-emerald-500">+</span>
              <span className="text-neutral-400">{p}</span>
            </div>
          ))}
          {bearPoints.map((p, i) => (
            <div key={`bear-${i}`} className="flex items-baseline gap-1.5">
              <span className="text-rose-500">−</span>
              <span className="text-neutral-400">{p}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const chartMargin = { top: 5, right: 10, bottom: 5, left: 0 };
const gridProps = { stroke: '#262626', strokeDasharray: '2 2' };
const axisProps = { stroke: '#525252', fontSize: 10, tick: { fill: '#737373' } };

const PricePanel = ({ data }) => (
  <div className="border border-neutral-800 bg-neutral-950/40 mb-2">
    <div className="px-3 pt-2 flex items-center justify-between">
      <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-500">Price · SMAs</span>
      <span className="text-[10px] font-mono text-neutral-600">
        <span className="text-amber-400">20</span> · <span className="text-sky-400">50</span> · <span className="text-violet-400">200</span>
      </span>
    </div>
    <div className="h-48 sm:h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data.bars} margin={chartMargin}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="date" {...axisProps} minTickGap={40} />
          <YAxis {...axisProps} domain={['dataMin', 'dataMax']} />
          <Tooltip content={<ChartTooltip />} />
          <Line type="monotone" dataKey="c" stroke="#10b981" strokeWidth={1.5} dot={false} name="Price" />
          <Line type="monotone" dataKey="sma20" stroke="#fbbf24" strokeWidth={1} dot={false} name="SMA20" />
          <Line type="monotone" dataKey="sma50" stroke="#38bdf8" strokeWidth={1} dot={false} name="SMA50" />
          <Line type="monotone" dataKey="sma200" stroke="#a78bfa" strokeWidth={1} dot={false} name="SMA200" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  </div>
);

const VolumePanel = ({ data }) => (
  <div className="border border-neutral-800 bg-neutral-950/40 mb-2">
    <div className="px-3 pt-2">
      <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-500">Volume</span>
    </div>
    <div className="h-16">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data.bars} margin={chartMargin}>
          <XAxis dataKey="date" {...axisProps} hide />
          <YAxis {...axisProps} />
          <Tooltip content={<ChartTooltip />} />
          <Bar dataKey="v" fill="#525252">
            {data.bars.map((b, i) => {
              const prev = i > 0 ? data.bars[i - 1] : b;
              return <Cell key={i} fill={b.c >= prev.c ? '#065f46' : '#7f1d1d'} />;
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  </div>
);

const RsiPanel = ({ data }) => {
  const rsi = data?.indicators?.latest?.rsi;
  return (
  <div className="border border-neutral-800 bg-neutral-950/40 mb-2">
    <div className="px-3 pt-2 flex items-center justify-between">
      <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-500">RSI (14)</span>
      <span className="text-[10px] font-mono text-neutral-600">
        latest <span className={
          rsi >= 70 ? 'text-rose-400' :
          rsi <= 30 ? 'text-emerald-400' : 'text-neutral-400'
        }>{Number.isFinite(rsi) ? rsi.toFixed(1) : '—'}</span>
      </span>
    </div>
    <div className="h-24">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data.bars} margin={chartMargin}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="date" {...axisProps} hide />
          <YAxis domain={[0, 100]} ticks={[30, 50, 70]} {...axisProps} />
          <Tooltip content={<ChartTooltip />} />
          <ReferenceLine y={70} stroke="#f43f5e" strokeDasharray="2 2" strokeWidth={1} />
          <ReferenceLine y={30} stroke="#10b981" strokeDasharray="2 2" strokeWidth={1} />
          <Line type="monotone" dataKey="rsi" stroke="#fbbf24" strokeWidth={1.2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  </div>
  );
};

const MacdPanel = ({ data }) => {
  const macdHist = data?.indicators?.latest?.macdHist;
  return (
  <div className="border border-neutral-800 bg-neutral-950/40 mb-3">
    <div className="px-3 pt-2 flex items-center justify-between">
      <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-500">MACD (12, 26, 9)</span>
      <span className="text-[10px] font-mono text-neutral-600">
        hist <span className={macdHist >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
          {Number.isFinite(macdHist) ? macdHist.toFixed(3) : '—'}
        </span>
      </span>
    </div>
    <div className="h-24">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data.bars} margin={chartMargin}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="date" {...axisProps} hide />
          <YAxis {...axisProps} />
          <Tooltip content={<ChartTooltip />} />
          <ReferenceLine y={0} stroke="#525252" strokeWidth={1} />
          <Bar dataKey="macdHist">
            {data.bars.map((b, i) => (
              <Cell key={i} fill={(b.macdHist ?? 0) >= 0 ? '#047857' : '#be123c'} />
            ))}
          </Bar>
          <Line type="monotone" dataKey="macd" stroke="#38bdf8" strokeWidth={1} dot={false} />
          <Line type="monotone" dataKey="macdSignal" stroke="#fbbf24" strokeWidth={1} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  </div>
  );
};

const NarrativeCard = ({ data }) => {
  if (!data.narrative) return null;
  return (
    <div className="border border-emerald-500/20 bg-emerald-500/5 p-3 sm:p-4 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <Brain className="h-3.5 w-3.5 text-emerald-400" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-emerald-400">AI Read · Claude Sonnet</span>
      </div>
      <p className="text-[12px] sm:text-[13px] text-neutral-200 leading-relaxed whitespace-pre-wrap">{data.narrative}</p>
    </div>
  );
};

const SetupsCard = ({ data }) => {
  if (!data.setups?.length) return (
    <div className="border border-neutral-800 p-3 text-[11px] text-neutral-500 font-mono">
      No technical setups detected in current window.
    </div>
  );
  return (
    <div className="border border-neutral-800 bg-neutral-950/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Zap className="h-3.5 w-3.5 text-amber-400" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-amber-400">Detected Setups ({data.setups.length})</span>
      </div>
      <div className="space-y-2">
        {data.setups.map((s, i) => {
          const dirColor = s.direction === 'long' ? 'text-emerald-400' : s.direction === 'short' ? 'text-rose-400' : 'text-neutral-400';
          return (
            <div key={i} className="flex items-start gap-2 text-[11px]">
              <span className={`font-mono uppercase text-[10px] tracking-wider min-w-[60px] ${dirColor}`}>{s.direction}</span>
              <div className="flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-neutral-200">{s.label}</span>
                  <span className="text-neutral-600 font-mono text-[10px]">{Number.isFinite(s.strength) ? (s.strength * 100).toFixed(0) : '—'}%</span>
                </div>
                <div className="text-neutral-500 text-[11px] leading-relaxed">{s.rationale}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-neutral-900 border border-neutral-700 p-2 text-[10px] font-mono">
      <div className="text-neutral-500 mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(2) : p.value}
        </div>
      ))}
    </div>
  );
};
