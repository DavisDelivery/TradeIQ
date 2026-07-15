// VECTOR — two-axis verdict (the evaluator core).
//
// Pure functions, no I/O: the live evaluator, the event cards, and the
// backtest all call these with features computed at their own t. Constants
// come from vector-constants.ts and are frozen per the validation rule.
//
// Null discipline: a null input never silently scores. Each null feature
// contributes 0 points AND lands in `noData` so the UI can render _noData
// flags (design: "unresolved => null + _noData, never silently").

import {
  F_AXIS,
  T_AXIS,
  quadrantOf,
  type FVerdict,
  type TVerdict,
  type Quadrant,
} from './vector-constants';

// ---------------------------------------------------------------------
// F axis — is it fundamentally a good buy (max 6)
// ---------------------------------------------------------------------

export interface FInputs {
  /** Piotroski 9-point, from statements filed <= t. null => _noData. */
  fscore: number | null;
  /** Most recent SUE at t. null => no earnings history. */
  latestSue: number | null;
  /** Count of consecutive positive SUE quarters ending at t (0 if none/unknown). */
  consecutivePositiveSue: number;
  /** Net insider open-market dollars, trailing 90d. null => _noData. */
  insiderNet90d: number | null;
  /** Sell-cluster context active at t (>=2 sellers, >=$1M agg, 90d). */
  sellCluster: boolean;
  /** Change in distinct 13F holders between two most recent FILED quarters. */
  instDelta: number | null;
}

export interface FResult {
  verdict: FVerdict;
  points: number;
  max: number;
  /** Per-rule contributions for pillar bars / sub-score display. */
  parts: { rule: string; points: number }[];
  noData: string[];
}

export function scoreFAxis(f: FInputs): FResult {
  const parts: { rule: string; points: number }[] = [];
  const noData: string[] = [];
  let pts = 0;

  if (f.fscore == null) {
    noData.push('fscore');
  } else if (f.fscore >= F_AXIS.fscoreHigh.min) {
    pts += F_AXIS.fscoreHigh.points;
    parts.push({ rule: `fscore >= ${F_AXIS.fscoreHigh.min}`, points: F_AXIS.fscoreHigh.points });
  } else if (f.fscore >= F_AXIS.fscoreMid.min) {
    pts += F_AXIS.fscoreMid.points;
    parts.push({ rule: `fscore ${F_AXIS.fscoreMid.min}-${F_AXIS.fscoreMid.max}`, points: F_AXIS.fscoreMid.points });
  } else {
    parts.push({ rule: `fscore <= ${F_AXIS.fscoreLow.max}`, points: 0 });
  }

  if (f.latestSue == null) {
    noData.push('latestSue');
  } else if (f.latestSue >= F_AXIS.latestSue.min) {
    pts += F_AXIS.latestSue.points;
    parts.push({ rule: `SUE >= +${F_AXIS.latestSue.min}`, points: F_AXIS.latestSue.points });
  }

  if (f.consecutivePositiveSue >= F_AXIS.consecutivePositiveSue.min) {
    pts += F_AXIS.consecutivePositiveSue.points;
    parts.push({
      rule: `>= ${F_AXIS.consecutivePositiveSue.min} consecutive positive SUE`,
      points: F_AXIS.consecutivePositiveSue.points,
    });
  }

  if (f.insiderNet90d == null) {
    noData.push('insiderNet90d');
  } else if (f.insiderNet90d >= F_AXIS.insiderNet90d.min) {
    pts += F_AXIS.insiderNet90d.points;
    parts.push({ rule: `insiderNet90d >= +$${F_AXIS.insiderNet90d.min / 1000}k`, points: F_AXIS.insiderNet90d.points });
  }

  if (f.sellCluster) {
    pts += F_AXIS.sellClusterPenalty;
    parts.push({ rule: 'sellCluster', points: F_AXIS.sellClusterPenalty });
  }

  if (f.instDelta == null) {
    noData.push('instDelta');
  } else if (f.instDelta >= F_AXIS.instDelta.min) {
    pts += F_AXIS.instDelta.points;
    parts.push({ rule: `instDelta >= +${F_AXIS.instDelta.min}`, points: F_AXIS.instDelta.points });
  }

  const verdict: FVerdict =
    pts >= F_AXIS.cuts.strong ? 'STRONG' : pts <= F_AXIS.cuts.weakMax ? 'WEAK' : 'NEUTRAL';
  return { verdict, points: pts, max: F_AXIS.max, parts, noData };
}

// ---------------------------------------------------------------------
// T axis — is now a good entry
// ---------------------------------------------------------------------

