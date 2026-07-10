// DESK-1 W2/W4 — earnings radar (right rail): watchlist names with a
// known upcoming report, nearest first. Amber ≤7d, red ≤2d. Beats
// render with the honest denominator (never "0/4" when there's no
// data). Sortable (standing rule). Row click focuses.

import React from 'react';
import { useSortable, SortableTh } from '../../lib/useSortable.jsx';

const dash = <span className="text-neutral-700">—</span>;

/** Flatten the radar map into upcoming rows. Pure — exported for tests. */
export function buildRadarRows(radarByTicker) {
  return Object.values(radarByTicker || {})
    .filter((r) => r && r.daysUntil != null && r.daysUntil >= 0 && r.nextEarningsDate)
    .map((r) => ({
      ticker: r.ticker,
      date: r.nextEarningsDate,
      daysUntil: r.daysUntil,
      beatsLast4: r.beatsLast4,
      beatsLast4Quarters: r.beatsLast4Quarters ?? 0,
      lastSurprisePct: r.lastSurprisePct,
    }));
}

export function EarningsRadarPanel({ radarByTicker, focusTicker, onFocus }) {
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('daysUntil', 'asc');
  const rows = sortRows(buildRadarRows(radarByTicker));

  return (
    <section data-testid="desk-earnings-radar" className="border border-neutral-800 bg-neutral-950/40">
      <div className="px-3 h-9 flex items-center border-b border-neutral-800/80 text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
        Earnings Radar
      </div>
      {rows.length === 0 ? (
        <div className="p-4 text-center text-[11px] font-mono text-neutral-600">
          No upcoming reports on the watchlist.
        </div>
      ) : (
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="text-neutral-500 border-b border-neutral-800/80">
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ticker">Tkr</SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="daysUntil" align="right">In</SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="date">Date</SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="beatsLast4" align="right">Beats</SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="lastSurprisePct" align="right">Last</SortableTh>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cls = r.daysUntil <= 2 ? 'text-rose-400' : r.daysUntil <= 7 ? 'text-amber-400' : 'text-neutral-300';
              return (
                <tr
                  key={r.ticker}
                  onClick={() => onFocus?.(r.ticker)}
                  className={`border-b border-neutral-900 cursor-pointer hover:bg-neutral-900/50 transition-colors ${
                    focusTicker === r.ticker ? 'bg-emerald-500/5' : ''
                  }`}
                >
                  <td className="px-3 py-1.5 font-semibold text-neutral-200">{r.ticker}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${cls}`}>{r.daysUntil}d</td>
                  <td className="px-3 py-1.5 text-neutral-400">{r.date}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300">
                    {r.beatsLast4 != null && r.beatsLast4Quarters > 0
                      ? `${r.beatsLast4}/${r.beatsLast4Quarters}`
                      : dash}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${
                    r.lastSurprisePct == null ? 'text-neutral-700' : r.lastSurprisePct > 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}>
                    {r.lastSurprisePct != null ? `${r.lastSurprisePct > 0 ? '+' : ''}${r.lastSurprisePct.toFixed(1)}%` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
