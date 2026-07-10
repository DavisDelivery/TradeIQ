// DESK-1 W2 — watchlist Signal cell.
//
// Derives chips from ALREADY-FETCHED board query data (target + prophet
// hooks share the React Query cache with the board views) — there is NO
// per-ticker signal endpoint by design. Every model signal rendered on
// the Desk carries its board verdict chip (FIX-1 W4 enforcement): a
// tier badge without the measured-edge context would be the exact
// "narrative outranks measurement" failure the verdict registry exists
// to prevent.

import React from 'react';
import { VerdictChip } from '../VerdictChip.jsx';

/**
 * Build a { TICKER: signals[] } map from the cached board payloads.
 * Pure — exported for tests.
 */
export function buildSignalMap(targetData, prophetData) {
  const map = {};
  const push = (ticker, sig) => {
    const t = String(ticker || '').toUpperCase();
    if (!t) return;
    if (!map[t]) map[t] = [];
    map[t].push(sig);
  };
  for (const row of targetData?.targets ?? []) {
    push(row.ticker, {
      board: 'target',
      label: `TGT ${row.tier ?? '—'}·${row.composite ?? '—'}`,
    });
  }
  for (const pick of prophetData?.picks ?? []) {
    push(pick.ticker, {
      board: 'prophet',
      label: `PRO ${pick.conviction ?? '—'}`,
    });
  }
  return map;
}

export function SignalCell({ signals }) {
  if (!signals || signals.length === 0) {
    return <span className="text-neutral-700 font-mono text-[10px]">—</span>;
  }
  return (
    <div className="flex flex-col gap-0.5 items-start">
      {signals.map((s, i) => (
        <span key={`${s.board}-${i}`} className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="text-[9px] font-mono uppercase tracking-widest text-neutral-300 border border-neutral-700 bg-neutral-900/60 px-1 py-0.5">
            {s.label}
          </span>
          <VerdictChip board={s.board} compact />
        </span>
      ))}
    </div>
  );
}
