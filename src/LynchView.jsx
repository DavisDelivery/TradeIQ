import React, { useState } from 'react';
import { Shield } from 'lucide-react';
import { LogButton } from './components/LogButton.jsx';
import { FreshnessPill } from './components/FreshnessPill.jsx';
import { useLynch } from './hooks/useLynch.js';
import { useSortable, SortableTh } from './lib/useSortable.jsx';

const VERDICT_RANK = { BUY: 3, HOLD: 2, AVOID: 1 };

const VERDICT_STYLES = {
  BUY: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  HOLD: 'text-neutral-400 border-neutral-700 bg-neutral-900/40',
  AVOID: 'text-rose-300 border-rose-500/40 bg-rose-500/10',
};

function normalize(c) {
  const sig = c.signal ?? {};
  return {
    ...c,
    verdict: sig.verdict ?? 'HOLD',
    verdictRank: VERDICT_RANK[sig.verdict ?? 'HOLD'] ?? 0,
    fairValueLow: sig.fairValueLow ?? null,
    fairValueHigh: sig.fairValueHigh ?? null,
    peg: sig.peg ?? c.signals?.peg ?? null,
  };
}

export const LynchView = ({ universe = 'sp500' }) => {
  const [expandedKey, setExpandedKey] = useState(null);
  const { data, error, isLoading: loading, isFetching, forceRescan } = useLynch(universe);
  const isRescanning = isFetching && !loading;
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('verdictRank', 'desc');

  const rows = (data?.candidates ?? []).map(normalize);
  const sorted = sortRows(rows);

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
      <header className="mb-5 sm:mb-6">
        <div className="flex items-baseline gap-3 mb-2">
          <Shield className="h-4 w-4 text-emerald-400" />
          <h1 className="text-xl sm:text-2xl font-serif font-semibold text-neutral-100">
            Peter Lynch Picks
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
          GARP (Growth At Reasonable Price). PEG ratio under 1, consistent earnings,
          low debt. Discrete BUY/HOLD/AVOID with a fair-value band and a
          fundamental-invalidation list — no price stops. 6&ndash;24 month horizons.
        </p>
      </header>

      {loading && !data && (
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Pulling fundamentals for {universe === 'all' ? 'full universe' : universe.toUpperCase()}...
          <div className="text-[10px] text-neutral-600 mt-2">
            This scan hits Polygon financials + Finnhub earnings — slower than Williams.
          </div>
        </div>
      )}

      {error && (
        <div className="border border-rose-800/50 bg-rose-950/20 p-4 text-rose-300 font-mono text-sm">
          Lynch scan failed: {error?.message ?? String(error)}
          <button onClick={() => forceRescan()} className="ml-4 underline">retry</button>
        </div>
      )}

      {data && (
        <>
          <div className="text-[11px] text-neutral-500 font-mono mb-3">
            Scanned {data.scanned}/{data.universeSize} · {data.scored} with sufficient data · {data.count} returned
          </div>

          {sorted.length === 0 ? (
            <div className="border border-neutral-800 p-6 text-neutral-500 font-mono text-sm text-center">
              No Lynch setups meeting the criteria. Try expanding the index filter.
            </div>
          ) : (
            <div className="border border-neutral-800 overflow-x-auto">
              <table className="w-full text-[12px] font-mono">
                <thead className="bg-neutral-900/40 text-[10px] uppercase tracking-widest text-neutral-500">
                  <tr>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="verdictRank" align="left">Verdict</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ticker" align="left">Ticker</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="score" align="right">Score</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="peg" align="right">PEG</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="price" align="right">Price</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="fairValueLow" align="right">FV Low</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="fairValueHigh" align="right">FV High</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="signals.epsGrowthYoYPct" align="right">EPS YoY</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="signals.debtToEquity" align="right">D/E</SortableTh>
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
                          <td className={`px-3 py-2.5 text-right tabular-nums ${
                            c.peg == null ? 'text-neutral-500'
                              : c.peg < 1 ? 'text-emerald-400'
                              : c.peg > 2 ? 'text-rose-400'
                              : 'text-neutral-300'
                          }`}>
                            {c.peg != null ? c.peg.toFixed(2) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">
                            {c.price != null ? c.price.toFixed(2) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">
                            {c.fairValueLow != null ? c.fairValueLow.toFixed(2) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">
                            {c.fairValueHigh != null ? c.fairValueHigh.toFixed(2) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-400">
                            {c.signals?.epsGrowthYoYPct !== undefined
                              ? `${c.signals.epsGrowthYoYPct > 0 ? '+' : ''}${c.signals.epsGrowthYoYPct}%`
                              : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-400">
                            {c.signals?.debtToEquity ?? '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-500">
                            {Number.isFinite(c.confidence) ? `${(c.confidence * 100).toFixed(0)}%` : '—'}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-t border-neutral-800/60 bg-neutral-950/60">
                            <td colSpan={10} className="px-3 py-3">
                              <LynchDetail c={c} />
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

const LynchDetail = ({ c }) => {
  const isLong = c.score > 0;
  const conditions = c.signal?.invalidationConditions ?? [];
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-neutral-300 leading-relaxed">{c.rationale}</p>
      {c.signal?.reasons?.length > 0 && (
        <div className="text-[11px] text-neutral-500">
          <span className="text-neutral-600">Drivers:</span>{' '}
          {c.signal.reasons.join(' · ')}
        </div>
      )}
      {c.fairValueLow != null && c.fairValueHigh != null && (
        <div className="text-[11px] text-neutral-400 font-mono">
          Fair-value band:{' '}
          <span className="text-emerald-300">${c.fairValueLow.toFixed(2)}</span>{' '}
          –{' '}
          <span className="text-emerald-300">${c.fairValueHigh.toFixed(2)}</span>
          {c.price != null && (
            <span className="text-neutral-500">
              {' '}
              (price ${c.price.toFixed(2)}
              {c.price > c.fairValueHigh ? ', above ceiling' : c.price < c.fairValueLow ? ', below floor' : ', inside band'})
            </span>
          )}
        </div>
      )}
      {conditions.length > 0 && (
        <div className="text-[11px] text-neutral-500">
          <div className="text-neutral-600 mb-1">Thesis breaks if:</div>
          <ul className="list-disc list-inside space-y-0.5 text-neutral-400">
            {conditions.map((cond, i) => (
              <li key={i}>{cond}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-neutral-500">
        {c.signals?.peRatio !== undefined && <span>PE {c.signals.peRatio}</span>}
        {c.signals?.revGrowthYoYPct !== undefined && (
          <span>Rev YoY {c.signals.revGrowthYoYPct > 0 ? '+' : ''}{c.signals.revGrowthYoYPct}%</span>
        )}
        {c.signals?.operatingMarginPct !== undefined && (
          <span>OM {c.signals.operatingMarginPct}%</span>
        )}
        {c.signals?.beats4q !== undefined && (
          <span>Beats {c.signals.beats4q}/4</span>
        )}
      </div>
      <div className="flex justify-end">
        <LogButton
          size="xs"
          payload={{
            ticker: c.ticker,
            source: 'lynch',
            loggedPrice: c.price ?? c.signals?.price,
            composite: Math.round(c.score),
            direction: isLong ? 'long' : 'short',
            rationale: c.rationale,
            signals: { ...c.signals, verdict: c.verdict, fairValueLow: c.fairValueLow, fairValueHigh: c.fairValueHigh },
          }}
        />
      </div>
    </div>
  );
};
