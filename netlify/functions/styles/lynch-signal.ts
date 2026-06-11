// Lynch discrete signal layer (Phase 4m, W2).
//
// Peter Lynch was a long-term GARP investor who held positions for months
// to years and sold when the STORY changed (PEG expanded, growth slowed,
// debt deteriorated) — NOT when a stop level got hit. Forcing a Lynch
// candidate into a day-trader's price stop would misrepresent the strategy.
//
// So Lynch's discrete signal is an INVESTMENT signal:
//
//   BUY   — fundamentals + valuation align (PEG < 1.0 in the sweet spot,
//           consistent earnings, sustainable growth, manageable debt)
//   HOLD  — partially attractive (one or two pillars fail)
//   AVOID — at least one disqualifier: PEG > 2 / declining revenue /
//           debt-to-equity > 2 / two or more loss quarters / clearly
//           unprofitable
//
// Instead of a price stop, the signal carries:
//   - a FAIR-VALUE BAND derived from the Lynch fair-PEG range
//     (PEG ≈ 1.0 → cheap, 1.5 → fair upper); when the price exceeds the
//     upper band the thesis is "priced in";
//   - a FUNDAMENTAL-INVALIDATION list — the conditions under which the
//     thesis breaks (an exit signal triggered by data, not by price).
//
// This module is a thin layer on top of `runLynch` in `./lynch.ts`. The
// scoring math (`runLynch`) is unchanged; we only consume its AnalystScore
// + the underlying inputs to derive the discrete verdict and levels.

import type { AnalystScore } from '../shared/style-types';
import { LYNCH_GROWTH_MIN_PCT, LYNCH_GROWTH_MAX_PCT } from './lynch';

export type LynchVerdict = 'BUY' | 'HOLD' | 'AVOID';

/** PEG sweet-spot upper bound (Lynch: "fair" up to ~1.5). */
export const PEG_FAIR_UPPER = 1.5;
/** PEG hard rejection ("priced for perfection"). */
export const PEG_AVOID_THRESHOLD = 2.0;
/** Debt-to-equity hard rejection. */
export const DE_AVOID_THRESHOLD = 2.0;
/** Lynch sweet-spot revenue growth band. */
export const REV_GROWTH_MIN = 0.15;
export const REV_GROWTH_MAX = 0.5;
/** BUY minimum score (continuous score from runLynch). */
export const BUY_SCORE_FLOOR = 30;
/** AVOID maximum score (anything below = AVOID candidate). */
export const AVOID_SCORE_CEILING = -10;

export interface LynchSignal {
  verdict: LynchVerdict;
  /** Fair-value band: the price range implied by Lynch's fair PEG (≈1.0–1.5). */
  fairValueLow: number | null;
  fairValueHigh: number | null;
  /** Snapshot of the implied PEG ratio at signal time (for UI + reports). */
  peg: number | null;
  /** Conditions whose breach invalidates the thesis (no price stop). */
  invalidationConditions: string[];
  /** Verdict drivers — what the discrete call was built on. */
  reasons: string[];
}

export interface LynchSignalInputs {
  /** From `runLynch` output. */
  score: number;
  /** From `runLynch.signals`. */
  peg?: number;
  peRatio?: number;
  /** EPS growth in % — TTM-vs-prior-TTM since Wave 4C (review M5); the
   *  key name is kept for snapshot/UI compatibility (TTM-on-TTM is still
   *  a year-over-year rate). Clamped to [LYNCH_GROWTH_MIN_PCT,
   *  LYNCH_GROWTH_MAX_PCT] before the fair-P/E band is derived. */
  epsGrowthYoYPct?: number;
  revGrowthYoYPct?: number;
  debtToEquity?: number;
  positiveQtrs?: number;
  /** Latest close price. Required to emit a fair-value BAND. */
  currentPrice?: number;
  /** Trailing-twelve-month EPS (preferred), or annualized EPS. */
  ttmEps?: number;
}

