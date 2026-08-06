// DESK-1 W4 — open positions (right rail). tradeLog entries with no
// recorded exit, live-marked via the shared quotes overlay:
//   entry · last · unrealized $/sh and % · R-multiple (when a stop is
//   recorded) · days held. Sortable (standing rule). Row click focuses.
//
// Unrealized $ is PER SHARE ((last − entry)) — the journal doesn't
// record share counts, and inventing a position size would be a lie.
// A missing live quote renders em-dash marks, never 0 (OptionsFlow
// lesson); the row stays.

import React, { useEffect, useMemo, useState } from 'react';
import { ShieldAlert, EyeOff } from 'lucide-react';
import { readLog, updateTrade, daysBetween } from '../../tradeLog.js';
import { isClosed, rMultiple } from '../../lib/baseRates.js';
import { useSortable, SortableTh } from '../../lib/useSortable.jsx';
import { useStopWatch } from '../../hooks/useStopWatch.js';

const dash = <span className="text-neutral-700">—</span>;

/** ET wall-clock for a breach timestamp — the only clock a US-session trader reads. */
export function etTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function signed(v, digits = 2, suffix = '') {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dash;
  const cls = v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-neutral-300';
  return <span className={cls}>{v > 0 ? '+' : ''}{v.toFixed(digits)}{suffix}</span>;
}

/** Merge open journal entries with live quotes into flat sortable rows. Pure — exported for tests. */
export function buildPositionRows(log, quotesByTicker, nowIso = new Date().toISOString()) {
  return (log || [])
    .filter((t) => !isClosed(t))
    // A SELL is an exit event, not an open position — it used to render as a
    // row whose "entry" was actually the exit price. And broker docs are
    // written at ORDER PLACEMENT, so an armed stop or an unfilled limit is
    // not a position either; showing one would invent a holding that does
    // not exist. (broker-journal repair, 2026-08-06)
    .filter((t) => !t.isSellEvent && t.pending !== true)
    .map((t) => {
      const entry = typeof t.loggedPrice === 'number' && Number.isFinite(t.loggedPrice) && t.loggedPrice > 0
        ? t.loggedPrice : null;
      const last = quotesByTicker?.[String(t.ticker || '').toUpperCase()]?.price ?? null;
      const unrealizedPerShare = entry != null && last != null ? last - entry : null;
      const unrealizedPct = entry != null && last != null ? ((last - entry) / entry) * 100 : null;
      return {
        id: t.id,
        ticker: t.ticker,
        source: t.source ?? null,
        setup: t.setup ?? null,
        entry,
        stop: typeof t.stop === 'number' && Number.isFinite(t.stop) ? t.stop : null,
        last,
        unrealizedPerShare,
        unrealizedPct,
        rMultiple: entry != null && last != null ? rMultiple(entry, t.stop, last) : null,
        daysHeld: t.loggedAt ? daysBetween(t.loggedAt, nowIso) : null,
      };
    });
}

