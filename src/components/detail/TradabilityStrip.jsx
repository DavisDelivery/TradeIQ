// PROFILE-1 W1.1 — the tradability strip.
//
// POSITION-SIZING FACTS, NOT SIGNALS. Nothing here predicts anything, and
// the copy is written so it cannot be read that way. High relative volume is
// not bullish; a wide ATR is not opportunity; a small float is not a squeeze.
// Each of these answers one question — "how much of this can I buy, and how
// much does it move on an ordinary day?" — which is the question you have to
// answer BEFORE any board's opinion is worth acting on.
//
// That is why it sits directly under the hero, above the chart: it is the
// constraint on the trade, and a constraint discovered after the thesis is a
// constraint discovered too late.
//
// ATR is shown in BOTH dollars and percent, deliberately. Dollars is what the
// stop is written in; percent is what makes two names comparable.

import React from 'react';
import { useStockDetail } from '../../hooks/useStockDetail.js';

export function fmtUsdCompact(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtShares(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  // Finviz reports float in MILLIONS of shares.
  if (v >= 1000) return `${(v / 1000).toFixed(2)}B`;
  return `${v.toFixed(0)}M`;
}

export function fmtNum(v, dp = 2) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dp) : '—';
}

export function fmtPct(v, dp = 1) {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(dp)}%` : '—';
}

/** Cells with a value. An all-null block renders nothing at all. */
export function tradabilityCells(t) {
  if (!t) return [];
  const cells = [
    { label: 'Avg $ vol', value: fmtUsdCompact(t.advDollar), raw: t.advDollar },
    { label: 'ATR', value: t.atr == null ? '—' : `$${fmtNum(t.atr)}`, raw: t.atr },
    { label: 'ATR %', value: fmtPct(t.atrPct), raw: t.atrPct },
    { label: 'Rel. vol', value: fmtNum(t.relativeVolume), raw: t.relativeVolume },
    { label: 'Float', value: fmtShares(t.floatM), raw: t.floatM },
  ];
  return cells.filter((c) => typeof c.raw === 'number' && Number.isFinite(c.raw));
}

export function TradabilityStrip({ ticker }) {
  const { data } = useStockDetail(ticker);
  const cells = tradabilityCells(data?.finviz?.tradability);

  // No skeleton and no empty shell: a strip of five dashes is worse than no
  // strip, and this is decoration until it has numbers.
  if (cells.length === 0) return null;

  return (
    <section
      data-testid="tradability-strip"
      className="border border-neutral-800/80 bg-neutral-950/30 px-4 py-3"
    >
      <div className="text-[9px] uppercase tracking-[0.2em] text-neutral-600 font-mono mb-2">
        Tradability
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        {cells.map((c) => (
          <div key={c.label} data-testid={`trad-${c.label}`}>
            <dt className="text-[9px] uppercase tracking-widest text-neutral-500">{c.label}</dt>
            <dd className="text-[14px] tabular-nums text-neutral-100">{c.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[10px] text-neutral-600">
        How much you can buy and how far it moves on an ordinary day — not a signal.
      </p>
    </section>
  );
}
