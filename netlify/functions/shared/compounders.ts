// COMP-1 (2026-08-21) — the Compounders board: quality-led, momentum-confirmed.
//
// WHY THIS BOARD EXISTS
//
// Owner's report: "I asked you for your two highest-conviction picks — NVDA
// and SpaceX — and in all the boards you have built me those have never come
// up." That is true, and it is not a bug in any individual board. It is a gap
// in the SET of boards. Every live ranking board looks for a DISLOCATION:
//
//   quiet-strength  the part of a 12-1 move factor exposure does NOT explain
//   insider         open-market buying by people with non-public information
//   catalyst        an identifiable near-term event
//   earnings        a surprise against consensus
//   crosses         a technical regime change
//
// A dislocation screen is by construction a NON-CONSENSUS screen. The most
// consensus large-cap on earth cannot rank on any of them, and quiet-strength
// is the sharpest case: it regresses the move onto the factors and ranks the
// RESIDUAL, so a mega-cap whose move is factor-explained scores near zero BY
// DESIGN. Nothing we owned looked for a durable franchise compounding at a
// high rate. This board does.
//
// WHAT THE EVIDENCE ALLOWS (reports/research-2026-08/screener-evidence.md,
// commissioned after all seven ranking boards were measured and none beat
// buy-and-hold)
//
//   Survivor #1  Momentum, 12-1 with a one-month skip. Best-replicated
//                anomaly: 212 years of US data, 40 countries, best HXZ
//                survivor. Cost: real, recurring crashes.
//   Survivor #2  Cash-based operating profitability. Survives HXZ AND the
//                q-factor model; QMJ positive in 23 of 24 countries; low
//                turnover, large capacity.
//
// SECOND DEPARTURE, ALSO STATED: WE SHIP GROSS PROFITABILITY, NOT CASH-BASED.
//
// The report's survivor is cash-based operating profitability and it calls the
// definition load-bearing. What this board computes is Novy-Marx gross profits
// over assets. Those are not the same measurement: the report's claim has two
// halves — the ASSETS denominator (which we honour) and the CASH-BASED
// numerator that strips accruals (which we do not). We ship the accrual
// version because gross_profit and total_assets are the fields the statement
// provider actually returns, and reconstructing a cash-based numerator needs
// an accruals build we do not have. That is a real weakening of the evidence
// behind this axis, written here rather than left for a reader to notice that
// the citation and the code describe different ratios.
//   Method       INTEGRATED scoring beats two independently-formed sleeves
//                (Fisher, Shah & Titman 2016) — lower turnover, and it will
//                not buy a name that is excellent on one axis and terrible
//                on the other.
//
// THE DELIBERATE DEPARTURE: NO VALUE AXIS.
//
// The house recommendation is integrated quality-VALUE, and `quality-value.ts`
// implements it. This board deliberately does not use it, for one stated
// reason: a cheapness axis is precisely what excludes a high-multiple
// franchise. NVDA trades at 32.9x earnings and 26.9x book; on any composite
// value score it ranks near the floor, so quality-value would rank it
// mid-pack at best and the owner's complaint would survive the build.
//
// The evidence permits dropping it. The same report records that the order is
// ASYMMETRIC — splitting a value portfolio by momentum adds value, splitting
// a momentum portfolio by value does not. We are not owed a value axis here.
// What we ARE owed is the honesty that this is a departure, so: the board is
// labelled as such, and its verdict stays UNMEASURED until forward-tested.
//
// THE HONEST PART ABOUT NVDA. Quality is the axis it wins on, not momentum.
// Measured 2026-08-21 from its own detail bundle: gross profits / assets
// ~0.64 against a top-quintile threshold near 0.33-0.40 — roughly double, and
// top-percentile. But trailing-year relative strength versus SPY is +2.23%
// cumulative and it sits at the 69.9th percentile of its own 52-week range.
// It is a quality outlier that is NOT currently a momentum leader. So this
// board is built quality-LED with momentum CONFIRMING.
//
// HOW MUCH TO TRUST THE WEIGHTS. No parameter was swept against outcomes. But
// "not tuned to any ticker" would be too strong: the board was DESIGNED after
// looking at one name's profile, and a review found that an earlier version of
// the test suite pinned an NVDA-shaped placement tightly enough to lock
// QUALITY_WEIGHT at roughly >= 0.57. Nobody swept a parameter, but a
// ticker-shaped result had become a regression invariant. Those assertions now
// test the MECHANISM — quality can carry a momentum laggard — rather than a
// placement threshold, so the weight is free to move. Honest summary: the two
// axes are evidence-led; the 60/40 split between them is a judgement made by
// someone who had NVDA's profile in mind.

