import React, { useState, useEffect, useMemo } from 'react';
import {
  ChevronDown, ChevronUp,
  AlertCircle, TrendingUp, TrendingDown,
} from 'lucide-react';
import { useSortable, SortableTh } from './lib/useSortable.jsx';
import { FreshnessPill } from './components/FreshnessPill.jsx';
import { useInsider } from './hooks/useInsider.js';
import { useLiveRows } from './hooks/useLiveQuotes.js';
import { useBreakpoint } from './hooks/useBreakpoint.js';
import { FundamentalsStrip } from './components/detail/FundamentalsStrip.jsx';
import { MasterDetail } from './layout/MasterDetail.jsx';
import { StockDetailPanel } from './components/detail/StockDetailPanel.jsx';

const WINDOW_OPTIONS = [
  { id: 30, label: '30d' },
  { id: 60, label: '60d' },
  { id: 90, label: '90d' },
  { id: 180, label: '180d' },
];

// Phase 4l W3 — the insiders tab opens defaulted to net buyers.
// The toggle flips between net buyers (netDollars > 0), net sellers
// (netDollars < 0), and all rows. Default sort matches the active view.
const VIEW_OPTIONS = [
  { id: 'buyers', label: 'Buyers', defaultSortKey: 'netDollars', defaultSortDir: 'desc' },
  { id: 'sellers', label: 'Sellers', defaultSortKey: 'sellDollars', defaultSortDir: 'desc' },
  { id: 'all', label: 'All', defaultSortKey: 'netDollars', defaultSortDir: 'desc' },
];

const fmtUsd = (n) => {
  if (!Number.isFinite(n) || n === 0) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

const fmtPrice = (n) => {
  if (!Number.isFinite(n) || n === null) return '—';
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
};

const fmtDate = (s) => {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return s;
  }
};

