import React, { useMemo } from 'react';
import { useSortable, SortableTh } from '../lib/useSortable.jsx';
import { ChartPanel } from './ChartPanel.jsx';

// Phase 4b — per-regime breakdown. metrics.perRegime is shaped as
// Record<regime, { avgSegmentReturnPct, totalReturnPct, rebalanceCount }>.
// Flatten into rows, run through useSortable, render with SortableTh per
// the standing rule.
//
// Regimes from netlify/functions/shared/regime.ts: 'risk_on' | 'risk_off'
// | 'neutral'. Older runs may have null; we surface those as '(unknown)'.
//
// code-review-2026-06 track-3 minor 2 — the old per-regime "Sharpe"
// (cross-sectional segment returns annualized with √(252/20)) was
// statistically meaningless and is no longer emitted. We render the honest
// replacement: average 20d segment return (un-annualized, percent). Runs
// persisted before Wave 4D only carry `sharpe` and show '—' here.

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Number(v).toFixed(2)}%`;
}
function colorByReturn(v) {
  if (v == null || !Number.isFinite(v)) return 'text-neutral-200';
  return v >= 0 ? 'text-emerald-300' : 'text-rose-300';
}

export function RegimeBreakdownTable({ perRegime }) {
  const rows = useMemo(() => {
    if (!perRegime || typeof perRegime !== 'object') return [];
    return Object.entries(perRegime).map(([regime, m]) => ({
      regime: regime || '(unknown)',
      rebalanceCount: Number.isFinite(m?.rebalanceCount) ? m.rebalanceCount : 0,
      totalReturnPct: Number.isFinite(m?.totalReturnPct) ? m.totalReturnPct : null,
      avgSegmentReturnPct: Number.isFinite(m?.avgSegmentReturnPct)
        ? m.avgSegmentReturnPct
        : null,
    }));
  }, [perRegime]);

  const { sortKey, sortDir, sortBy, sortRows } = useSortable('rebalanceCount', 'desc');
  const sorted = sortRows(rows);

  if (rows.length === 0) {
    return (
      <ChartPanel title="Per-regime breakdown" subtitle="Avg 20d segment return + total return by macro regime">
        <div className="text-neutral-500 font-mono text-[11px] text-center py-6">
          No regime breakdown in run.
        </div>
      </ChartPanel>
    );
  }

  return (
    <ChartPanel title="Per-regime breakdown" subtitle="Avg 20d segment return + total return by macro regime">
      <div className="overflow-x-auto" data-testid="regime-breakdown-table">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="border-b border-neutral-800 text-neutral-500">
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="regime">
                Regime
              </SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="rebalanceCount" align="right">
                Rebalances
              </SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="totalReturnPct" align="right">
                Total Return
              </SortableTh>
              <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="avgSegmentReturnPct" align="right">
                Avg 20d Seg Ret
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.regime} className="border-b border-neutral-900/60 hover:bg-neutral-900/40">
                <td className="px-3 py-2 text-neutral-200">{row.regime}</td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-300">{row.rebalanceCount}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${colorByReturn(row.totalReturnPct)}`}>
                  {fmtPct(row.totalReturnPct)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${colorByReturn(row.avgSegmentReturnPct)}`}>
                  {fmtPct(row.avgSegmentReturnPct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartPanel>
  );
}