import {
  percentileRank,
  grossProfitsToAssets,
  type QualityBasis,
} from './quality-value';
import {
  applyUniversePolicy,
  type UniverseCandidate,
  type ExclusionReason,
} from './research-policy';

/**
 * Blend weights on the two percentile axes.
 *
 * Quality carries more because it is the persistent, low-turnover,
 * large-capacity axis and the one with the milder crash profile; momentum is
 * the confirming axis and the one that bleeds in a reversal. A judgement, not
 * a fitted parameter: nothing was swept against outcomes. It was, however,
 * chosen by someone who had already looked at the profile of the stock that
 * prompted the board — see the header. The tests deliberately do not pin a
 * placement that would lock this value. `QUALITY_WEIGHT + MOMENTUM_WEIGHT === 1`.
 */
export const QUALITY_WEIGHT = 0.6;
export const MOMENTUM_WEIGHT = 0.4;

/**
 * Junk-momentum guard. A name in the bottom quartile of profitability is out
 * regardless of how hard it has run — that combination is the classic
 * momentum-crash casualty, and QMJ's whole finding is that junk does not pay.
 * Expressed as a percentile floor so it adapts to the universe.
 *
 * THERE IS DELIBERATELY NO RECIPROCAL MOMENTUM FLOOR, and that asymmetry
 * points the same way the board's origin story does: a name at the 1st
 * momentum percentile with top quality still ranks (0.6*1.0 + 0.4*0.01), which
 * is exactly the profile that prompted the board. The defence is that it
 * follows from calling this quality-LED rather than a blend of equals — but a
 * reader is entitled to know it is a second structural choice favouring the
 * originating case. "Momentum CONFIRMING" describes a weight, not a gate.
 */
export const MIN_QUALITY_PCT = 0.25;

export interface CompounderInput extends UniverseCandidate {
  ticker: string;
  sector?: string | null;
  industry?: string | null;
  /** Novy-Marx numerator, absolute currency. Exact basis. */
  grossProfit?: number | null;
  /** Novy-Marx denominator, absolute currency. Exact basis. */
  totalAssets?: number | null;
  /** Documented fallback when statements are unavailable — see qualityOf. */
  roePct?: number | null;
  /**
   * 12-1 momentum in percent: the trailing twelve-month return SKIPPING the
   * most recent month. The skip is not optional — without it the signal is
   * contaminated by short-term reversal, which is itself a dead factor
   * (Jegadeesh 1990) pointing the other way.
   */
  momentum12_1Pct?: number | null;
}

export type ScoreBasis = 'exact' | 'roe-proxy';

export interface CompounderScore {
  ticker: string;
  sector: string | null;
  /** 0..1 blended percentile, higher is better. Null if either axis is unscorable. */
  composite: number | null;
  qualityPct: number | null;
  momentumPct: number | null;
  /** The raw gross-profits-to-assets ratio when the exact basis was available. */
  grossProfitability: number | null;
  momentum12_1Pct: number | null;
  qualityBasis: QualityBasis;
  /** Why a candidate that survived the universe filter still did not score. */
  unscorable: UnscorableReason | null;
}

export type UnscorableReason = 'no-quality' | 'no-momentum' | 'below-quality-floor';

export interface CompounderResult {
  scored: CompounderScore[];
  excluded: Record<ExclusionReason, number>;
  unscorable: Record<UnscorableReason, number>;
  universeChecked: number;
  /** How many scored names used the exact Novy-Marx basis rather than the proxy. */
  exactBasisCount: number;
  /**
   * Scored names per quality basis. A MIXED pool is legal but suspect: the two
   * bases are ranked separately (they are not comparable), which means a
   * proxied name can top its own small group and outrank exactly-measured
   * names. Callers that care — the scan does — should force one basis.
   */
  basisMix: Record<string, number>;
}

/**
 * Quality for one candidate, exact basis first.
 *
 * The ROE fallback is a genuine downgrade and is labelled as one. ROE has a
 * LEVERAGE PROBLEM the Novy-Marx ratio does not: equity is the denominator,
 * so a company can manufacture a high ROE by borrowing. Gross profits over
 * ASSETS cannot be gamed that way, which is exactly why Hou/Xue/Zhang found
 * the assets denominator survives replication where book-equity does not.
 * The proxy exists so a name is ranked rather than silently dropped; the
 * basis travels with the score so the UI can say which one it used.
 */
