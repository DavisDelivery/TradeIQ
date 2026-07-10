// DESK-1 W2 — the watchlist table (left rail).
//
// Firestore-synced single-user list (src/watchlist.js, tradeLog sync
// pattern). Columns — ALL sortable (standing rule, useSortable +
// SortableTh): Ticker | Last | Chg% | Spark 30d | vs 52wH | ATR% |
// AvgVol | MktCap | Earnings | Signal.
//
// Live overlay contract: Last/Chg% overlay via the shared quotes map;
// a missing quote falls back to the desk-stats daily close, and a
// missing stat renders an em-dash — never 0 or $null (OptionsFlow
// lesson).

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, X, Loader2 } from 'lucide-react';
import { readWatchlist, addToWatchlist, removeFromWatchlist } from '../../watchlist.js';
import { useSortable, SortableTh } from '../../lib/useSortable.jsx';
import { fmtMcap, fmtCompact } from '../../lib/formatters.jsx';
import { Spark } from './Spark.jsx';
import { SignalCell } from './SignalCell.jsx';

const dash = <span className="text-neutral-700">—</span>;

function num(v, digits = 2, suffix = '') {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dash;
  return <>{v.toFixed(digits)}{suffix}</>;
}

function signed(v, digits = 2, suffix = '%') {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dash;
  const cls = v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-neutral-300';
  return <span className={cls}>{v > 0 ? '+' : ''}{v.toFixed(digits)}{suffix}</span>;
}

function EarningsCell({ radar }) {
  const d = radar?.daysUntil;
  if (d == null || !Number.isFinite(d) || d < 0) return dash;
  const cls = d <= 2 ? 'text-rose-400' : d <= 7 ? 'text-amber-400' : 'text-neutral-300';
  return (
    <span className={`${cls} tabular-nums`} title={radar?.nextEarningsDate ?? undefined}>
      {d}d
    </span>
  );
}

/** Merge stats + quotes + radar + signals into flat sortable rows. Pure — exported for tests. */
export function buildWatchlistRows(entries, statsByTicker, quotesByTicker, radarByTicker, signalMap) {
  return (entries || []).map((e) => {
    const t = e.ticker;
    const s = statsByTicker?.[t];
    const q = quotesByTicker?.[t];
    const r = radarByTicker?.[t];
    const signals = signalMap?.[t] ?? [];
    const spark = s?.spark ?? null;
    const spark30dPct = spark && spark.length >= 2 && spark[0] > 0
      ? ((spark[spark.length - 1] - spark[0]) / spark[0]) * 100
      : null;
    return {
      ticker: t,
      name: s?.name ?? null,
      last: q?.price ?? s?.last ?? null,
      chgPct: q?.changePct ?? null,
      spark,
      spark30dPct,
      dist52wHighPct: s?.dist52wHighPct ?? null,
      atrPct14: s?.atrPct14 ?? null,
      avgVol20: s?.avgVol20 ?? null,
      marketCap: s?.marketCap ?? null,
      earningsDays: (r?.daysUntil != null && r.daysUntil >= 0) ? r.daysUntil : null,
      radar: r ?? null,
      signals,
      signalCount: signals.length,
      pendingSync: !!e._pendingSync,
    };
  });
}

