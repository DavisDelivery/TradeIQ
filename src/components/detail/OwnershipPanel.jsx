// PROFILE-1 W1.3 — ownership and short structure.
//
// SHORT INTEREST IS SHOWN AS A PAIR, ALWAYS. Raw short interest lost its
// predictive significance after 2000 (Hong et al.); the form that survived is
// interest scaled by liquidity — days to cover, i.e. how many sessions of
// normal volume it would take to buy the position back. Showing the float
// percentage alone is showing the half that stopped working, so this panel
// renders neither figure without reaching for the other.
//
// AND IT PICKS NO SIDE. Elevated short interest is simultaneously a bearish
// position someone took deliberately and the fuel for a squeeze. Both
// readings are stated; the direction table classifies it 'flag' precisely so
// no arrow or colour can imply one of them. That is why this panel has no
// green and no red anywhere.
//
// The insider figures here are STATIC OWNERSHIP, a different thing from the
// opportunistic-cluster signal in insider-conviction.ts. Ownership says how
// much management holds; the cluster screen says what they just did. Kept
// visibly separate so the weaker fact cannot borrow the stronger one's
// evidence.

import React from 'react';
import { useStockDetail } from '../../hooks/useStockDetail.js';

export const fmtPct2 = (v, dp = 2) =>
  typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(dp)}%` : null;

export const fmtDays = (v) =>
  typeof v === 'number' && Number.isFinite(v)
    ? `${v.toFixed(1)} day${v === 1 ? '' : 's'}`
    : null;

export const fmtFloatM = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v >= 1000 ? `${(v / 1000).toFixed(2)}B sh` : `${v.toFixed(0)}M sh`;
};

/**
 * Both readings of a short position, never one.
 *
 * Returns null below a threshold where neither reading is interesting —
 * narrating "0.9% short, 1.8 days to cover" as though it were a finding is
 * how a panel teaches someone to see signals in noise.
 */
export function shortNarrative(shortFloatPct, shortRatio) {
  if (typeof shortFloatPct !== 'number' || !Number.isFinite(shortFloatPct)) return null;
  if (shortFloatPct < 5) return null;

  const cover = typeof shortRatio === 'number' && Number.isFinite(shortRatio)
    ? `${shortRatio.toFixed(1)} days to cover`
    : 'days-to-cover unavailable';

  return `${shortFloatPct.toFixed(1)}% of float is sold short (${cover}). That is both a ` +
    'deliberate bearish position and, if the thesis breaks, buying pressure — the figure ' +
    'does not say which.';
}

export function ownershipRows(o) {
  if (!o) return [];
  return [
    { label: 'Institutional', value: fmtPct2(o.instOwnPct, 1) },
    { label: 'Insider', value: fmtPct2(o.insiderOwnPct, 2) },
    { label: 'Insider net trans.', value: fmtPct2(o.insiderTransPct, 2) },
    { label: 'Float', value: fmtFloatM(o.floatM) },
    { label: 'Short % of float', value: fmtPct2(o.shortFloatPct, 2) },
    { label: 'Days to cover', value: fmtDays(o.shortRatio) },
  ].filter((r) => r.value !== null);
}

export function OwnershipPanel({ ticker }) {
  const { data } = useStockDetail(ticker);
  const o = data?.finviz?.ownership ?? null;
  const rows = ownershipRows(o);

  if (rows.length === 0) return null;

  const narrative = shortNarrative(o?.shortFloatPct, o?.shortRatio);

  return (
    <section
      data-testid="ownership-panel"
      className="border border-neutral-800/80 bg-neutral-950/30 p-4"
    >
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">
        Ownership &amp; short structure
      </div>

      <dl className="divide-y divide-neutral-900">
        {rows.map((r) => (
          <div key={r.label} data-testid={`own-${r.label}`} className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="text-[12px] text-neutral-400">{r.label}</dt>
            <dd className="text-[13px] tabular-nums text-neutral-100">{r.value}</dd>
          </div>
        ))}
      </dl>

      {narrative && (
        <p data-testid="own-short-narrative" className="mt-3 text-[11px] leading-relaxed text-neutral-400">
          {narrative}
        </p>
      )}

      <p className="mt-2 text-[10px] text-neutral-600">
        Point-in-time, not a trend — the archive needed to show the direction of short interest
        does not exist yet.
      </p>
    </section>
  );
}
