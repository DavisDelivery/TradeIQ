// FIX-2 W1 — pure earnings play classification + composite scoring.
//
// Extracted verbatim (behaviour-preserving) from
// `scan-earnings.ts::scoreEarningsForTicker` so ONE implementation is
// shared by:
//   - the live scan (scan-earnings.ts), and
//   - the PIT backtest scorer (backtest/score-at-date.ts, FIX-2 W1),
// and so W3 has a SINGLE place to replace the composite with a score
// re-derived from the PEAD event study.
//
// Pure: no fetches, no clock, no I/O. `daysUntil` and `postPrint` are
// passed in — the live scan computes them from `Date.now()`, the PIT
// scorer computes them relative to `asOfDate`. That parameterisation is
// the whole point: the classification math must not itself read a clock.
//
// **W3 REPLACES `scoreEarningsComposite` ONLY.** The playType taxonomy
// (classifyEarnings) is measured, not changed, by FIX-2 — surviving
// playTypes keep their labels; the number attached to them becomes
// monotonic in the realized bucket edge instead of the hand-typed
// 70/75/65/35 constants below.

import type { EarningsPlayType, EarningsSetup } from './types';

// ---------------------------------------------------------------------------
// Volatility helpers — pure (mirror scan-earnings.ts annVol/chunksAnnVol/avg)
// Shared so the live scan, the PIT backtest scorer, and the W2 event study
// all compute RV rank / expected move identically.
// ---------------------------------------------------------------------------

export function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Annualized daily-log-return vol (√252). */
export function annVol(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = avg(returns);
  const variance = avg(returns.map((r) => (r - mean) ** 2));
  return Math.sqrt(variance) * Math.sqrt(252);
}