export const InsiderBoardView = ({ universe = 'all' }) => {
  const [windowDays, setWindowDays] = useState(() => {
    if (typeof window !== 'undefined') {
      const u = new URL(window.location.href);
      const d = Number(u.searchParams.get('insiderDays'));
      if ([30, 60, 90, 180].includes(d)) return d;
    }
    return 90;
  });
  const [view, setView] = useState(() => {
    if (typeof window !== 'undefined') {
      const u = new URL(window.location.href);
      const v = u.searchParams.get('insiderView');
      if (v === 'buyers' || v === 'sellers' || v === 'all') return v;
    }
    return 'buyers'; // Phase 4l W3: default to net buyers
  });
  const [expandedTicker, setExpandedTicker] = useState(null);
  const [selected, setSelected] = useState(null); // ticker → full detail panel
  const { isDesktop } = useBreakpoint();

  // Default sort is netDollars desc (buyers view). Switching views below
  // re-points the sort to the natural key for that view.
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('netDollars', 'desc');
  const { data, error, isLoading: loading, isFetching, forceRescan } = useInsider(universe, windowDays);
  const isRescanning = isFetching && !loading;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    u.searchParams.set('insiderDays', String(windowDays));
    u.searchParams.set('insiderView', view);
    window.history.replaceState({}, '', u.toString());
  }, [windowDays, view]);

  // Overlay live price onto each row (insider shows price but no
  // %-change, so only the price field is refreshed).
  const rows = useLiveRows(data?.rows ?? [], { pctKey: null });

  // Apply view filter BEFORE sort so the count + sortRows agree.
  const filtered = useMemo(() => {
    if (view === 'buyers') return rows.filter((r) => Number(r.netDollars) > 0);
    if (view === 'sellers') return rows.filter((r) => Number(r.netDollars) < 0);
    return rows;
  }, [rows, view]);

  const sorted = useMemo(() => sortRows(filtered), [filtered, sortKey, sortDir, sortRows]);

  const setViewAndSort = (id) => {
    setView(id);
    const opt = VIEW_OPTIONS.find((v) => v.id === id);
    if (opt && opt.defaultSortKey !== sortKey) {
      // Re-anchor the sort to the new view's natural column.
      sortBy(opt.defaultSortKey);
      // sortBy toggles direction if same key. We just changed to a new
      // key, so the hook sets desc — which matches all VIEW_OPTIONS.
    }
  };

  // Phase 4k W3 — at desktop widths the insider board drops the narrow
  // phone-friendly max-width and tightens row padding so more filings
  // fit per screen. Mobile rendering is unchanged.
  const cellPadY = isDesktop ? 'py-1.5' : 'py-2.5';
  const cellPadX = 'px-3';
  const tickerCellSize = isDesktop ? 'text-[12px]' : 'text-[13px]';

  const list = (
    <div className={isDesktop ? 'px-6 py-5' : 'p-4 sm:p-6 max-w-[1400px] mx-auto'}>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Insider Board</div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight flex items-baseline gap-2">
            {loading ? (
              <span className="text-neutral-500 italic font-light">loading…</span>
            ) : (
              <>
                <span className="text-emerald-400">{sorted.length}</span>
                <span className="text-neutral-500 italic font-light">
                  {view === 'buyers' && 'net insider buyers'}
                  {view === 'sellers' && 'net insider sellers'}
                  {view === 'all' && 'tickers with insider activity'}
                </span>
              </>
            )}
          </h1>
          <p className="text-neutral-400 text-sm mt-2 max-w-2xl">
            Aggregate Form 4 buys & sells across the universe over the selected window.
            Click any row to see individual filings. Sort by tapping any column header.
          </p>
        </div>
        <FreshnessPill
          meta={data}
          isRescanning={isRescanning}
          onForceRescan={() => forceRescan()}
        />
      </div>

      {/* View toggle (Buyers / Sellers / All) — Phase 4l W3 */}
      <div className="flex items-center gap-1 text-[11px] font-mono mb-3 flex-wrap">
        <span className="text-neutral-500 mr-2 uppercase tracking-widest">View</span>
        {VIEW_OPTIONS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setViewAndSort(id)}
            className={`px-2.5 h-7 transition-colors ${
              view === id
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
                : 'text-neutral-500 border border-neutral-800 hover:border-neutral-600'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Window selector */}
      <div className="flex items-center gap-1 text-[11px] font-mono mb-5 flex-wrap">
        <span className="text-neutral-500 mr-2 uppercase tracking-widest">Window</span>
        {WINDOW_OPTIONS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setWindowDays(id)}
            className={`px-2.5 h-7 transition-colors ${
              windowDays === id
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
                : 'text-neutral-500 border border-neutral-800 hover:border-neutral-600'
            }`}
          >
            {label}
          </button>
        ))}
        {data && !loading && (
          <span className="ml-auto text-neutral-600 text-[10px]">
            {data.universeChecked} scanned · {new Date(data.generatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="border border-rose-500/30 bg-rose-500/5 p-4 mb-4 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-rose-400 mt-0.5 flex-shrink-0" />
          <div>
            <div className="text-rose-400 font-mono text-[11px] uppercase tracking-widest mb-1">Error</div>
            <div className="text-[12px] text-neutral-300">{error?.message ?? String(error)}</div>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && !data && (
        <div className="border border-neutral-800 p-8 text-center">
          <div className="inline-block h-6 w-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-3" />
          <div className="text-neutral-400 text-sm">Scanning insider filings across universe…</div>
          <div className="text-neutral-600 text-[11px] mt-1 font-mono">~5-10 seconds</div>
        </div>
      )}

      {/* Empty */}
      {!loading && data && sorted.length === 0 && (
        <div className="border border-neutral-800 p-6 text-center text-neutral-500 text-sm">
          {view === 'buyers' && 'No net insider buyers in the selected window. Try the Sellers or All view.'}
          {view === 'sellers' && 'No net insider sellers in the selected window. Try the Buyers or All view.'}
          {view === 'all' && 'No insider activity in the selected window.'}
        </div>
      )}

      {/* Table */}
      {sorted.length > 0 && (
        <div className={`border border-neutral-800 ${isDesktop ? '' : 'overflow-x-auto'}`}>
          <table className="w-full text-[12px] font-mono">
            <thead className="bg-neutral-900/40 text-[10px] uppercase tracking-widest text-neutral-500">
              <tr>
                <th className={`text-left ${cellPadX} ${cellPadY} w-10`}></th>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ticker" align="left">Ticker</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="price" align="right">Price</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="buyDollars" align="right">$ Bought</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="awardDollars" align="right">$ Awards</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="sellDollars" align="right">$ Sold</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="netDollars" align="right">Net</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="buyerCount" align="right">Buyers</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="topBuyer.name" align="left">Top Buyer</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="daysSinceLatest" align="right">Last Filing</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const isOpen = expandedTicker === r.ticker;
                const netColor = r.netDollars > 0 ? 'text-emerald-400' : r.netDollars < 0 ? 'text-rose-400' : 'text-neutral-400';
                return (
                  <React.Fragment key={r.ticker}>
                    <tr
                      onClick={() => setExpandedTicker(isOpen ? null : r.ticker)}
                      className={`border-t border-neutral-800/60 cursor-pointer transition-colors ${isOpen ? 'bg-neutral-900/40' : 'hover:bg-neutral-900/20'}`}
                    >
                      <td className={`${cellPadX} ${cellPadY} text-neutral-500`}>
                        {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </td>
                      <td className={`${cellPadX} ${cellPadY} font-serif font-bold ${tickerCellSize}`}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setSelected(r); }}
                          className="text-neutral-100 hover:text-emerald-300 transition-colors text-left"
                          title="Open full detail — chart, AI brief, fundamentals"
                        >
                          {r.ticker}
                        </button>
                      </td>
                      <td className={`${cellPadX} ${cellPadY} text-right tabular-nums text-neutral-300`}>{fmtPrice(r.price)}</td>
                      <td className={`${cellPadX} ${cellPadY} text-right tabular-nums text-emerald-400`}>{fmtUsd(r.buyDollars)}</td>
                      <td className={`${cellPadX} ${cellPadY} text-right tabular-nums text-sky-400/80`}>{fmtUsd(r.awardDollars)}</td>
                      <td className={`${cellPadX} ${cellPadY} text-right tabular-nums text-rose-400`}>{fmtUsd(r.sellDollars)}</td>
                      <td className={`${cellPadX} ${cellPadY} text-right tabular-nums ${netColor}`}>{fmtUsd(r.netDollars)}</td>
                      <td className={`${cellPadX} ${cellPadY} text-right tabular-nums text-neutral-300`}>{r.buyerCount}</td>
                      <td className={`${cellPadX} ${cellPadY} text-neutral-300 ${isDesktop ? 'max-w-[260px]' : 'max-w-[180px]'} truncate`}>
                        {r.topBuyer ? (
                          <span title={r.topBuyer.name}>
                            <span className="text-neutral-200">{r.topBuyer.name}</span>
                          </span>
                        ) : (
                          <span className="text-neutral-600">—</span>
                        )}
                      </td>
                      <td className={`${cellPadX} ${cellPadY} text-right tabular-nums text-neutral-400`}>
                        {r.daysSinceLatest !== null ? `${r.daysSinceLatest}d ago` : '—'}
                      </td>
                    </tr>
                    {/* Phase 6 PR-G — fundamentals strip beneath every row
                        so insiders' net flow has fundamentals context at-a-
                        glance. Lazy-fetched via intersection observer. */}
                    <tr data-testid={`insider-strip-row-${r.ticker}`} className="bg-neutral-950/40">
                      <td colSpan={10} className="px-3 py-1.5">
                        <FundamentalsStrip ticker={r.ticker} showExpandIcon={false} />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-neutral-800/60 bg-neutral-950/60">
                        <td colSpan={10} className="p-0">
                          <FilingsTable filings={r.filings} />
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

      {/* Footer note */}
      <div className="mt-6 border border-neutral-800/60 bg-neutral-950/40 p-3 text-[11px] text-neutral-500 leading-relaxed">
        Source: Finnhub Form 4 feed; price from Polygon previous close.
        <span className="text-emerald-400 font-medium"> $ Bought</span> shows
        open-market purchases (Form 4 code P) — the high-conviction signal.
        <span className="text-sky-400/80 font-medium"> $ Awards</span> shows
        scheduled grants and RSU vests (code A); these are tracked separately
        because they reflect comp-committee decisions, not insider conviction,
        and aren't included in Net or Buyers count. Cluster buys (3+ insiders
        in 14d on P-code) often precede unusual moves. Insider role/title is
        not exposed by this data source.
      </div>
    </div>
  );

  return (
    <MasterDetail
      selected={selected}
      onClose={() => setSelected(null)}
      list={list}
      detail={selected ? <StockDetailPanel board="insider" ticker={selected.ticker} row={selected} /> : null}
      closeLabel="Close detail"
    />
  );
};

const FilingsTable = ({ filings }) => {
  if (!filings || filings.length === 0) {
    return <div className="px-4 py-3 text-neutral-500 text-[11px]">No filings detail available.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] font-mono">
        <thead className="bg-neutral-900/40 text-[9px] uppercase tracking-widest text-neutral-600">
          <tr>
            <th className="text-left px-4 py-1.5">Insider</th>
            <th className="text-right px-3 py-1.5">Action</th>
            <th className="text-right px-3 py-1.5">Shares</th>
            <th className="text-right px-3 py-1.5">$ Value</th>
            <th className="text-right px-3 py-1.5">Filed</th>
            <th className="text-right px-4 py-1.5">Days</th>
          </tr>
        </thead>
        <tbody>
          {filings.map((f, i) => {
            const isBuy = f.code === 'P' && f.shares > 0;
            const isAward = f.code === 'A' && f.shares > 0;
            const isSell = (f.code === 'S' || f.code === 'D') && f.shares < 0;
            const Icon = isBuy ? TrendingUp : isSell ? TrendingDown : null;
            const tone = isBuy ? 'text-emerald-400' : isSell ? 'text-rose-400' : isAward ? 'text-sky-400' : 'text-neutral-400';
            const actionLabel = isBuy ? 'BUY' : isSell ? 'SELL' : isAward ? 'AWARD' : (f.code || '—');
            return (
              <tr key={i} className="border-t border-neutral-800/40">
                <td className="px-4 py-1.5 text-neutral-200 max-w-[260px] truncate" title={f.name}>{f.name}</td>
                <td className={`px-3 py-1.5 text-right ${tone}`}>
                  {Icon && <Icon className="h-3 w-3 inline-block mr-1" />}
                  {actionLabel}
                </td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${tone}`}>
                  {Math.abs(f.shares).toLocaleString()}
                </td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${tone}`}>{fmtUsd(f.dollars)}</td>
                <td className="px-3 py-1.5 text-right text-neutral-400">{fmtDate(f.filingDate)}</td>
                <td className="px-4 py-1.5 text-right tabular-nums text-neutral-500">{f.daysSince}d</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default InsiderBoardView;
