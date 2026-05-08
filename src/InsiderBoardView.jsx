import React, { useState, useEffect, useMemo } from 'react';
import {
  Users, RefreshCw, AlertCircle, ChevronDown, ChevronUp,
  ArrowUpDown, ArrowUp, ArrowDown, TrendingUp, TrendingDown,
} from 'lucide-react';
import { validate, SHAPES, fetchWithRetry } from './lib/validateResponse.js';
import { useSortable, SortableTh } from './lib/useSortable.jsx';
import { FreshnessPill } from './components/FreshnessPill.jsx';

const WINDOW_OPTIONS = [
  { id: 30, label: '30d' },
  { id: 60, label: '60d' },
  { id: 90, label: '90d' },
  { id: 180, label: '180d' },
];

const fmtUsd = (n) => {
  if (!Number.isFinite(n) || n === 0) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedTicker, setExpandedTicker] = useState(null);

  const [isRescanning, setIsRescanning] = useState(false);

  const { sortKey, sortDir, sortBy, sortRows } = useSortable('buyDollars', 'desc');

  const load = async ({ force = false } = {}) => {
    if (force) setIsRescanning(true);
    else setLoading(true);
    setError(null);
    try {
      const url = `/api/insider-board?days=${windowDays}&index=${universe}&limit=120${force ? '&force=1' : ''}`;
      const r = await fetchWithRetry(url);
      const json = await r.json();
      if (!r.ok || json.error) {
        setError(json.error || `HTTP ${r.status}`);
      } else {
        setData(validate(json, SHAPES.insiderBoard, 'insider-board'));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setIsRescanning(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [windowDays, universe]);

  // Sync window choice to URL for bookmarkability
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    u.searchParams.set('insiderDays', String(windowDays));
    window.history.replaceState({}, '', u.toString());
  }, [windowDays]);

  const rows = data?.rows ?? [];
  const sorted = useMemo(() => sortRows(rows), [rows, sortKey, sortDir, sortRows]);

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
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
                <span className="text-neutral-500 italic font-light">tickers with insider activity</span>
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
          onForceRescan={() => load({ force: true })}
        />
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
            <div className="text-[12px] text-neutral-300">{error}</div>
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
          No insider activity in the selected window.
        </div>
      )}

      {/* Table */}
      {sorted.length > 0 && (
        <div className="border border-neutral-800 overflow-x-auto">
          <table className="w-full text-[12px] font-mono">
            <thead className="bg-neutral-900/40 text-[10px] uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left px-3 py-2.5 w-10"></th>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ticker" align="left">Ticker</SortableTh>
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
                      <td className="px-3 py-2.5 text-neutral-500">
                        {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </td>
                      <td className="px-3 py-2.5 font-serif text-neutral-100 font-bold text-[13px]">{r.ticker}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-emerald-400">{fmtUsd(r.buyDollars)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-sky-400/80">{fmtUsd(r.awardDollars)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-rose-400">{fmtUsd(r.sellDollars)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${netColor}`}>{fmtUsd(r.netDollars)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">{r.buyerCount}</td>
                      <td className="px-3 py-2.5 text-neutral-300 max-w-[180px] truncate">
                        {r.topBuyer ? (
                          <span title={r.topBuyer.name}>
                            <span className="text-neutral-200">{r.topBuyer.name}</span>
                          </span>
                        ) : (
                          <span className="text-neutral-600">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-neutral-400">
                        {r.daysSinceLatest !== null ? `${r.daysSinceLatest}d ago` : '—'}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-neutral-800/60 bg-neutral-950/60">
                        <td colSpan={9} className="p-0">
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
        Source: Finnhub Form 4 feed.
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
