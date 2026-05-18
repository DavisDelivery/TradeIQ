// Williams discrete signal layer (Phase 4m, W1).
//
// Larry Williams was a short-term technical trader. His discrete signal is a
// TRADE signal: BUY / SELL / HOLD with concrete entry, stop, and target
// levels. The levels are volatility/ATR-based, authentic to how Williams
// actually sized his trades — he scaled position size to volatility so that
// each setup risked a roughly constant dollar amount.
//
// This module is a thin layer on top of `runWilliams` in `./williams.ts`.
// It does NOT rewrite the scoring logic — it consumes the AnalystScore
// (continuous score + signals dict) and derives the discrete verdict from
// indicator CONFLUENCE, not a bare score-threshold cut:
//
//   BUY = (%R turning up from oversold OR %R deep oversold)
//         AND (volatility breakout long OR closing strength elevated)
//         AND trend not opposed (not in a confirmed downtrend)
//         AND composite score ≥ +20
//
//   SELL = (%R rolling over from overbought OR %R deeply overbought)
//          AND (volatility breakout short OR closing strength weak)
//          AND trend not opposed (not in a confirmed uptrend)
//          AND composite score ≤ −20
//
//   HOLD = anything else.
//
// Levels (BUY example; SELL is symmetric below the entry):
//   entry  = latest close (next-bar at-market)
//   atr    = Wilder ATR(14)
//   stop   = entry − ATR_STOP_MULT × ATR    (volatility-derived invalidation)
//   target = entry + ATR_TARGET_MULT × R    (R = entry − stop, the dollar risk)
//
// ATR_STOP_MULT and ATR_TARGET_MULT default to 2.0 and 3.0 respectively,
// giving a 3:1 reward:risk ratio. Williams' wins-pay-for-losses discipline
// was built on small losses + outsized winners — a 3R target encodes that.
// The pair is exported so the backtest harness can stress-test other values.

import type { AnalystScore } from '../shared/style-types';
import type { Bar } from '../shared/data-provider';

export const ATR_PERIOD = 14;
export const ATR_STOP_MULT = 2.0;
export const ATR_TARGET_MULT = 3.0;

export type WilliamsVerdict = 'BUY' | 'SELL' | 'HOLD';

export interface WilliamsSignal {
  verdict: WilliamsVerdict;
  entry: number | null;
  stop: number | null;
  target: number | null;
  atr: number | null;
  /** Dollar risk per share (entry − stop for BUY, stop − entry for SELL). */
  riskPerShare: number | null;
  /** Target / risk multiple. Always ATR_TARGET_MULT when levels are emitted. */
  riskRewardRatio: number | null;
  /** Confluence factors the verdict was built on (for UI + audit). */
  reasons: string[];
}

export interface WilliamsSignalInputSignals {
  williamsR?: number;
  wrTurning?: boolean;
  wrTopping?: boolean;
  volBreakoutLong?: boolean;
  volBreakoutShort?: boolean;
  closeStrength10d?: number;
  uptrend?: boolean;
  downtrend?: boolean;
}

/**
 * Derive the discrete Williams signal from a (score, bars) pair.
 *
 * No I/O — pure function over the AnalystScore signals dict + bars array.
 * Returns a HOLD with null levels if there aren't enough bars to compute
 * ATR(14) (we need at least 15 bars: 14 TR values + the first close).
 */
export function deriveWilliamsSignal(
  scoreOutput: Pick<AnalystScore, 'score' | 'signals'>,
  bars: Bar[],
): WilliamsSignal {
  if (bars.length < ATR_PERIOD + 1) {
    return holdSignal(['insufficient bars for ATR']);
  }

  const sig = scoreOutput.signals as WilliamsSignalInputSignals;
  const wr = sig.williamsR ?? -50;
  const closeStrength = sig.closeStrength10d ?? 50;

  // Confluence flags
  const wrBullish = sig.wrTurning === true || wr <= -80;
  const volLong = sig.volBreakoutLong === true;
  const strengthOk = closeStrength >= 60;
  const trendOpposingBuy = sig.downtrend === true;

  const wrBearish = sig.wrTopping === true || wr >= -20;
  const volShort = sig.volBreakoutShort === true;
  const weakness = closeStrength <= 40;
  const trendOpposingSell = sig.uptrend === true;

  const buyConfluence = wrBullish && (volLong || strengthOk) && !trendOpposingBuy;
  const sellConfluence =
    wrBearish && (volShort || weakness) && !trendOpposingSell;

  const score = scoreOutput.score;

  let verdict: WilliamsVerdict = 'HOLD';
  const reasons: string[] = [];

  if (buyConfluence && score >= 20) {
    verdict = 'BUY';
    if (sig.wrTurning) reasons.push('%R turning up from oversold');
    else if (wr <= -80) reasons.push(`%R deep oversold (${wr.toFixed(0)})`);
    if (volLong) reasons.push('volatility breakout long');
    else if (strengthOk) reasons.push(`closing strong (${closeStrength.toFixed(0)}%)`);
    if (sig.uptrend) reasons.push('trend aligned (20>50 EMA)');
  } else if (sellConfluence && score <= -20) {
    verdict = 'SELL';
    if (sig.wrTopping) reasons.push('%R rolling over from overbought');
    else if (wr >= -20) reasons.push(`%R extended (${wr.toFixed(0)})`);
    if (volShort) reasons.push('volatility breakout short');
    else if (weakness) reasons.push(`closing weak (${closeStrength.toFixed(0)}%)`);
    if (sig.downtrend) reasons.push('trend aligned (20<50 EMA)');
  } else {
    if (Math.abs(score) < 20) reasons.push('score below confluence threshold');
    else if (!buyConfluence && score > 0) reasons.push('long score without confluence');
    else if (!sellConfluence && score < 0) reasons.push('short score without confluence');
    return holdSignal(reasons);
  }

  const atr = computeATR(bars, ATR_PERIOD);
  const entry = bars[bars.length - 1].c;
  if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(entry) || entry <= 0) {
    return holdSignal(['invalid ATR or close']);
  }

  const stop = verdict === 'BUY' ? entry - ATR_STOP_MULT * atr : entry + ATR_STOP_MULT * atr;
  const riskPerShare = verdict === 'BUY' ? entry - stop : stop - entry;
  const target =
    verdict === 'BUY'
      ? entry + ATR_TARGET_MULT * riskPerShare
      : entry - ATR_TARGET_MULT * riskPerShare;

  return {
    verdict,
    entry: round(entry, 2),
    stop: round(stop, 2),
    target: round(target, 2),
    atr: round(atr, 3),
    riskPerShare: round(riskPerShare, 2),
    riskRewardRatio: ATR_TARGET_MULT,
    reasons,
  };
}

/**
 * Wilder's ATR(period). Uses simple-mean seed for the first `period` TR
 * values, then exponential smoothing α = 1/period for the rest. The
 * function trusts that `bars.length >= period + 1` — callers check.
 */
export function computeATR(bars: Bar[], period: number): number {
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h;
    const l = bars[i].l;
    const prevC = bars[i - 1].c;
    const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    trs.push(tr);
  }
  if (trs.length < period) return NaN;
  // Wilder seed: mean of the first `period` TRs
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  // Wilder smoothing for the rest
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function holdSignal(reasons: string[]): WilliamsSignal {
  return {
    verdict: 'HOLD',
    entry: null,
    stop: null,
    target: null,
    atr: null,
    riskPerShare: null,
    riskRewardRatio: null,
    reasons,
  };
}

function round(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}
