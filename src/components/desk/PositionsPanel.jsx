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
import { readLog, updateTrade, daysBetween } from '../../tradeLog.js';
import { isClosed, rMultiple } from '../../lib/baseRates.js';
import { useSortable, SortableTh } from '../../lib/useSortable.jsx';

const dash = <span className="text-neutral-700">—</span>;

function signed(v, digits = 2, suffix = '') {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dash;
  const cls = v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-neutral-300';
  return <span className={cls}>{v > 0 ? '+' : ''}{v.toFixed(digits)}{suffix}</span>;
}

/** Merge open journal entries with live quotes into flat sortable rows. Pure — exported for tests. */
export function buildPositionRows(log, quotesByTicker, nowIso = new Date().toISOString()) {
  return (log || [])
    .filter((t) => !isClosed(t))
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

  useEffect(() => {
    const refresh = () => setLog(readLog());
    window.addEventListener('tradelog:change', refresh);
    return () => window.removeEventListener('tradelog:change', refresh);
  }, []);

  const rows = useMemo(() => buildPositionRows(log, quotesByTicker), [log, quotesByTicker]);
  const sorted = sortRows(rows);

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
      </div>

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
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="last" align="right">Last</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="unrealizedPct" align="right">Unrl%</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="unrealizedPerShare" align="right">$/sh</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="rMultiple" align="right">R</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="daysHeld" align="right">Days</SortableTh>
                <th className="w-12" aria-label="close column" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <React.Fragment key={row.id}>
                  <tr
                    data-testid={`position-row-${row.ticker}`}
                    onClick={() => onFocus?.(row.ticker)}
                    className={`border-b border-neutral-900 cursor-pointer hover:bg-neutral-900/50 transition-colors ${
                      focusTicker === row.ticker ? 'bg-emerald-500/5' : ''
                    }`}
                  >
                    <td className="px-3 py-1.5">
                      <span className="font-semibold text-neutral-200">{row.ticker}</span>
                      {row.setup && <span className="ml-1.5 text-[9px] text-neutral-500 uppercase">{row.setup}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300">
                      {row.entry != null ? row.entry.toFixed(2) : dash}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-neutral-200">
                      {row.last != null ? row.last.toFixed(2) : dash}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{signed(row.unrealizedPct, 1, '%')}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{signed(row.unrealizedPerShare)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300" title={row.stop != null ? `stop ${row.stop}` : 'no stop recorded'}>
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
                      <td colSpan={8} className="px-3 py-2">
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
