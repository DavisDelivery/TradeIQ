import React, { useMemo } from 'react';
import { useSortable, SortableTh } from '../lib/useSortable.jsx';
import { ChartPanel } from './KpiCard.jsx';

// TopTradesTable — top 10 trades by realized P&L%, sortable.
//
// Trade rows from the engine: { ticker, entryDate, exitDate, entryPrice,
// exitPrice, pnl, pnlPct, holdDays, ... }. The endpoint caps at 500
// trades; we slice to top 10 by absolute P&L% so big losers also surface
// (Phase 4a honesty: largest losers are as informative as largest winners).

const TOP_N = 10;

const fmtPct = (v) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(2)}%`);
const fmtPrice = (v) => (v == null || Number.isNaN(v) ? '—' : `$${Number(v).toFixed(2)}`);
const fmtDate = (v) => (v == null ? '—' : String(v).slice(0, 10));
const fmtInt = (v) => (v == null || Number.isNaN(v) ? '—' : String(v));

export function TopTradesTable({ trades }) {
  // Cap to top 10 by absolute P&L% before sorting, so users always see the
  // most impactful trades regardless of current sort column.
  const top10 = useMemo(() => {
    if (!Array.isArray(trades) || trades.length === 0) return [];
    return [...trades]
      .filter((t) => t && typeof t.pnlPct === 'number')
      .sort((a, b) => Math.abs(b.pnlPct) - Math.abs(a.pnlPct))
      .slice(0, TOP_N);
  }, [trades]);

  const { sortKey, sortDir, sortBy, sortRows } = useSortable('pnlPct', 'desc');
  const rows = useMemo(() => sortRows(top10), [top10, sortRows]);

  if (top10.length === 0) {
    return (
      <ChartPanel title="Top trades" subtitle={`Top ${TOP_N} by |P&L%|`}>
        <div className="h-[80px] flex items-center justify-center text-xs text-neutral-500 font-mono">
          no trades on this run
        </div>
      </ChartPanel>
    );
  }

  return (
    <ChartPanel
      title="Top trades"
      subtitle={`Top ${TOP_N} by |P&L%| — winners and losers`}
    >
      <div className="overflow-x-auto -mx-3 sm:-mx-4">
        <table className="min-w-full text-xs font-mono">
          <thead>
            <tr className="text-neutral-500">
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ticker" className="px-3 py-2">
                Ticker
              </SortableTh>
              <SortableTh
                sortKey={sortKey}
                sortDir={sortDir}
                sortBy={sortBy}
                field="entryDate"
                className="px-3 py-2"
              >
                In
              </SortableTh>
              <SortableTh
                sortKey={sortKey}
                sortDir={sortDir}
                sortBy={sortBy}
                field="exitDate"
                className="px-3 py-2"
              >
                Out
              </SortableTh>
              <SortableTh
                sortKey={sortKey}
                sortDir={sortDir}
                sortBy={sortBy}
                field="entryPrice"
                align="right"
                className="px-3 py-2"
              >
                Entry
              </SortableTh>
              <SortableTh
                sortKey={sortKey}
                sortDir={sortDir}
                sortBy={sortBy}
                field="exitPrice"
                align="right"
                className="px-3 py-2"
              >
                Exit
              </SortableTh>
              <SortableTh
                sortKey={sortKey}
                sortDir={sortDir}
                sortBy={sortBy}
                field="pnlPct"
                align="right"
                className="px-3 py-2"
              >
                P&amp;L%
              </SortableTh>
              <SortableTh
                sortKey={sortKey}
                sortDir={sortDir}
                sortBy={sortBy}
                field="holdDays"
                align="right"
                className="px-3 py-2"
              >
                Hold
              </SortableTh>
            </tr>
          </thead>
          <tbody className="text-neutral-200">
            {rows.map((t, i) => (
              <tr
                key={`${t.ticker}-${t.entryDate}-${i}`}
                className="border-t border-neutral-800"
              >
                <td className="px-3 py-2 text-neutral-300">{t.ticker ?? '—'}</td>
                <td className="px-3 py-2 text-neutral-400">{fmtDate(t.entryDate)}</td>
                <td className="px-3 py-2 text-neutral-400">{fmtDate(t.exitDate)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtPrice(t.entryPrice)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtPrice(t.exitPrice)}</td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${
                    (t.pnlPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {fmtPct(t.pnlPct)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-400">
                  {fmtInt(t.holdDays)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartPanel>
  );
}
