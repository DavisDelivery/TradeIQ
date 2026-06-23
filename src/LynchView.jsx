import React, { useState } from 'react';
import { Shield } from 'lucide-react';
import { FreshnessPill } from './components/FreshnessPill.jsx';
import { useLynch } from './hooks/useLynch.js';
import { useLiveRows } from './hooks/useLiveQuotes.js';
import { useSortable, SortableTh } from './lib/useSortable.jsx';
import { useBreakpoint } from './hooks/useBreakpoint.js';
import { MasterDetail } from './layout/MasterDetail.jsx';
import { StockDetailPanel } from './components/detail/StockDetailPanel.jsx';
import { FundamentalsStrip } from './components/detail/FundamentalsStrip.jsx';
import { useStockDetailsFanout, FANOUT_METRIC_FIELDS } from './hooks/useStockDetailsFanout.js';
import { fmtMcap, fmtNum1, fmtNum2, fmtPct1 } from './lib/formatters.jsx';

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
  // Phase 6 W2 — row tap opens the comprehensive StockDetailPanel (modal on
  // mobile, docked panel on desktop) instead of the old thin inline-expand.
  const [selected, setSelected] = useState(null);
  const { data, error, isLoading: loading, isFetching, forceRescan } = useLynch(universe);
  const isRescanning = isFetching && !loading;
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('verdictRank', 'desc');
  const { isDesktop } = useBreakpoint();

  // Overlay live price onto each candidate (lynch shows current price for
  // comparison to the fair-value band; no intraday %-change column).
  const baseRows = useLiveRows((data?.candidates ?? []).map(normalize), { pctKey: null });
  // Phase 6 PR-G — enrich rows with fundamentals metrics so MCap/PE/PS/ROE/DE
  // columns sort cleanly. Shares queryKeys with FundamentalsStrip → one
  // ticker = one fetch across both surfaces.
  const tickers = baseRows.map((c) => c.ticker);
  // M6 — eager fan-out is capped (FANOUT_EAGER_ROWS); rows further down
  // are filled by FundamentalsStrip's in-viewport fetch (shared cache).
  // Sorting on a fan-out column lifts the cap so the sort sees every row.
  const { metricsByTicker } = useStockDetailsFanout(tickers, {
    eagerCount: FANOUT_METRIC_FIELDS.includes(sortKey) ? Infinity : undefined,
  });
  // Lynch already has a `debtToEquity` field in signals; the column reads from
  // the consolidated stock-detail metrics for parity with the strip + Williams.
  const rows = baseRows.map((c) => {
    const m = metricsByTicker[c.ticker];
    return {
      ...c,
      marketCap: m?.marketCap ?? null,
      pe: m?.pe ?? null,
      ps: m?.ps ?? null,
      roe: m?.roe ?? null,
      debtEquity: m?.debtEquity ?? null,
    };
  });
  const sorted = sortRows(rows);

  const list = (
    <div className={isDesktop ? 'px-6 py-5' : 'px-3 py-4 sm:p-6 max-w-[1400px] mx-auto'}>
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
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="signals.debtToEquity" align="right">D/E (sig)</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="confidence" align="right">Conf</SortableTh>
                    {/* Phase 6 PR-G — sortable fundamentals columns from
                        stock-detail (shared cache with FundamentalsStrip).
                        D/E (sig) above is the Lynch signal's input; MCap/PE/PS/
                        ROE/D-E below are the comprehensive fundamentals view. */}
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="marketCap" align="right">MCap</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="pe" align="right">P/E</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ps" align="right">P/S</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="roe" align="right">ROE</SortableTh>
                    <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="debtEquity" align="right">D/E</SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((c) => {
                    const isSelected = selected?.ticker === c.ticker;
                    return (
                      <React.Fragment key={c.ticker}>
                      <tr
                        onClick={() => setSelected(c)}
                        className={`border-t border-neutral-800/60 cursor-pointer transition-colors ${
                          isSelected ? 'bg-emerald-500/[0.07]' : 'hover:bg-neutral-900/20'
                        }`}
                      >
                        <td className="px-3 py-2.5 relative">
                          {isSelected && <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-emerald-400" />}
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
                        {/* PR-G — sortable fundamentals cells (data from
                            useStockDetailsFanout; null while loading) */}
                        <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">{fmtMcap(c.marketCap)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">{fmtNum1(c.pe)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">{fmtNum1(c.ps)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">{fmtPct1(c.roe)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">{fmtNum2(c.debtEquity)}</td>
                      </tr>
                      {/*
                        Phase 6 PR-F — FundamentalsStrip per row. Lazy-fetched
                        via intersection observer; shares the useStockDetail
                        cache so opening the detail panel never re-fetches.
                      */}
                      <tr data-testid={`lynch-strip-row-${c.ticker}`} className="bg-neutral-950/40">
                        <td colSpan={15} className="px-3 py-1.5">
                          <FundamentalsStrip ticker={c.ticker} onExpand={() => setSelected(c)} />
                        </td>
                      </tr>
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

  return (
    <MasterDetail
      selected={selected}
      onClose={() => setSelected(null)}
      list={list}
      detail={selected ? <StockDetailPanel board="lynch" ticker={selected.ticker} row={selected} /> : null}
      closeLabel="Close Lynch detail"
    />
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
