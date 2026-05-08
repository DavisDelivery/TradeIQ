import React, { useState } from 'react';
import { TrendingUp, TrendingDown, Activity, Zap } from 'lucide-react';
import { LogButton } from './components/LogButton.jsx';
import { FreshnessPill } from './components/FreshnessPill.jsx';
import { useWilliams } from './hooks/useWilliams.js';

const SIDE_OPTIONS = [
  { id: 'both', label: 'Both' },
  { id: 'long', label: 'Long' },
  { id: 'short', label: 'Short' },
];

export const WilliamsView = ({ universe = 'sp500' }) => {
  const [side, setSide] = useState('both');
  const { data, error, isLoading: loading, isFetching, forceRescan } = useWilliams(universe, side);
  const isRescanning = isFetching && !loading;

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
      <header className="mb-5 sm:mb-6">
        <div className="flex items-baseline gap-3 mb-2">
          <Activity className="h-4 w-4 text-emerald-400" />
          <h1 className="text-xl sm:text-2xl font-serif font-semibold text-neutral-100">
            Williams Setups
          </h1>
          <div className="ml-auto">
            <FreshnessPill
              meta={data}
              isRescanning={isRescanning}
              onForceRescan={() => forceRescan()}
            />
          </div>
        </div>
        <p className="text-[12px] text-neutral-500 leading-relaxed max-w-2xl">
          Larry Williams style: volatility breakouts, Williams %R momentum reversals,
          closing-strength confirmation, trend-aligned entries. Best used for 3&ndash;10
          day swing trades with tight stops.
        </p>
      </header>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="flex gap-1 sm:ml-auto">
          {SIDE_OPTIONS.map(opt => (
            <button key={opt.id} onClick={() => setSide(opt.id)}
              className={`px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                side === opt.id
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                  : 'bg-neutral-950/40 border-neutral-800 text-neutral-400 hover:border-neutral-700'
              }`}
            >{opt.label}</button>
          ))}
        </div>
      </div>

      {loading && !data && (
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Scanning {universe === 'all' ? 'full universe' : universe.toUpperCase()}...
        </div>
      )}

      {error && (
        <div className="border border-rose-800/50 bg-rose-950/20 p-4 text-rose-300 font-mono text-sm">
          Williams scan failed: {error?.message ?? String(error)}
          <button onClick={load} className="ml-4 underline">retry</button>
        </div>
      )}

      {data && (
        <>
          <div className="text-[11px] text-neutral-500 font-mono mb-3">
            Scanned {data.scored}/{data.universeSize} · {data.count} setups returned
          </div>
          <div className="space-y-2">
            {data.candidates.map((c, i) => (
              <WilliamsCard key={c.ticker} c={c} rank={i + 1} />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

const WilliamsCard = ({ c, rank }) => {
  const isLong = c.side === 'long';
  const color = isLong ? 'emerald' : 'rose';
  return (
    <div className={`border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4 border-l-2 ${
      isLong ? 'border-l-emerald-500/60' : 'border-l-rose-500/60'
    }`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="font-mono text-[11px] text-neutral-600 tabular-nums">
            #{rank}
          </span>
          <span className="font-serif text-lg font-semibold text-neutral-100">
            {c.ticker}
          </span>
          <span className="text-[11px] text-neutral-500 truncate">{c.name}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isLong ? <TrendingUp className="h-3.5 w-3.5 text-emerald-400" /> : <TrendingDown className="h-3.5 w-3.5 text-rose-400" />}
          <span className={`font-mono font-semibold tabular-nums ${isLong ? 'text-emerald-400' : 'text-rose-400'}`}>
            {(c.score ?? 0) > 0 ? '+' : ''}{(c.score ?? 0).toFixed(0)}
          </span>
        </div>
      </div>
      <p className="text-[12px] text-neutral-400 leading-relaxed mb-2">{c.rationale}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-neutral-500">
        <span>%R: {c.signals?.williamsR ?? '—'}</span>
        {c.signals?.volBreakoutLong && <span className="text-emerald-400">VOL-BREAKOUT ↑</span>}
        {c.signals?.volBreakoutShort && <span className="text-rose-400">VOL-BREAKOUT ↓</span>}
        {c.signals?.uptrend && <span className="text-emerald-400">TREND ↑</span>}
        {c.signals?.downtrend && <span className="text-rose-400">TREND ↓</span>}
        <span>close-str {c.signals?.closeStrength10d ?? '—'}%</span>
        <span className="ml-auto text-neutral-600">conf {Number.isFinite(c.confidence) ? (c.confidence * 100).toFixed(0) : '—'}%</span>
      </div>
      <div className="mt-2 flex justify-end">
        <LogButton
          size="xs"
          payload={{
            ticker: c.ticker,
            source: 'williams',
            loggedPrice: c.signals?.close ?? c.price,
            composite: c.score,
            direction: c.side,
            rationale: c.rationale,
          }}
        />
      </div>
    </div>
  );
};