export function WatchlistPanel({
  statsByTicker, statsLoading, quotesByTicker, radarByTicker, signalMap,
  focusTicker, onFocus,
}) {
  const [entries, setEntries] = useState(() => readWatchlist());
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('ticker', 'asc');

  useEffect(() => {
    const refresh = () => setEntries(readWatchlist());
    window.addEventListener('watchlist:change', refresh);
    return () => window.removeEventListener('watchlist:change', refresh);
  }, []);

  const rows = useMemo(
    () => buildWatchlistRows(entries, statsByTicker, quotesByTicker, radarByTicker, signalMap),
    [entries, statsByTicker, quotesByTicker, radarByTicker, signalMap],
  );
  const sorted = sortRows(rows);

  async function handleAdd(ev) {
    ev?.preventDefault?.();
    const t = input.trim().toUpperCase();
    if (!t || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      if (entries.some((e) => e.ticker === t)) {
        setAddError(`${t} is already on the list`);
        return;
      }
      // Validate against the ticker-reference lookup before accepting —
      // a typo must not become a permanent dead row.
      const r = await fetch(`/api/ticker-info?ticker=${encodeURIComponent(t)}`);
      const json = await r.json().catch(() => null);
      if (!r.ok || !json?.name) {
        setAddError(`${t}: unknown ticker`);
        return;
      }
      const added = addToWatchlist(t);
      if (!added) {
        setAddError(`${t}: invalid symbol`);
        return;
      }
      setInput('');
      setEntries(readWatchlist());
    } catch (err) {
      setAddError(err?.message ?? 'lookup failed');
    } finally {
      setAdding(false);
    }
  }

  function handleRemove(ticker, ev) {
    ev.stopPropagation();
    removeFromWatchlist(ticker);
    setEntries(readWatchlist());
  }

  return (
    <section data-testid="desk-watchlist" className="border border-neutral-800 bg-neutral-950/40">
      <div className="flex items-center justify-between px-3 h-9 border-b border-neutral-800/80">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
          Watchlist <span className="text-neutral-600">({entries.length})</span>
        </div>
        <form onSubmit={handleAdd} className="flex items-center gap-1">
          <input
            value={input}
            onChange={(e) => { setInput(e.target.value.toUpperCase()); setAddError(null); }}
            placeholder="ADD…"
            maxLength={10}
            aria-label="Add ticker to watchlist"
            className="w-20 h-6 px-1.5 bg-neutral-900/80 border border-neutral-700 text-[11px] font-mono text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-emerald-500/50"
          />
          <button
            type="submit"
            disabled={adding || !input.trim()}
            aria-label="Add ticker"
            className="h-6 w-6 flex items-center justify-center border border-neutral-700 text-neutral-400 hover:text-emerald-400 hover:border-emerald-500/50 disabled:opacity-40 transition-colors"
          >
            {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          </button>
        </form>
      </div>
      {addError && (
        <div className="px-3 py-1 text-[10px] font-mono text-rose-400 border-b border-neutral-800/60">{addError}</div>
      )}

      {entries.length === 0 ? (
        <div className="p-6 text-center text-[11px] font-mono text-neutral-600">
          Empty. Add a ticker above to start the tape.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-neutral-500 border-b border-neutral-800/80">
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ticker">Ticker</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="last" align="right">Last</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="chgPct" align="right">Chg%</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="spark30dPct" align="right">Spark 30d</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="dist52wHighPct" align="right">vs 52wH</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="atrPct14" align="right">ATR%</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="avgVol20" align="right">AvgVol</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="marketCap" align="right">MktCap</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="earningsDays" align="right">Earn</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="signalCount">Signal</SortableTh>
                <th className="w-6" aria-label="remove column" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.ticker}
                  data-testid={`watch-row-${row.ticker}`}
                  onClick={() => onFocus?.(row.ticker)}
                  className={`border-b border-neutral-900 cursor-pointer transition-colors hover:bg-neutral-900/50 ${
                    focusTicker === row.ticker ? 'bg-emerald-500/5' : ''
                  }`}
                >
                  <td className="px-3 py-1.5">
                    <span className={`font-semibold ${focusTicker === row.ticker ? 'text-emerald-400' : 'text-neutral-200'}`}>
                      {row.ticker}
                    </span>
                    {row.pendingSync && <span className="ml-1 text-[8px] text-neutral-600" title="Not yet synced to cloud">●</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-200">{num(row.last)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{signed(row.chgPct)}</td>
                  <td className="px-3 py-1.5 text-right">
                    {statsLoading && !row.spark ? <span className="text-neutral-700">…</span> : <Spark values={row.spark} />}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{signed(row.dist52wHighPct, 1)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300">{num(row.atrPct14, 1, '%')}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300">
                    {row.avgVol20 != null ? fmtCompact(row.avgVol20) : dash}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300">
                    {row.marketCap != null ? fmtMcap(row.marketCap) : dash}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums"><EarningsCell radar={row.radar} /></td>
                  <td className="px-3 py-1.5"><SignalCell signals={row.signals} /></td>
                  <td className="px-1 py-1.5">
                    <button
                      onClick={(ev) => handleRemove(row.ticker, ev)}
                      aria-label={`Remove ${row.ticker}`}
                      className="h-5 w-5 flex items-center justify-center text-neutral-700 hover:text-rose-400 transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
