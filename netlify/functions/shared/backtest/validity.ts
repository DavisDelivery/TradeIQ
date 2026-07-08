// FIX-1 W2 — run-validity guard for the backtest engine.
//
// Why this exists: run bt_20260519233423_avaa64 (the ONLY composite
// "target"-board backtest ever fired) warned 84 times that the board
// had NO PIT scoring path — every candidate scored null on every
// rebalance — and the engine still computed and persisted OFFICIAL
// metrics (+80.6% "total return" vs SPY, an IC, a Sharpe). Those
// numbers measured an empty portfolio drifting on costs, not the
// composite. An invalid run rendering official metrics is the worst
// honesty bug in the app: it manufactures evidence.
//
// The guard: BEFORE metrics are computed, the run is assessed. It is
// INVALID — status 'invalid', NO metrics computed or persisted — when
// either:
//   1. the no-PIT-path warning fired (the scored board has no
//      point-in-time scoring path), or
//   2. ≥ 90% of ticker scoring attempts returned null (the engine was
//      measuring nothing for ≥ 90% of its observations).
//
// Carve-out: `discreteSignalOnly` runs (Williams/Lynch BUY-only) are
// exempt from rule 2 — there, null IS the signal semantics ("no BUY
// today"), not missing data; a signal that rarely fires is a valid
// (usually damning) measurement. Rule 1 applies to every run.

import type { BacktestConfig } from './types';

/** Null-fraction at or above which a non-discrete run is invalid. */
export const INVALID_NULL_RATE = 0.9;

/** Substring of the engine's no-PIT-path warning (engine.ts /
 *  engine-batched.ts push the same text). */
export const NO_PIT_PATH_WARNING_FRAGMENT = 'has no PIT scoring path';

/** Thrown when a run is assessed invalid. Callers persist status
 *  'invalid' (persistRunInvalid) instead of 'failed' and MUST NOT
 *  compute or persist metrics. */
export class InvalidBacktestRunError extends Error {
  readonly isInvalidBacktestRun = true;
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidBacktestRunError';
  }
}

export interface RunValidityInput {
  /** Total per-ticker scoring attempts across all rebalances. */
  tickerAttemptTotal: number;
  /** Attempts that produced a ScoredCandidate (non-null, non-throw). */
  scoredCandidateTotal: number;
  /** Attempts that THREW. Excluded from the null-rate denominator —
   *  thrown failures are the HIGH-FAILURE-RATE warning's jurisdiction
   *  (engine keeps its existing >50% loud-warning contract); this guard
   *  owns silent nulls (the scorer ran fine and measured nothing). */
  tickerFailureTotal: number;
  /** All warnings accumulated so far (checked for the no-PIT-path text). */
  warnings: string[];
  /** The run's config — `discreteSignalOnly` gates the null-rate rule. */
  config: Pick<BacktestConfig, 'board' | 'discreteSignalOnly'>;
}

export interface RunValidityDecision {
  valid: boolean;
  reason?: string;
  nullRatePct?: number;
}

export function assessRunValidity(input: RunValidityInput): RunValidityDecision {
  const { tickerAttemptTotal, scoredCandidateTotal, tickerFailureTotal, warnings, config } = input;

  const noPitPath = warnings.some((w) => w.includes(NO_PIT_PATH_WARNING_FRAGMENT));
  if (noPitPath) {
    return {
      valid: false,
      reason:
        `board "${config.board}" has no PIT scoring path — every candidate scored null; ` +
        `metrics would measure an empty portfolio, not the board (avaa64 failure mode)`,
    };
  }

  const nonThrowAttempts = Math.max(0, tickerAttemptTotal - tickerFailureTotal);
  if (nonThrowAttempts > 0 && config.discreteSignalOnly !== true) {
    const nullCount = Math.max(0, nonThrowAttempts - scoredCandidateTotal);
    const nullRate = nullCount / nonThrowAttempts;
    const nullRatePct = +(nullRate * 100).toFixed(1);
    if (nullRate >= INVALID_NULL_RATE) {
      return {
        valid: false,
        nullRatePct,
        reason:
          `${nullRatePct}% of ticker scoring attempts returned null ` +
          `(${nullCount}/${nonThrowAttempts} non-throwing attempts); a run scoring ` +
          `<10% of its universe is not a valid measurement of board "${config.board}"`,
      };
    }
    return { valid: true, nullRatePct };
  }

  return { valid: true };
}
