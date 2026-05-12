import React, { useMemo } from 'react';
import { useSortable, SortableTh } from '../lib/useSortable.jsx';
import { ChartPanel } from './ChartPanel.jsx';

// Phase 4b — top trades by realized P&L.
//
// The TradeRecord shape (rebalanceDate, ticker, side, weights, notional,
// slippage, commission, refPrice) does NOT carry per-trade P&L or
// entry/exit prices on opposite legs — the engine writes one trade row
// per weight delta at each rebalance, not a paired entry/exit.
//
// Attribution rows DO carry per-position period returns
// {rebalanceDate, ticker, weight, segmentReturn, contribution}, where
// segmentReturn is the return over the (rebalance, next-rebalance]
// window. That's the closest the engine writes to a "trade outcome" and
// is what the chart's caption reflects.
//
// We rank by |contribution| (size-weighted P&L impact on the portfolio)
// and show the top 10 by raw contribution — that mixes winners and
// losers, which is what the brief asks for ("top 10 by P&L"; sortable
// per standing rule lets the user re-rank by segment return or weight).

function fmtPct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Number(v).toFixed(digits)}%`;
}

function colorByReturn(v) {
  if (v == null || !Number.isFinite(v)) return 'text-neutral-200';
  return v >= 0 ? 'text-emerald-300' : 'text-rose-300';
}

function topByAbsContribution(attribution, n = 10) {
  const rows = (attribution || [])
    .filter((r) => Number.isFinite(r?.contribution))
    .map((r) => ({
      rebalanceDate: r.rebalanceDate,
      ticker: r.ticker,
      weightPct: Number.isFinite(r?.weight) ? +(r.weight * 100).toFixed(2) : null,
      segmentReturnPct: Number.isFinite(r?.segmentReturn) ? +(r.segmentReturn * 100).toFixed(2) : null,
      contributionPct: +(r.contribution * 100).toFixed(3),
      regime: r?.regime ?? null,
    }));
  rows.sort((a, b) => Math.abs(b.contributionPct) - Math.abs(a.contributionPct));
  return rows.slice(0, n);
}

export function TopTradesTable({ attribution }) {
  const rows = useMemo(() => topByAbsContribution(attribution, 10), [attribution]);

  // Default sort: contribution desc (biggest winners on top); user can
  // flip to ascending to see biggest losers, or sort by any column.
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('contributionPct', 'desc');
  const sorted = sortRows(rows);

  if (rows.length === 0) {
    return (
      <ChartPanel title="Top 10 positions by P&L" subtitle="From attribution subcollection">
        <div className="text-neutral-500 font-mono text-[11px] text-center py-6">
          No attribution rows in run.
        </div>
      </ChartPanel>
    );
  }

  return (
    <ChartPanel
      title="Top 10 positions by P&L"
      subtitle="Ranked by |contribution| — both winners and losers appear"
    >
      <div className="overflow-x-auto" data-testid="top-trades-table">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="border-b border-neutral-800 text-neutral-500">
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ticker">
                Ticker
              </SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="rebalanceDate">
                Entry
              </SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="weightPct" align="right">
                Weight
              </SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="segmentReturnPct" align="right">
                Segment Ret
              </SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="contributionPct" align="right">
                Contribution
              </SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="regime">
                Regime
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr
                key={`${r.ticker}-${r.rebalanceDate}-${i}`}
                className="border-b border-neutral-900/60 hover:bg-neutral-900/40"
              >
                <td className="px-3 py-2 text-neutral-200 font-semibold">{r.ticker}</td>
                <td className="px-3 py-2 text-neutral-400 text-[10px]">{r.rebalanceDate}</td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
                  {fmtPct(r.weightPct)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${colorByReturn(r.segmentReturnPct)}`}>
                  {fmtPct(r.segmentReturnPct)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${colorByReturn(r.contributionPct)}`}>
                  {fmtPct(r.contributionPct, 3)}
                </td>
                <td className="px-3 py-2 text-neutral-400 text-[10px]">{r.regime ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartPanel>
  );
}
