// DESK-1 W4 — the point of the whole tab: YOUR base rates, computed
// client-side from CLOSED journal trades (src/lib/baseRates.js — pure,
// unit-tested). Grouped by setup tag and by board: n, win%, avgWin%,
// avgLoss%, expectancy, last-10 W/L strip.
//
// Honesty gate: below n=5 the row renders GREYED with "insufficient
// sample" — a 2-trade base rate is presented as noise, never signal.

import React, { useEffect, useMemo, useState } from 'react';
import { readLog } from '../../tradeLog.js';
import { baseRatesBySetup, baseRatesByBoard, MIN_SAMPLE } from '../../lib/baseRates.js';
import { useSortable, SortableTh } from '../../lib/useSortable.jsx';

const dash = <span className="text-neutral-700">—</span>;

function WlStrip({ strip }) {
  if (!strip || strip.length === 0) return dash;
  return (
    <span className="tracking-tighter">
      {strip.map((r, i) => (
        <span key={i} className={r === 'W' ? 'text-emerald-400' : 'text-rose-400'}>{r}</span>
      ))}
    </span>
  );
}

function RatesTable({ rows, groupLabel, testId }) {
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('expectancy', 'desc');
  if (!rows || rows.length === 0) {
    return (
      <div className="p-3 text-[11px] font-mono text-neutral-600">
        No closed trades yet — base rates populate as you record exits.
      </div>
    );
  }
  const sorted = sortRows(rows);
  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <table className="w-full text-[11px] font-mono">
        <thead>
          <tr className="text-neutral-500 border-b border-neutral-800/80">
            <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="key">{groupLabel}</SortableTh>
            <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="n" align="right">n</SortableTh>
            <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="winRate" align="right">Win%</SortableTh>
            <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="avgWinPct" align="right">AvgW</SortableTh>
            <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="avgLossPct" align="right">AvgL</SortableTh>
            <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="expectancy" align="right">Expcy</SortableTh>
            <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="n" align="right">Last 10</SortableTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const grey = r.insufficientSample;
            return (
              <tr
                key={r.key}
                data-testid={`baserate-row-${r.key}`}
                className={`border-b border-neutral-900 ${grey ? 'opacity-40' : ''}`}
                title={grey ? `insufficient sample (n<${MIN_SAMPLE}) — not signal` : undefined}
              >
                <td className="px-3 py-1.5 text-neutral-200">
                  {r.key}
                  {grey && (
                    <span className="ml-1.5 text-[8px] uppercase tracking-widest text-neutral-500">
                      insufficient sample
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300">{r.n}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-200">{(r.winRate * 100).toFixed(0)}%</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                  {r.avgWinPct != null ? `+${r.avgWinPct.toFixed(1)}%` : dash}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-rose-400">
                  {r.avgLossPct != null ? `${r.avgLossPct.toFixed(1)}%` : dash}
                </td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${r.expectancy > 0 ? 'text-emerald-400' : r.expectancy < 0 ? 'text-rose-400' : 'text-neutral-300'}`}>
                  {r.expectancy > 0 ? '+' : ''}{r.expectancy.toFixed(2)}
                </td>
                <td className="px-3 py-1.5 text-right"><WlStrip strip={r.lastTen} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function BaseRatesPanel() {
  const [log, setLog] = useState(() => readLog());
  const [group, setGroup] = useState('setup'); // 'setup' | 'board'

  useEffect(() => {
    const refresh = () => setLog(readLog());
    window.addEventListener('tradelog:change', refresh);
    return () => window.removeEventListener('tradelog:change', refresh);
  }, []);

  const rows = useMemo(
    () => (group === 'setup' ? baseRatesBySetup(log) : baseRatesByBoard(log)),
    [log, group],
  );

  return (
    <section data-testid="desk-baserates" className="border border-neutral-800 bg-neutral-950/40">
      <div className="px-3 h-9 flex items-center justify-between border-b border-neutral-800/80">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">Your Base Rates</div>
        <div className="flex items-center border border-neutral-800 bg-neutral-900/60">
          {['setup', 'board'].map((g) => (
            <button
              key={g}
              onClick={() => setGroup(g)}
              className={`px-2 h-6 text-[9px] font-mono uppercase tracking-widest transition-colors ${
                group === g ? 'bg-emerald-500/15 text-emerald-400' : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              by {g}
            </button>
          ))}
        </div>
      </div>
      <RatesTable
        rows={rows}
        groupLabel={group === 'setup' ? 'Setup' : 'Board'}
        testId={`baserates-${group}`}
      />
      <div className="px-3 py-2 text-[9px] font-mono text-neutral-600 border-t border-neutral-900">
        Computed from closed journal trades only. Expectancy = win%·avgW − loss%·|avgL| (pp/trade).
      </div>
    </section>
  );
}