/**
 * Derive the discrete Lynch signal from the `runLynch` output + the
 * underlying numeric inputs.
 *
 * Pure function — no I/O. Caller is responsible for assembling the
 * `currentPrice` and `ttmEps` from snapshot/fundamentals data.
 */
export function deriveLynchSignal(input: LynchSignalInputs): LynchSignal {
  const {
    score,
    peg,
    peRatio,
    epsGrowthYoYPct,
    revGrowthYoYPct,
    debtToEquity,
    positiveQtrs,
    currentPrice,
    ttmEps,
  } = input;

  const reasons: string[] = [];
  const invalidationConditions: string[] = [];

  // ----- Disqualifiers (any → AVOID) -----------------------------------
  const disqualifiers: string[] = [];
  if (peg !== undefined && peg >= PEG_AVOID_THRESHOLD) {
    disqualifiers.push(`PEG ${peg.toFixed(2)} ≥ ${PEG_AVOID_THRESHOLD.toFixed(1)} (priced for perfection)`);
  }
  if (peRatio !== undefined && peRatio < 0) {
    disqualifiers.push('unprofitable (negative trailing EPS)');
  }
  if (debtToEquity !== undefined && debtToEquity > DE_AVOID_THRESHOLD) {
    disqualifiers.push(`D/E ${debtToEquity.toFixed(2)} > ${DE_AVOID_THRESHOLD.toFixed(1)} (over-leveraged)`);
  }
  if (revGrowthYoYPct !== undefined && revGrowthYoYPct < 0) {
    disqualifiers.push(`revenue ${revGrowthYoYPct.toFixed(0)}% YoY (declining)`);
  }
  if (positiveQtrs !== undefined && positiveQtrs <= 2) {
    disqualifiers.push(`only ${positiveQtrs}/4 profitable quarters`);
  }

  // ----- Verdict --------------------------------------------------------
  let verdict: LynchVerdict;
  if (disqualifiers.length > 0 || score <= AVOID_SCORE_CEILING) {
    verdict = 'AVOID';
    reasons.push(...(disqualifiers.length > 0 ? disqualifiers : [`score ${score.toFixed(0)} below floor`]));
  } else if (
    score >= BUY_SCORE_FLOOR &&
    peg !== undefined &&
    peg < PEG_FAIR_UPPER &&
    (positiveQtrs === undefined || positiveQtrs >= 3) &&
    (revGrowthYoYPct === undefined || revGrowthYoYPct >= REV_GROWTH_MIN * 100) &&
    (debtToEquity === undefined || debtToEquity <= 1.0)
  ) {
    verdict = 'BUY';
    reasons.push(`PEG ${peg.toFixed(2)} in Lynch sweet spot`);
    if (revGrowthYoYPct !== undefined && revGrowthYoYPct >= REV_GROWTH_MIN * 100 && revGrowthYoYPct <= REV_GROWTH_MAX * 100) {
      reasons.push(`revenue +${revGrowthYoYPct.toFixed(0)}% (sustainable growth)`);
    }
    if (positiveQtrs !== undefined && positiveQtrs === 4) {
      reasons.push('4/4 profitable quarters');
    }
    if (debtToEquity !== undefined && debtToEquity < 0.3) {
      reasons.push(`low debt (D/E ${debtToEquity.toFixed(2)})`);
    }
  } else {
    verdict = 'HOLD';
    if (peg === undefined) reasons.push('PEG unavailable');
    else if (peg >= PEG_FAIR_UPPER) reasons.push(`PEG ${peg.toFixed(2)} above sweet spot`);
    if (score < BUY_SCORE_FLOOR && score > AVOID_SCORE_CEILING) {
      reasons.push(`score ${score.toFixed(0)} between BUY floor and AVOID ceiling`);
    }
    if (positiveQtrs !== undefined && positiveQtrs < 3) {
      reasons.push(`${positiveQtrs}/4 profitable quarters`);
    }
  }

  // ----- Fair-value band ------------------------------------------------
  // Lynch's rule of thumb: a fair P/E equals the EPS growth rate (in %).
  // So fair-value LOW  = ttmEps × growth%        (PEG = 1.0, "cheap")
  //    fair-value HIGH = ttmEps × growth% × 1.5  (PEG = 1.5, "fair upper")
  // We only emit a band when ttmEps > 0 and growth > 0.
  //
  // Wave 4C (review M5): growth is clamped to the sustainable Lynch range
  // before deriving the fair P/E. The rule assumes a multi-year sustainable
  // rate; un-clamped, a base-effect EPS rebound (+300% off a depressed
  // comp) implied a "fair" P/E of 300-450 and a fantasy band.
  let fairValueLow: number | null = null;
  let fairValueHigh: number | null = null;
  if (
    ttmEps !== undefined &&
    ttmEps > 0 &&
    epsGrowthYoYPct !== undefined &&
    epsGrowthYoYPct > 0
  ) {
    const growthPct = Math.min(
      LYNCH_GROWTH_MAX_PCT,
      Math.max(LYNCH_GROWTH_MIN_PCT, epsGrowthYoYPct),
    );
    const fairPeLow = growthPct; // PEG = 1.0
    const fairPeHigh = growthPct * PEG_FAIR_UPPER; // PEG = 1.5
    fairValueLow = round(ttmEps * fairPeLow, 2);
    fairValueHigh = round(ttmEps * fairPeHigh, 2);
  }

  // ----- Fundamental invalidation conditions ---------------------------
  // These are the conditions under which the BUY/HOLD thesis breaks.
  // For AVOID we keep the list empty — the thesis is already broken.
  if (verdict !== 'AVOID') {
    invalidationConditions.push(
      `PEG expands above ${PEG_AVOID_THRESHOLD.toFixed(1)}`,
      'EPS growth turns negative for 2 consecutive quarters',
      `Debt-to-equity exceeds ${DE_AVOID_THRESHOLD.toFixed(1)}`,
      'Revenue growth turns negative YoY',
    );
    if (currentPrice !== undefined && fairValueHigh !== null && currentPrice < fairValueHigh) {
      invalidationConditions.push(
        `Price rises above fair-value ceiling (~${fairValueHigh.toFixed(2)})`,
      );
    }
  }

  // If price already exceeds the fair-value ceiling, BUY can downgrade to HOLD.
  if (
    verdict === 'BUY' &&
    currentPrice !== undefined &&
    fairValueHigh !== null &&
    currentPrice > fairValueHigh
  ) {
    return {
      verdict: 'HOLD',
      fairValueLow,
      fairValueHigh,
      peg: peg ?? null,
      invalidationConditions,
      reasons: [
        `price ${currentPrice.toFixed(2)} above fair-value ceiling ${fairValueHigh.toFixed(2)}`,
        ...reasons,
      ],
    };
  }

  return {
    verdict,
    fairValueLow,
    fairValueHigh,
    peg: peg ?? null,
    invalidationConditions,
    reasons,
  };
}

/**
 * Convenience: derive a Lynch signal directly from a `runLynch`
 * AnalystScore + the price/EPS inputs that the AnalystScore alone
 * doesn't carry. Pulls everything else out of `score.signals`.
 */
export function deriveLynchSignalFromAnalyst(
  analyst: Pick<AnalystScore, 'score' | 'signals'>,
  extras: { currentPrice?: number; ttmEps?: number } = {},
): LynchSignal {
  const sig = analyst.signals as Record<string, unknown>;
  return deriveLynchSignal({
    score: analyst.score,
    peg: numOrUndef(sig.peg),
    peRatio: numOrUndef(sig.peRatio),
    epsGrowthYoYPct: numOrUndef(sig.epsGrowthYoYPct),
    revGrowthYoYPct: numOrUndef(sig.revGrowthYoYPct),
    debtToEquity: numOrUndef(sig.debtToEquity),
    positiveQtrs: numOrUndef(sig.positiveQtrs),
    currentPrice: extras.currentPrice,
    ttmEps: extras.ttmEps,
  });
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function round(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}