export function PositionsPanel({ quotesByTicker, focusTicker, onFocus }) {
  const [log, setLog] = useState(() => readLog());
  const [closingId, setClosingId] = useState(null);
  const [exitInput, setExitInput] = useState('');
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('daysHeld', 'asc');
  const { breachByTradeId, stale: watcherStale, error: watcherError } = useStopWatch();

  useEffect(() => {
    const refresh = () => setLog(readLog());
    window.addEventListener('tradelog:change', refresh);
    return () => window.removeEventListener('tradelog:change', refresh);
  }, []);

  const rows = useMemo(() => buildPositionRows(log, quotesByTicker), [log, quotesByTicker]);
  const sorted = sortRows(rows);
  const breachCount = rows.filter((r) => breachByTradeId[r.id]).length;
  const noStopCount = rows.filter((r) => r.stop == null).length;

  function startClose(row, ev) {
    ev.stopPropagation();
    setClosingId(row.id);
    setExitInput(row.last != null ? String(row.last) : '');
  }

  function confirmClose(ev) {
    ev?.preventDefault?.();
    const price = Number(exitInput);
    if (!Number.isFinite(price) || price <= 0) return;
    updateTrade(closingId, { exitPrice: price, exitAt: new Date().toISOString() });
    setClosingId(null);
    setExitInput('');
    setLog(readLog());
  }

  return (
    <section data-testid="desk-positions" className="border border-neutral-800 bg-neutral-950/40">
      <div className="px-3 h-9 flex items-center border-b border-neutral-800/80 text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
        Open Positions <span className="ml-1 text-neutral-600">({rows.length})</span>
        {breachCount > 0 && (
          <span className="ml-auto flex items-center gap-1 text-rose-400 normal-case tracking-normal">
            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
            {breachCount} at/below stop
          </span>
        )}
      </div>

      {/* The watcher must announce its own silence. An empty breach list from a
          watcher that has stopped sampling looks exactly like "all clear", and
          that is the one thing a risk control must never imply. */}
      {(watcherStale || watcherError) && rows.length > 0 && (
        <div
          data-testid="stop-watch-degraded"
          className="flex items-start gap-1.5 px-3 py-1.5 border-b border-amber-500/20 bg-amber-500/5 text-[10px] font-mono text-amber-400/90"
        >
          <EyeOff className="h-3 w-3 mt-px shrink-0" aria-hidden="true" />
          <span>
            Stop watcher has not reported recently — stop breaches below may be out of date.
            Check price yourself.
          </span>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="p-4 text-center text-[11px] font-mono text-neutral-600">
          No open positions. Log a trade from any board or the Journal.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-neutral-500 border-b border-neutral-800/80">
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ticker">Tkr</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="entry" align="right">Entry</SortableTh>
                {/* The stop used to live in a `title` tooltip, which does not
                    exist on iOS touch — so the owner's recorded risk limit was
                    unreadable on his primary device. It is a column now. */}
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="stop" align="right">Stop</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="last" align="right">Last</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="unrealizedPct" align="right">Unrl%</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="unrealizedPerShare" align="right">$/sh</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="rMultiple" align="right">R</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="daysHeld" align="right">Days</SortableTh>
                <th className="w-12" aria-label="close column" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const breach = breachByTradeId[row.id] || null;
                return (
                <React.Fragment key={row.id}>
                  <tr
                    data-testid={`position-row-${row.ticker}`}
                    data-breach={breach ? 'true' : undefined}
                    onClick={() => onFocus?.(row.ticker)}
                    className={`border-b border-neutral-900 cursor-pointer hover:bg-neutral-900/50 transition-colors ${
                      breach
                        ? 'bg-rose-500/[0.07] border-l-2 border-l-rose-500'
                        : focusTicker === row.ticker
                          ? 'bg-emerald-500/5'
                          : ''
                    }`}
                  >
                    <td className="px-3 py-1.5">
                      <span className="font-semibold text-neutral-200">{row.ticker}</span>
                      {row.setup && <span className="ml-1.5 text-[9px] text-neutral-500 uppercase">{row.setup}</span>}
                      {breach && (
                        // "Observed", not "stopped out": a 15-minute poll samples
                        // price, it does not tick. Between two samples the low
                        // could have been far lower — or the trade already filled.
                        <div className="text-[9px] text-rose-400 leading-tight mt-0.5">
                          ≤ stop{etTime(breach.firstObservedAt) ? ` — first seen ${etTime(breach.firstObservedAt)} ET` : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300">
                      {row.entry != null ? row.entry.toFixed(2) : dash}
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${breach ? 'text-rose-400' : 'text-neutral-400'}`}>
                      {row.stop != null ? row.stop.toFixed(2) : dash}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-neutral-200">
                      {row.last != null ? row.last.toFixed(2) : dash}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{signed(row.unrealizedPct, 1, '%')}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{signed(row.unrealizedPerShare)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300">
                      {row.rMultiple != null ? `${row.rMultiple}R` : dash}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-neutral-400">
                      {row.daysHeld != null ? row.daysHeld : dash}
                    </td>
                    <td className="px-1 py-1.5 text-right">
                      <button
                        onClick={(ev) => startClose(row, ev)}
                        className="px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-widest text-neutral-500 border border-neutral-800 hover:text-amber-400 hover:border-amber-500/40 transition-colors"
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                  {closingId === row.id && (
                    <tr className="border-b border-neutral-900 bg-neutral-900/40">
                      <td colSpan={9} className="px-3 py-2">
                        <form onSubmit={confirmClose} className="flex items-center gap-2 text-[11px] font-mono" onClick={(e) => e.stopPropagation()}>
                          <span className="text-neutral-500">Exit price</span>
                          <input
                            autoFocus
                            value={exitInput}
                            onChange={(e) => setExitInput(e.target.value)}
                            inputMode="decimal"
                            aria-label={`Exit price for ${row.ticker}`}
                            className="w-24 h-6 px-1.5 bg-neutral-950 border border-neutral-700 text-neutral-200 tabular-nums focus:outline-none focus:border-emerald-500/50"
                          />
                          <button type="submit" className="px-2 h-6 border border-emerald-500/40 text-emerald-400 text-[10px] uppercase tracking-widest hover:bg-emerald-500/10">
                            Record exit
                          </button>
                          <button
                            type="button"
                            onClick={() => setClosingId(null)}
                            className="px-2 h-6 border border-neutral-800 text-neutral-500 text-[10px] uppercase tracking-widest hover:text-neutral-300"
                          >
                            Cancel
                          </button>
                        </form>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {noStopCount > 0 && (
            <div className="px-3 py-1.5 border-t border-neutral-900 text-[10px] font-mono text-neutral-600">
              {noStopCount} position{noStopCount === 1 ? '' : 's'} with no stop recorded — not watched.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
