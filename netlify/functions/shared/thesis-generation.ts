// Phase 6 W1 — server-side strategy-specific thesis prose.
//
// Each generator consumes the decomposed ScoreComponent[] (see
// score-breakdown.ts) plus a small context object and produces a 2-3 sentence
// plain-text thesis paragraph for the detail-panel ThesisParagraph component
// (Phase 6 W2). The prose is built from the components that actually fired —
// it never invents a signal the analyst didn't produce.
//
// This is presentation/synthesis only. It does not change scoring.

import type { ScoreComponent } from './score-breakdown';

export interface ThesisContext {
  ticker: string;
  name: string;
  sector: string;
  /** The authoritative −100..+100 style score from runWilliams / runLynch. */
  score: number;
}

function favorable(components: ScoreComponent[]): ScoreComponent[] {
  return components
    .filter((c) => !c.noData && c.score > 0)
    .sort((a, b) => b.score - a.score);
}

function unfavorable(components: ScoreComponent[]): ScoreComponent[] {
  return components
    .filter((c) => !c.noData && c.score < 0)
    .sort((a, b) => a.score - b.score);
}

function joinClauses(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Williams — short-term technical / momentum
// ---------------------------------------------------------------------------

export function generateWilliamsThesis(
  components: ScoreComponent[],
  ctx: ThesisContext,
): string {
  const allNoData = components.every((c) => c.noData);
  if (allNoData) {
    return `No Williams setup for ${ctx.name} (${ctx.ticker}) — insufficient price history to evaluate the short-term momentum signals.`;
  }

  const pos = favorable(components);
  const neg = unfavorable(components);

  if (ctx.score >= 20) {
    const drivers = joinClauses(pos.slice(0, 3).map((c) => c.rationale));
    return `Long-side momentum setup — ${drivers}. Williams' short-term technical screen reads ${ctx.name} (${ctx.ticker}) as a long entry with a composite setup score of ${ctx.score.toFixed(0)} in ${ctx.sector}.`;
  }

  if (ctx.score <= -20) {
    const drivers = joinClauses(neg.slice(0, 3).map((c) => c.rationale));
    return `Short-side setup — ${drivers}. Williams' screen reads ${ctx.name} (${ctx.ticker}) as a momentum-down candidate with a composite setup score of ${ctx.score.toFixed(0)} in ${ctx.sector}.`;
  }

  // Neutral band: no confluence either way.
  const note = pos.length >= neg.length && pos.length > 0
    ? joinClauses(pos.slice(0, 2).map((c) => c.rationale))
    : neg.length > 0
      ? joinClauses(neg.slice(0, 2).map((c) => c.rationale))
      : 'mixed signals with no confluence';
  return `No actionable Williams setup for ${ctx.name} (${ctx.ticker}) — ${note}. The composite setup score of ${ctx.score.toFixed(0)} sits below the confluence threshold, so the screen stays on the sidelines.`;
}

// ---------------------------------------------------------------------------
// Lynch — growth at a reasonable price
// ---------------------------------------------------------------------------

export function generateLynchThesis(
  components: ScoreComponent[],
  ctx: ThesisContext,
): string {
  const peg = components.find((c) => c.name.startsWith('PEG'));
  const allNoData = components.every((c) => c.noData);
  if (allNoData || (peg?.noData && components.filter((c) => !c.noData).length === 0)) {
    return `No Lynch read on ${ctx.name} (${ctx.ticker}) — insufficient fundamentals to evaluate growth-at-a-reasonable-price.`;
  }

  // Unprofitable special case (PEG component carries the −15 penalty).
  if (peg && !peg.noData && peg.score === -15 && peg.rationale.includes('unprofitable')) {
    return `${ctx.name} (${ctx.ticker}) is unprofitable on trailing earnings — outside Lynch's GARP universe, which screens for steady, reasonably-priced earnings growth. Composite Lynch score ${ctx.score.toFixed(0)}.`;
  }

  const pos = favorable(components);
  const neg = unfavorable(components);

  if (ctx.score >= 30) {
    const drivers = joinClauses(pos.slice(0, 4).map((c) => c.rationale));
    return `GARP thesis — ${drivers}. Lynch's screen captures ${ctx.name} (${ctx.ticker}) as growth at a reasonable price with a composite score of ${ctx.score.toFixed(0)} in ${ctx.sector}.`;
  }

  if (ctx.score <= -10) {
    const drivers = joinClauses(neg.slice(0, 3).map((c) => c.rationale));
    return `Lynch screen flags ${ctx.name} (${ctx.ticker}) — ${drivers}. The composite score of ${ctx.score.toFixed(0)} puts it outside the growth-at-a-reasonable-price window.`;
  }

  const note = pos.length > 0
    ? joinClauses(pos.slice(0, 2).map((c) => c.rationale))
    : 'no clear GARP edge';
  const caveat = neg.length > 0 ? `, offset by ${joinClauses(neg.slice(0, 2).map((c) => c.rationale))}` : '';
  return `Mixed Lynch read on ${ctx.name} (${ctx.ticker}) — ${note}${caveat}. Composite score ${ctx.score.toFixed(0)} sits in the hold range.`;
}
