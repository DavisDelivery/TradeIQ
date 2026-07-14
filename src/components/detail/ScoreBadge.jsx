// Phase 6 W2 — board-specific score badge for the StockDetailPanel hero.
//
// Each board grades a ticker on its own scale, so the badge is board-aware:
//   - williams / lynch: the signed style score (−100..+100) coloured by sign,
//     plus the discrete verdict pill (BUY/SELL/HOLD or BUY/HOLD/AVOID) when
//     the board row carries one.
//   - target: the composite (0..100) coloured by tier, plus the conviction
//     tier badge.
// All three also render the long/short/neutral direction pill.

import React from 'react';
import { ConvictionBadge, DirectionPill } from '../Badges.jsx';
import { tierColor } from '../../lib/formatters.jsx';

const VERDICT_STYLES = {
  BUY: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  SELL: 'text-rose-300 border-rose-500/40 bg-rose-500/10',
  AVOID: 'text-rose-300 border-rose-500/40 bg-rose-500/10',
  HOLD: 'text-neutral-400 border-neutral-700 bg-neutral-900/40',
};

function VerdictPill({ verdict }) {
  if (!verdict) return null;
  return (
    <span
      className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border ${
        VERDICT_STYLES[verdict] ?? VERDICT_STYLES.HOLD
      }`}
    >
      {verdict}
    </span>
  );
}

export function ScoreBadge({ board, rationale, row }) {
  const direction = rationale?.direction ?? row?.direction ?? null;

  if (board === 'fable') {
    // FABLE: percentile among gate-passers is the display number.
    const pctl = row?.percentile ?? null;
    const composite = row?.composite ?? null;
    return (
      <div className="flex items-baseline gap-2">
        {pctl != null && (
          <span className="font-mono tabular-nums text-2xl font-semibold leading-none text-neutral-100">
            {Math.round(pctl)}
          </span>
        )}
        {composite != null && (
          <span className="font-mono tabular-nums text-xs text-neutral-500">({composite} comp)</span>
        )}
      </div>
    );
  }

  if (board === 'target') {
    const tier = rationale?.tier ?? row?.tier ?? null;
    const composite = rationale?.composite ?? row?.composite ?? null;
    return (
      <div className="flex items-center gap-2">
        {composite != null && (
          <span
            className="font-mono tabular-nums text-2xl font-semibold leading-none"
            style={{ color: tierColor(tier) }}
          >
            {composite}
          </span>
        )}
        {tier && <ConvictionBadge tier={tier} />}
        {direction && <DirectionPill direction={direction} />}
      </div>
    );
  }

  // williams / lynch — signed style score.
  const score = rationale?.score ?? row?.score ?? null;
  const verdict = row?.verdict ?? row?.signal?.verdict ?? null;
  const positive = (score ?? 0) >= 0;
  return (
    <div className="flex items-center gap-2">
      {score != null && (
        <span
          className={`font-mono tabular-nums text-2xl font-semibold leading-none ${
            positive ? 'text-emerald-400' : 'text-rose-400'
          }`}
        >
          {positive ? '+' : ''}
          {Math.round(score)}
        </span>
      )}
      <VerdictPill verdict={verdict} />
      {direction && <DirectionPill direction={direction} />}
    </div>
  );
}
