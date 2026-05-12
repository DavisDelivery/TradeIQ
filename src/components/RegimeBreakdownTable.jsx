import React, { useMemo } from 'react';
import { useSortable, SortableTh } from '../lib/useSortable.jsx';
import { ChartPanel } from './KpiCard.jsx';

// RegimeBreakdownTable — performance attribution per macro regime.
//
// The backtest engine writes per-regime rollups onto run.metrics.byRegime
// as { regime, rebalances, totalReturn, sharpe } rows. Sortable per
// TradeIQ standing rule (useSortable + SortableTh).

const fmtPct = (v) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(2)}%`);
const fmtNum = (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(3));
const fmtInt = (v) => (v == null || Number.isNaN(v) ? '—' : String(v));

export function RegimeBreakdownTable({ byRegime }) {
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('rebalances', 'desc');
  const rows = useMemo(() => sortRows(byRegime ?? []), [byRegime, sortRows]);

  if (!Array.isArray(byRegime) || byRegime.length === 0) {
    return (
      <ChartPanel title="By regime" subtitle="No regime data on this run">
        <div className="h-[80px] flex items-center justify-center text-xs text-neutral-500 font-mono">
          empty
        </div>
      </ChartPanel>
    );
  }

  return (
    <ChartPanel title="By regime" subtitle="Rebalances + return per macro regime">
      <div className="overflow-x-auto -mx-3 sm:-mx-4">
        <table className="min-w-full text-xs font-mono">
          <thead>
            <tr className="text-neutral-500">
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="regime" className="px-3 py-2">
                Regime
              </SortableTh>
              <SortableTh
                sortKey={sortKey}
                sortDir={sortDir}
                sortBy={sortBy}
                field="rebalances"
                align="right"
                className="px-3 py-2"
              >
                Rebal
              </SortableTh>
              <SortableTh
                sortKey={sortKey}
                sortDir={sortDir}
                sortBy={sortBy}
                field="totalReturn"
                align="right"
                className="px-3 py-2"
              >
                Return
              </SortableTh>
              <SortableTh
                sortKey={sortKey}
                sortDir={sortDir}
                sortBy={sortBy}
                field="sharpe"
                align="right"
                className="px-3 py-2"
              >
                Sharpe
              </SortableTh>
            </tr>
          </thead>
          <tbody className="text-neutral-200">
            {rows.map((r, i) => (
              <tr
                key={`${r.regime ?? 'unknown'}-${i}`}
                className="border-t border-neutral-800"
              >
                <td className="px-3 py-2 text-neutral-300">{r.regime ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.rebalances)}</td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${
                    (r.totalReturn ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {fmtPct(r.totalReturn)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.sharpe)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartPanel>
  );
}
