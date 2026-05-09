import React, { useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, ResponsiveContainer, XAxis, YAxis,
  Tooltip, Cell, CartesianGrid,
} from 'recharts';
import { tierColor } from './lib/formatters.jsx';
import { useBacktest } from './hooks/useBacktest.js';

// Co-located helpers (used only inside this view).
const KpiCard = ({ label, value, color = 'neutral' }) => {
  const colorClass = color === 'emerald' ? 'text-emerald-400' : color === 'rose' ? 'text-rose-400' : 'text-neutral-200';
  return (
    <div className="border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4">
      <div className="text-[9px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-1.5">{label}</div>
      <div className={`text-xl sm:text-2xl font-mono font-semibold tabular-nums ${colorClass}`}>{value}</div>
    </div>
  );
};

const ChartPanel = ({ title, subtitle, children, className = '' }) => (
  <div className={`border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4 ${className}`}>
    <div className="flex items-baseline justify-between mb-3">
      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">{title}</div>
        {subtitle && <div className="text-[10px] text-neutral-600 font-mono mt-0.5">{subtitle}</div>}
      </div>
    </div>
    {children}
  </div>
);

export const BacktestView = () => {
  const [lookback, setLookback] = useState(365);
  const [windowDays, setWindowDays] = useState(20); // 5, 10, or 20 day forward window
  const { data, error, isLoading: loading, refetch } = useBacktest(lookback);

  if (loading && !data) {
    return (
      <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Running backtest across 10 tickers, 18 months of history…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
        <div className="border border-rose-800/50 bg-rose-950/20 p-6 text-rose-300 font-mono text-sm">
          Backtest failed: {error?.message ?? String(error)}
          <button onClick={() => refetch()} className="ml-4 underline">retry</button>
        </div>
      </div>
    );
  }

  if (!data || !data.summary) {
    return (
      <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Backtest data unavailable.
          <button onClick={() => refetch()} className="ml-4 underline">retry</button>
        </div>
      </div>
    );
  }

  const summary = data.summary;
  const windowKey = `fwd${windowDays}`;
  const overall = summary[windowKey] || {};

  const byTier = data.byTier || {};
  const byDirection = data.byDirection || {};
  const tierChartData = ['A', 'B', 'C'].map(tier => {
    const s = byTier[tier]?.[windowKey] || {};
    return {
      tier: `Tier ${tier}`,
      winRate: ((s.winRate || 0) * 100),
      avgReturn: ((s.avgReturn || 0) * 100),
      alpha: ((s.avgAlphaVsSPY || 0) * 100),
      n: byTier[tier]?.n || 0,
    };
  });

  const dirChartData = ['long', 'short'].map(dir => {
    const s = byDirection[dir]?.[windowKey] || {};
    return {
      direction: dir === 'long' ? 'Long' : 'Short',
      winRate: ((s.winRate || 0) * 100),
      avgReturn: ((s.avgReturn || 0) * 100),
      alpha: ((s.avgAlphaVsSPY || 0) * 100),
      n: data.byDirection[dir]?.n || 0,
    };
  });

  const tradesSample = data.trades?.sample || data.trades || [];
  const sortedTrades = tradesSample
    .filter(t => typeof t[windowKey] === 'number')
    .slice()
    .sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));

  let cumLong = 0, cumShort = 0, cumAll = 0;
  const equityData = sortedTrades.map((t, i) => {
    const alpha = (t[`${windowKey}_alpha`] || 0) * 100;
    cumAll += alpha;
    if (t.direction === 'long') cumLong += alpha;
    else if (t.direction === 'short') cumShort += alpha;
    return {
      idx: i,
      date: t.entryDate,
      cumAlpha: +cumAll.toFixed(2),
      cumLong: +cumLong.toFixed(2),
      cumShort: +cumShort.toFixed(2),
    };
  });

  const rets = tradesSample.map(t => (t[windowKey] || 0) * 100).filter(v => !isNaN(v));
  const buckets = [-20, -10, -5, -2, 0, 2, 5, 10, 20];
  const distData = [];
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i], hi = buckets[i + 1];
    const label = i === 0 ? `<${hi}%` : i === buckets.length - 2 ? `>${lo}%` : `${lo} to ${hi}`;
    const count = rets.filter(r => r >= lo && r < hi).length;
    distData.push({ bucket: label, count, positive: lo >= 0 });
  }

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-5">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Backtest</div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight">
            {summary.n ?? 0} <span className="text-neutral-500 italic font-light">historical trades</span>
          </h1>
          <div className="text-[11px] font-mono text-neutral-500 mt-2">
            {data.config?.from ?? '—'} → {data.config?.to ?? '—'} · 10 mega-caps · sampled every {data.config?.sampleEvery ?? '—'}d
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
          <span className="text-neutral-500 uppercase tracking-widest">Window</span>
          {[5, 10, 20].map(w => (
            <button
              key={w}
              onClick={() => setWindowDays(w)}
              className={`px-2 h-7 ${windowDays === w ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'}`}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <KpiCard label="Win Rate" value={`${((overall.winRate || 0) * 100).toFixed(1)}%`} color={overall.winRate > 0.5 ? 'emerald' : 'rose'} />
        <KpiCard label="Avg Return" value={`${((overall.avgReturn || 0) * 100).toFixed(2)}%`} color={overall.avgReturn > 0 ? 'emerald' : 'rose'} />
        <KpiCard label={`Alpha vs SPY`} value={`${((overall.avgAlphaVsSPY || 0) * 100).toFixed(2)}%`} color={overall.avgAlphaVsSPY > 0 ? 'emerald' : 'rose'} />
        <KpiCard label="Sharpe" value={(overall.sharpe || 0).toFixed(2)} color={overall.sharpe > 0 ? 'emerald' : 'rose'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <ChartPanel title="Performance by Tier" subtitle={`${windowDays}-day forward`}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={tierChartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="#1f2023" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="tier" stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} />
              <YAxis stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} tickFormatter={v => `${v}%`} />
              <Tooltip contentStyle={{ background: '#0a0b0d', border: '1px solid #2a2b2e', fontSize: 12 }} />
              <Bar dataKey="winRate" fill="#14e89a" name="Win Rate %" />
              <Bar dataKey="alpha" fill="#4dbaf2" name="Alpha vs SPY %" />
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>

        <ChartPanel title="Long vs Short" subtitle={`${windowDays}-day forward`}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={dirChartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="#1f2023" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="direction" stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} />
              <YAxis stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} tickFormatter={v => `${v}%`} />
              <Tooltip contentStyle={{ background: '#0a0b0d', border: '1px solid #2a2b2e', fontSize: 12 }} />
              <Bar dataKey="winRate" fill="#14e89a" name="Win Rate %" />
              <Bar dataKey="alpha" fill="#4dbaf2" name="Alpha vs SPY %" />
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>
      </div>

      <ChartPanel title="Cumulative Alpha vs SPY" subtitle={`${windowDays}-day forward returns, by direction`} className="mb-4">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={equityData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="#1f2023" strokeDasharray="2 4" />
            <XAxis dataKey="idx" stroke="#6b7280" style={{ fontSize: 10, fontFamily: 'monospace' }} tick={false} label={{ value: 'Trade #', position: 'insideBottom', offset: -2, style: { fill: '#6b7280', fontSize: 10 } }} />
            <YAxis stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} tickFormatter={v => `${v}%`} />
            <Tooltip
              contentStyle={{ background: '#0a0b0d', border: '1px solid #2a2b2e', fontSize: 12 }}
              labelFormatter={(i) => equityData[i]?.date || ''}
            />
            <Line type="monotone" dataKey="cumAlpha" stroke="#f3f4f6" strokeWidth={2} dot={false} name="All trades" />
            <Line type="monotone" dataKey="cumLong" stroke="#14e89a" strokeWidth={1.5} dot={false} name="Longs only" />
            <Line type="monotone" dataKey="cumShort" stroke="#ff5577" strokeWidth={1.5} dot={false} name="Shorts only" />
          </LineChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel title="Return Distribution" subtitle={`${windowDays}-day forward returns, all trades`} className="mb-4">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={distData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="#1f2023" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="bucket" stroke="#6b7280" style={{ fontSize: 10, fontFamily: 'monospace' }} />
            <YAxis stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} />
            <Tooltip contentStyle={{ background: '#0a0b0d', border: '1px solid #2a2b2e', fontSize: 12 }} />
            <Bar dataKey="count" name="Trades">
              {distData.map((d, i) => (
                <Cell key={i} fill={d.positive ? '#14e89a' : '#ff5577'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>

      <div className="border border-neutral-800 bg-neutral-950/40 p-4 sm:p-5 mb-4">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">Findings</div>
        <ul className="space-y-2 text-sm text-neutral-300">
          {data.byDirection?.short?.[windowKey]?.avgAlphaVsSPY < -0.01 && (
            <li className="flex gap-2">
              <span className="text-rose-400">▾</span>
              <span>Shorts underperform by <span className="text-rose-400 font-semibold">{((data.byDirection.short[windowKey].avgAlphaVsSPY) * 100).toFixed(1)}%</span> alpha — disabled in production by default.</span>
            </li>
          )}
          {data.byTier?.A?.[windowKey]?.avgAlphaVsSPY > 0.005 && (
            <li className="flex gap-2">
              <span className="text-emerald-400">▴</span>
              <span>Tier A generates <span className="text-emerald-400 font-semibold">+{((data.byTier.A[windowKey].avgAlphaVsSPY) * 100).toFixed(1)}%</span> alpha at {(data.byTier.A[windowKey].winRate * 100).toFixed(0)}% win rate.</span>
            </li>
          )}
          {data.byTier?.C?.[windowKey]?.winRate < 0.5 && (
            <li className="flex gap-2">
              <span className="text-neutral-500">•</span>
              <span>Tier C is below 50% win rate — current score floor (60) is effective.</span>
            </li>
          )}
        </ul>
      </div>

      <ChartPanel title={`Recent Trades (${Math.min(20, sortedTrades.length)} of ${summary.n})`} subtitle="Sorted by entry date">
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-[11px] font-mono">
            <thead className="text-neutral-500 border-b border-neutral-800">
              <tr>
                <th className="text-left px-2 py-2">Date</th>
                <th className="text-left px-2 py-2">Ticker</th>
                <th className="text-left px-2 py-2">Tier</th>
                <th className="text-left px-2 py-2">Dir</th>
                <th className="text-right px-2 py-2">Score</th>
                <th className="text-right px-2 py-2">{windowDays}d Ret</th>
                <th className="text-right px-2 py-2">{windowDays}d α</th>
              </tr>
            </thead>
            <tbody>
              {sortedTrades.slice(-20).reverse().map((t, i) => (
                <tr key={i} className="border-b border-neutral-900 hover:bg-neutral-900/30">
                  <td className="px-2 py-1.5 text-neutral-400">{t.entryDate}</td>
                  <td className="px-2 py-1.5 text-neutral-100 font-semibold">{t.ticker}</td>
                  <td className="px-2 py-1.5" style={{ color: tierColor(t.tier) }}>{t.tier}</td>
                  <td className={`px-2 py-1.5 ${t.direction === 'long' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.direction}</td>
                  <td className="px-2 py-1.5 text-right text-neutral-300">{t.composite}</td>
                  <td className={`px-2 py-1.5 text-right ${(t[windowKey] || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {((t[windowKey] || 0) * 100).toFixed(2)}%
                  </td>
                  <td className={`px-2 py-1.5 text-right ${(t[`${windowKey}_alpha`] || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {((t[`${windowKey}_alpha`] || 0) * 100).toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartPanel>

      <div className="text-[10px] text-neutral-600 font-mono mt-4 text-center">
        Technical + sector-rotation analysts only · news/fundamental/flow not backtested (historical data gaps)
      </div>
    </div>
  );
};
