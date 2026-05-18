import React, { useState } from 'react';
import { Activity } from 'lucide-react';
import { LogButton } from './components/LogButton.jsx';
import { FreshnessPill } from './components/FreshnessPill.jsx';
import { useWilliams } from './hooks/useWilliams.js';
import { useSortable, SortableTh } from './lib/useSortable.jsx';

const SIDE_OPTIONS = [
  { id: 'both', label: 'Both' },
  { id: 'long', label: 'Long' },
  { id: 'short', label: 'Short' },
];

// Sort priority for the discrete verdict. BUY > HOLD > SELL when sorting
// ascending; reverse when descending. Putting HOLD in the middle keeps
// the actionable rows grouped at the top/bottom regardless of direction.
const VERDICT_RANK = { BUY: 3, HOLD: 2, SELL: 1 };

function normalize(c) {
  return {
    ...c,
    verdict: c.signal?.verdict ?? 'HOLD',
    verdictRank: VERDICT_RANK[c.signal?.verdict ?? 'HOLD'] ?? 0,
    entry: c.signal?.entry ?? null,
    stop: c.signal?.stop ?? null,
    target: c.signal?.target ?? null,
    atr: c.signal?.atr ?? null,
    riskPerShare: c.signal?.riskPerShare ?? null,
  };
}

const VERDICT_STYLES = {
  BUY: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  SELL: 'text-rose-300 border-rose-500/40 bg-rose-500/10',
  HOLD: 'text-neutral-400 border-neutral-700 bg-neutral-900/40',
};

export const WilliamsView = ({ universe = 'sp500' }) => {
  const [side, setSide] = useState('both');
  const [expandedKey, setExpandedKey] = useState(null);
  const { data, error, isLoading: loading, isFetching, forceRescan } = useWilliams(universe, side);
  const isRescanning = isFetching && !loading;
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('verdictRank', 'desc');

  const rows = (data?.candidates ?? []).map(normalize);
  const sorted = sortRows(rows);

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
          closing-strength confirmation, trend-aligned entries. Discrete BUY/SELL/HOLD
          with ATR-based entry, stop, and 3R target. Best used for 3&ndash;10 day swings.
        </p>
      </header>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="flex gap-1 sm:ml-auto">
          {SIDE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setSide(opt.id)}
              className={`px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                side === opt.id
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                  : 'bg-neutral-950/40 border-neutral-800 text-neutral-400 hover:border-neutral-700'
              }`}
            >
              {opt.label}
            </button>
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
          <button onClick={() => forceRescan()} className="ml-4 underline">retry</button>
        </div>
      )}

      {data && (
        <>
          <div className="text-[11px] text-neutral-500 font-mono mb-3">
            Scanned {data.scored}/{data.universeSize} · {data.count} setups returned
          </div>

          {sorted.length === 0 ? (
            <div className="border border-neutral-800 p-6 text-center text-neutral-500 font-mono text-sm">
              No Williams setups in this slice.
            </div>
          ) : (
            <div className="border border-neutral-800 overflow-x-auto">
              <table className="w-full text-[12px] font-mono">
                <thead className="bg-neutral-900/40 text-[10px] uppercase tracking-widest text-neutral-500">
                  <tr>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="verdictRank" align="left">Verdict</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ticker" align="left">Ticker</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="score" align="right">Score</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="entry" align="right">Entry</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="stop" align="right">Stop</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="target" align="right">Target</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="atr" align="right">ATR</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="signals.williamsR" align="right">%R</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="confidence" align="right">Conf</SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((c) => {
                    const isOpen = expandedKey === c.ticker;
                    return (
                      <React.Fragment key={c.ticker}>
                        <tr
                          onClick={() => setExpandedKey(isOpen ? null : c.ticker)}
                          className={`border-t border-neutral-800/60 cursor-pointer transition-colors ${
                            isOpen ? 'bg-neutral-900/40' : 'hover:bg-neutral-900/20'
                          }`}
                        >
                          <td className="px-3 py-2.5">
                            <VerdictPill verdict={c.verdict} />
                          </td>
                          <td className="px-3 py-2.5 font-serif font-bold text-neutral-100 text-[13px]">
                            {c.ticker}
                            <span className="ml-2 text-[10px] text-neutral-500 font-mono font-normal">{c.name}</span>
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums font-bold ${c.score >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {(c.score ?? 0) > 0 ? '+' : ''}{(c.score ?? 0).toFixed(0)}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">
                            {c.entry != null ? c.entry.toFixed(2) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-rose-300/80">
                            {c.stop != null ? c.stop.toFixed(2) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-emerald-300/80">
                            {c.target != null ? c.target.toFixed(2) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-400">
                            {c.atr != null ? c.atr.toFixed(2) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-400">
                            {c.signals?.williamsR ?? '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-500">
                            {Number.isFinite(c.confidence) ? `${(c.confidence * 100).toFixed(0)}%` : '—'}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-t border-neutral-800/60 bg-neutral-950/60">
                            <td colSpan={9} className="px-3 py-3">
                              <WilliamsDetail c={c} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const VerdictPill = ({ verdict }) => (
  <span
    className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border ${
      VERDICT_STYLES[verdict] ?? VERDICT_STYLES.HOLD
    }`}
  >
    {verdict}
  </span>
);

const WilliamsDetail = ({ c }) => {
  const isLong = c.side === 'long';
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-neutral-300 leading-relaxed">{c.rationale}</p>
      {c.signal?.reasons?.length > 0 && (
        <div className="text-[11px] text-neutral-500">
          <span className="text-neutral-600">Confluence:</span>{' '}
          {c.signal.reasons.join(' · ')}
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-neutral-500">
        {c.signals?.volBreakoutLong && <span className="text-emerald-400">VOL-BREAKOUT ↑</span>}
        {c.signals?.volBreakoutShort && <span className="text-rose-400">VOL-BREAKOUT ↓</span>}
        {c.signals?.uptrend && <span className="text-emerald-400">TREND ↑</span>}
        {c.signals?.downtrend && <span className="text-rose-400">TREND ↓</span>}
        {c.signals?.closeStrength10d !== undefined && (
          <span>close-str {c.signals.closeStrength10d}%</span>
        )}
        {c.riskPerShare != null && (
          <span>
            risk ${c.riskPerShare.toFixed(2)}/sh · R:R {c.signal?.riskRewardRatio?.toFixed(1) ?? '—'}:1
          </span>
        )}
      </div>
      <div className="flex justify-end">
        <LogButton
          size="xs"
          payload={{
            ticker: c.ticker,
            source: 'williams',
            loggedPrice: c.entry ?? c.price ?? c.signals?.close,
            composite: c.score,
            direction: isLong ? 'long' : 'short',
            rationale: c.rationale,
            signals: { ...c.signals, verdict: c.verdict, entry: c.entry, stop: c.stop, target: c.target },
          }}
        />
      </div>
    </div>
  );
};