export function qualityOf(c: CompounderInput): {
  value: number | null;
  basis: QualityBasis;
} {
  const exact = grossProfitsToAssets(c.grossProfit, c.totalAssets);
  if (exact !== null) return { value: exact, basis: 'gross-profits-to-assets' };
  const roe = c.roePct;
  if (typeof roe === 'number' && Number.isFinite(roe)) {
    return { value: roe, basis: 'roe-proxy' };
  }
  return { value: null, basis: 'none' };
}

/**
 * Rank a universe.
 *
 * Percentiles are computed over the candidates that HAVE each input, so a
 * sparse column does not drag everyone toward the middle. The two axes are
 * then blended only where BOTH exist — a name missing either axis is
 * unscorable rather than scored on half the evidence, because a half-scored
 * name silently competes against fully-scored ones on a different basis.
 */
export function scoreCompounders(candidates: CompounderInput[]): CompounderResult {
  const filtered = applyUniversePolicy(candidates);
  const kept = filtered.kept;

  const qual = kept.map((c) => qualityOf(c));

  // PERCENTILES ARE COMPUTED WITHIN A BASIS, NEVER ACROSS ONE.
  //
  // This was a real defect, not a hypothetical. qualityOf returns a RATIO for
  // the exact basis (gross profits / assets, ~0.1-0.7) and a PERCENT for the
  // ROE fallback (~5-40). Ranked in one pool, every proxied name outranks
  // every exactly-measured name on units alone — so a handful of failed
  // statement fetches would quietly take the top of the board, and the board
  // would look completely normal. Ranking inside each basis keeps a name
  // compared only against names measured the same way.
  const qualityPcts: Array<number | null> = kept.map(() => null);
  for (const basis of new Set(qual.map((q) => q.basis))) {
    if (basis === 'none') continue;
    const idx = qual.map((q, i) => (q.basis === basis ? i : -1)).filter((i) => i >= 0);
    const within = percentileRank(idx.map((i) => qual[i].value), true);
    idx.forEach((i, k) => { qualityPcts[i] = within[k]; });
  }
  const momentumPcts = percentileRank(
    kept.map((c) => c.momentum12_1Pct ?? null),
    true,
  );

  const unscorable: Record<UnscorableReason, number> = {
    'no-quality': 0,
    'no-momentum': 0,
    'below-quality-floor': 0,
  };

  const scored: CompounderScore[] = kept.map((c, i) => {
    const qPct = qualityPcts[i];
    const mPct = momentumPcts[i];
    const basis = qual[i].basis;
    const exactRatio =
      basis === 'gross-profits-to-assets' ? qual[i].value : null;

    let reason: UnscorableReason | null = null;
    if (qPct === null) reason = 'no-quality';
    else if (mPct === null) reason = 'no-momentum';
    else if (qPct < MIN_QUALITY_PCT) reason = 'below-quality-floor';
    if (reason) unscorable[reason] += 1;

    return {
      ticker: c.ticker,
      sector: c.sector ?? null,
      composite:
        reason === null
          ? QUALITY_WEIGHT * (qPct as number) + MOMENTUM_WEIGHT * (mPct as number)
          : null,
      qualityPct: qPct,
      momentumPct: mPct,
      grossProfitability: exactRatio,
      momentum12_1Pct: c.momentum12_1Pct ?? null,
      qualityBasis: basis,
      unscorable: reason,
    };
  });

  scored.sort((a, b) => {
    if (a.composite === null && b.composite === null) return 0;
    if (a.composite === null) return 1;
    if (b.composite === null) return -1;
    return b.composite - a.composite;
  });

  return {
    scored,
    excluded: filtered.counts,
    unscorable,
    universeChecked: candidates.length,
    exactBasisCount: scored.filter(
      (s) => s.composite !== null && s.qualityBasis === 'gross-profits-to-assets',
    ).length,
    basisMix: scored.reduce<Record<string, number>>((acc, s) => {
      if (s.composite === null) return acc;
      acc[s.qualityBasis] = (acc[s.qualityBasis] ?? 0) + 1;
      return acc;
    }, {}),
  };
}