export interface TInputs {
  close: number;
  sma50: number | null;
  sma200: number | null;
  /** close/SMA50 - 1. null when SMA50 unavailable. */
  extension: number | null;
  /** ATR14/ATR63. null when insufficient bars. */
  contraction: number | null;
  /** Regime label at t. Anything not offense/panic scores 0 regime points. */
  regime: 'offense' | 'neutral' | 'caution' | 'panic' | null;
  /** 1 - close/max(high,252d). null when insufficient bars. */
  drawdown: number | null;
  /** EMA20 at t. Only consulted by the drawdown variant. */
  ema20: number | null;
  /** Higher 5-day low vs the prior 5-day window ("stabilized" leg). */
  higherFiveDayLow: boolean | null;
}

export interface TResult {
  verdict: TVerdict;
  points: number;
  parts: { rule: string; points: number }[];
  noData: string[];
  /** true when the drawdown variant (dd >= 20%) decided the verdict. */
  drawdownVariant: boolean;
  /** Set when a force-POOR rule fired (parabola / panic / falling knife). */
  forcedPoor: string | null;
}

export function scoreTAxis(t: TInputs): TResult {
  const parts: { rule: string; points: number }[] = [];
  const noData: string[] = [];
  let pts = 0;
  let forcedPoor: string | null = null;

  // Trend points
  if (t.sma200 == null) {
    noData.push('sma200');
  } else if (t.close > t.sma200 && t.sma50 != null && t.sma50 > t.sma200) {
    pts += T_AXIS.trendBothPoints;
    parts.push({ rule: 'close > SMA200 and SMA50 > SMA200', points: T_AXIS.trendBothPoints });
  } else if (t.close > t.sma200) {
    pts += T_AXIS.trendCloseOnlyPoints;
    parts.push({ rule: 'close > SMA200', points: T_AXIS.trendCloseOnlyPoints });
  }
  if (t.sma50 == null) noData.push('sma50');

  // Extension
  if (t.extension == null) {
    noData.push('extension');
  } else if (t.extension > T_AXIS.extensionForcePoor) {
    forcedPoor = `extension > ${T_AXIS.extensionForcePoor * 100}%`;
  } else if (t.extension <= T_AXIS.extensionOkMax) {
    pts += 1;
    parts.push({ rule: `extension <= ${T_AXIS.extensionOkMax * 100}%`, points: 1 });
  }

  // Contraction
  if (t.contraction == null) {
    noData.push('contraction');
  } else if (t.contraction <= T_AXIS.contractionMax) {
    pts += 1;
    parts.push({ rule: `contraction <= ${T_AXIS.contractionMax}`, points: 1 });
  }

  // Regime
  if (t.regime == null) {
    noData.push('regime');
  } else if (t.regime === 'offense') {
    pts += T_AXIS.regimeOffensePoints;
    parts.push({ rule: 'regime offense', points: T_AXIS.regimeOffensePoints });
  } else if (t.regime === 'panic') {
    forcedPoor = forcedPoor ?? 'regime panic';
  }

  // Drawdown variant — dd >= 20% replaces the points verdict with the
  // stabilization test: GOOD iff close > EMA20 AND higher 5-day low.
  // A falling knife is POOR by definition until it has stopped.
  const inDrawdown = t.drawdown != null && t.drawdown >= T_AXIS.drawdownVariant.minDrawdown;
  if (inDrawdown) {
    // Panic still forces POOR even in the variant.
    if (t.regime === 'panic') {
      return { verdict: 'POOR', points: pts, parts, noData, drawdownVariant: true, forcedPoor: 'regime panic' };
    }
    if (t.ema20 == null) noData.push('ema20');
    if (t.higherFiveDayLow == null) noData.push('higherFiveDayLow');
    const stabilized =
      t.ema20 != null && t.close > t.ema20 && t.higherFiveDayLow === true;
    return {
      verdict: stabilized ? 'GOOD' : 'POOR',
      points: pts,
      parts,
      noData,
      drawdownVariant: true,
      forcedPoor: stabilized ? null : 'falling knife not stabilized',
    };
  }

  if (forcedPoor) {
    return { verdict: 'POOR', points: pts, parts, noData, drawdownVariant: false, forcedPoor };
  }
  const verdict: TVerdict =
    pts >= T_AXIS.cuts.good ? 'GOOD' : pts <= T_AXIS.cuts.poorMax ? 'POOR' : 'NEUTRAL';
  return { verdict, points: pts, parts, noData, drawdownVariant: false, forcedPoor: null };
}

// ---------------------------------------------------------------------
// Combined verdict
// ---------------------------------------------------------------------

export interface VectorVerdict {
  f: FResult;
  t: TResult;
  quadrant: Quadrant;
}

export function evaluateVector(f: FInputs, t: TInputs): VectorVerdict {
  const fr = scoreFAxis(f);
  const tr = scoreTAxis(t);
  return { f: fr, t: tr, quadrant: quadrantOf(fr.verdict, tr.verdict) };
}