/** Non-overlapping `window`-length chunk annualized vols. */
export function chunksAnnVol(returns: number[], window: number): number[] {
  const out: number[] = [];
  for (let i = window; i <= returns.length; i += window) {
    out.push(annVol(returns.slice(i - window, i)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drift lean (pre-print trend gate) — pure
// ---------------------------------------------------------------------------

export interface DriftLean {
  lean: 'long' | 'short' | 'mixed';
  signals: string[];
}

/** Pre-print drift lean from the 5d + 20d price trend into the event. */
export function computeDriftLean(drift5: number, drift20: number): DriftLean {
  if (drift20 > 5 && drift5 > 2) {
    return { lean: 'long', signals: [`20d +${drift20.toFixed(1)}%`, `5d +${drift5.toFixed(1)}%`] };
  }
  if (drift20 < -5 && drift5 < -2) {
    return { lean: 'short', signals: [`20d ${drift20.toFixed(1)}%`, `5d ${drift5.toFixed(1)}%`] };
  }
  return { lean: 'mixed', signals: [] };
}

// ---------------------------------------------------------------------------
// Classification — pure (mirrors scan-earnings.ts L410-476)
// ---------------------------------------------------------------------------

export interface EarningsClassifyInput {
  /** true when the report date is in the PAST relative to the evaluation
   *  date (PEAD / reversal window); false = pre-print (vol / drift). */
  postPrint: boolean;
  /** Most recent print's surprise %, or null when unresolved. */
  surprise: number | null;
  /** Most recent print's announcement-anchored T-1→T+1 reaction %, or null. */
  lastMove: number | null;
  /** Recent volume vs 20d average. */
  volRatio: number;
  /** Realized-vol rank 0-100. */
  rvRank: number;
  /** Mean absolute prior reaction, or null when no resolved history. */
  avgPriorMove: number | null;
  /** Event-window (2-trading-day) expected move %. */
  expectedMove: number;
  /** 20d pre-print drift %. */
  drift20: number;
  /** Pre-print drift lean (from computeDriftLean). */
  driftLean: 'long' | 'short' | 'mixed';
}

export interface EarningsClassification {
  playType: EarningsPlayType;
  bias: EarningsSetup['bias'];
  strategy: string;
  direction: 'long' | 'short' | undefined;
}

export function classifyEarnings(input: EarningsClassifyInput): EarningsClassification {
  const { postPrint, surprise, lastMove, volRatio, rvRank, avgPriorMove, expectedMove, drift20, driftLean } = input;

  let playType: EarningsPlayType = 'skip';
  let bias: EarningsSetup['bias'] = 'neutral';
  let strategy = 'Wait';
  let direction: 'long' | 'short' | undefined;

  if (postPrint) {
    if (surprise !== null && lastMove !== null && volRatio > 1.3) {
      if (surprise > 5 && lastMove > 3) {
        playType = 'pead_long'; bias = 'buy_premium'; strategy = 'PEAD Long (continuation)'; direction = 'long';
      } else if (surprise < -5 && lastMove < -3) {
        playType = 'pead_short'; bias = 'buy_premium'; strategy = 'PEAD Short (continuation)'; direction = 'short';
      } else if (Math.abs(lastMove) > 5 && volRatio > 1.5 && Math.sign(lastMove) !== Math.sign(surprise)) {
        playType = 'reversal'; bias = 'buy_premium';
        direction = lastMove > 0 ? 'short' : 'long';
        strategy = direction === 'short'
          ? 'Earnings Reversal (fade the gap-up, short side)'
          : 'Earnings Reversal (fade the gap-down, long side)';
      }
    }
  } else {
    const rvLow = rvRank <= 35;
    const rvRich = rvRank >= 65;
    const movesBig = (avgPriorMove ?? 0) > expectedMove * 1.15;
    const movesContained = avgPriorMove !== null && avgPriorMove < expectedMove * 0.85;

    if (rvLow && movesBig) {
      playType = 'long_volatility'; bias = 'buy_premium'; strategy = 'Long Straddle (RV rank low, history of big moves)';
    } else if (rvRich && movesContained) {
      playType = 'short_volatility'; bias = 'sell_premium'; strategy = 'Iron Condor (RV rank high, history of contained moves)';
    } else if (driftLean === 'long' && drift20 > 8) {
      playType = 'directional_long'; bias = 'buy_premium'; strategy = 'Directional Long (pre-earnings drift)'; direction = 'long';
    } else if (driftLean === 'short' && drift20 < -8) {
      playType = 'directional_short'; bias = 'buy_premium'; strategy = 'Directional Short (pre-earnings weakness)'; direction = 'short';
    } else {
      playType = 'skip'; bias = 'neutral'; strategy = 'Skip the event (mixed data)';
    }
  }

  return { playType, bias, strategy, direction };
}

// ---------------------------------------------------------------------------
// Composite score — pure (mirrors scan-earnings.ts L479-492)
// ---------------------------------------------------------------------------
//
// ⚠️ FIX-2 W3 REPLACES THIS FUNCTION. The 70/75/65/35 constants are
// hand-typed and have never been validated out-of-sample — that is the
// whole reason FIX-2 exists. After the PEAD event study lands, surviving
// playTypes are scored monotonic in their MEASURED bucket edge and
// non-surviving playTypes are pinned <=40 + labelled "unvalidated". Until
// then this preserves the exact pre-FIX-2 behaviour so no scoring moves
// before it is earned. MODEL_VERSION bumps in the W3 commit, not here.

export interface EarningsScoreInput {
  rvRank: number;
  drift20: number;
  /** history[0].surprisePct ?? 0 in the live path. */
  surprisePct: number;
  /** |daysUntil| <= 1 && !postPrint applies a −5 imminent-uncertainty haircut. */
  daysUntil: number;
  postPrint: boolean;
}

export function scoreEarningsComposite(
  playType: EarningsPlayType,
  input: EarningsScoreInput,
): number {
  const { rvRank, drift20, surprisePct, daysUntil, postPrint } = input;

  let composite = 50;
  if (playType === 'short_volatility') composite = 75 + Math.min(15, Math.round((rvRank - 65) / 2));
  else if (playType === 'long_volatility') composite = 75 + Math.min(15, Math.round((35 - rvRank) / 2));
  else if (playType === 'directional_long' || playType === 'directional_short') {
    composite = 65 + Math.min(20, Math.round(Math.abs(drift20) / 2));
  } else if (playType === 'pead_long' || playType === 'pead_short') {
    composite = 70 + Math.min(20, Math.round(Math.abs(surprisePct)));
  } else if (playType === 'reversal') composite = 65;
  else composite = 35; // skip

  if (Math.abs(daysUntil) <= 1 && !postPrint) composite -= 5;
  return Math.max(0, Math.min(100, composite));
}
