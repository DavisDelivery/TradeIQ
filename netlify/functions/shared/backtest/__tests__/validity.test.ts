// FIX-1 W2 — regression tests for the run-validity guard, pinned on the
// bt_20260519233423_avaa64 failure mode: a "target"-board run whose every
// candidate scored null (84× "no PIT scoring path" warnings) COMPLETED
// with official metrics (+80.6% vs SPY, IC −0.0148). A board with no PIT
// path / an all-null candidate stream must yield status 'invalid' with
// NO metrics — never a numbers-bearing result.

import { describe, it, expect } from 'vitest';
import {
  assessRunValidity,
  InvalidBacktestRunError,
  INVALID_NULL_RATE,
  NO_PIT_PATH_WARNING_FRAGMENT,
} from '../validity';
import { finalizeRegularBacktest, type RegularBacktestState } from '../engine-batched';
import type { BacktestConfig } from '../types';

const baseConfig = { board: 'target', discreteSignalOnly: false } as Pick<
  BacktestConfig,
  'board' | 'discreteSignalOnly'
>;

describe('assessRunValidity', () => {
  it('avaa64 failure mode: no-PIT-path warning ⇒ invalid, regardless of counters', () => {
    const d = assessRunValidity({
      tickerAttemptTotal: 42000,
      scoredCandidateTotal: 0,
      tickerFailureTotal: 0,
      warnings: [
        `Board "target" ${NO_PIT_PATH_WARNING_FRAGMENT}; ` +
          `prophet/williams/lynch are the supported boards. All candidates null.`,
      ],
      config: baseConfig,
    });
    expect(d.valid).toBe(false);
    expect(d.reason).toMatch(/no PIT scoring path/);
  });

  it('all-null candidate stream ⇒ invalid even without the warning', () => {
    const d = assessRunValidity({
      tickerAttemptTotal: 1000,
      scoredCandidateTotal: 0,
      tickerFailureTotal: 0,
      warnings: [],
      config: baseConfig,
    });
    expect(d.valid).toBe(false);
    expect(d.nullRatePct).toBe(100);
    expect(d.reason).toMatch(/returned null/);
  });

  it('exactly at the 90% null threshold ⇒ invalid', () => {
    const d = assessRunValidity({
      tickerAttemptTotal: 1000,
      scoredCandidateTotal: Math.round(1000 * (1 - INVALID_NULL_RATE)),
      tickerFailureTotal: 0,
      warnings: [],
      config: baseConfig,
    });
    expect(d.valid).toBe(false);
  });

  it('below the threshold (89% null) ⇒ valid', () => {
    const d = assessRunValidity({
      tickerAttemptTotal: 1000,
      scoredCandidateTotal: 110,
      tickerFailureTotal: 0,
      warnings: [],
      config: baseConfig,
    });
    expect(d.valid).toBe(true);
    expect(d.nullRatePct).toBe(89);
  });

  it('discreteSignalOnly carve-out: null IS the signal semantics, 99% null stays valid', () => {
    const d = assessRunValidity({
      tickerAttemptTotal: 10000,
      scoredCandidateTotal: 100,
      tickerFailureTotal: 0,
      warnings: [],
      config: { board: 'lynch', discreteSignalOnly: true } as typeof baseConfig,
    });
    expect(d.valid).toBe(true);
  });

  it('…but the no-PIT-path rule still applies to discrete runs', () => {
    const d = assessRunValidity({
      tickerAttemptTotal: 10000,
      scoredCandidateTotal: 100,
      tickerFailureTotal: 0,
      warnings: [`Board "catalyst" ${NO_PIT_PATH_WARNING_FRAGMENT}; all null.`],
      config: { board: 'catalyst', discreteSignalOnly: true } as typeof baseConfig,
    });
    expect(d.valid).toBe(false);
  });

  // FIX-2 W1 — the earnings board is event-anchored: most tickers have no
  // setup on a given monthly date, so it runs with discreteSignalOnly and
  // a high null rate is the EXPECTED no-trade semantics, NOT missing data.
  it('earnings (discreteSignalOnly): high null rate stays valid (no-setup = no-trade)', () => {
    const d = assessRunValidity({
      tickerAttemptTotal: 10000,
      scoredCandidateTotal: 700, // ~93% null — most tickers have no event near D
      tickerFailureTotal: 0,
      warnings: [],
      config: { board: 'earnings', discreteSignalOnly: true } as typeof baseConfig,
    });
    expect(d.valid).toBe(true);
  });

  it('earnings: a no-PIT-path warning would STILL invalidate (guard is board-agnostic)', () => {
    const d = assessRunValidity({
      tickerAttemptTotal: 10000,
      scoredCandidateTotal: 0,
      tickerFailureTotal: 0,
      warnings: [`Board "earnings" ${NO_PIT_PATH_WARNING_FRAGMENT}; all null.`],
      config: { board: 'earnings', discreteSignalOnly: true } as typeof baseConfig,
    });
    expect(d.valid).toBe(false);
  });

  it('thrown failures are NOT nulls: an all-throw run stays in the HIGH-FAILURE-RATE lane (valid here)', () => {
    const d = assessRunValidity({
      tickerAttemptTotal: 1000,
      scoredCandidateTotal: 0,
      tickerFailureTotal: 1000,
      warnings: [],
      config: baseConfig,
    });
    expect(d.valid).toBe(true);
  });

  it('zero attempts ⇒ valid by this rule (nothing to assess; other guards own empty runs)', () => {
    const d = assessRunValidity({
      tickerAttemptTotal: 0,
      scoredCandidateTotal: 0,
      tickerFailureTotal: 0,
      warnings: [],
      config: baseConfig,
    });
    expect(d.valid).toBe(true);
  });
});

describe('finalizeRegularBacktest — invalid runs never reach metrics', () => {
  function makeState(overrides: Partial<RegularBacktestState> = {}): RegularBacktestState {
    return {
      nextRebalanceIdx: 84,
      totalRebalances: 84,
      portfolio: [],
      nav: 100000,
      tickerFailureSample: [],
      tickerFailureTotal: 0,
      tickerAttemptTotal: 42000,
      mlTrainingRowCount: 0,
      dailyEquityRowCount: 0,
      tradeRowCount: 0,
      attributionRowCount: 0,
      warningRowCount: 0,
      survivorshipWarned: false,
      scoredCandidateTotal: 0,
      ...overrides,
    };
  }

  function finalizeArgs(state: RegularBacktestState, warnings: string[]) {
    return {
      config: {
        board: 'target',
        universe: 'sp500',
        startDate: '2018-01-31',
        endDate: '2024-12-31',
        initialCapital: 100000,
        discreteSignalOnly: false,
      } as unknown as BacktestConfig,
      runId: 'bt_test_invalid',
      state,
      allMlRows: [],
      allDailyEquity: [],
      allTrades: [],
      allAttribution: [],
      allWarnings: warnings,
      benchBars: [],
      benchTicker: 'SPY',
      rebalanceDates: ['2018-01-31'],
      survivorship: { corrected: false, coverageThrough: null } as any,
    };
  }

  it('throws InvalidBacktestRunError on an all-null run (no metrics object ever built)', () => {
    expect(() => finalizeRegularBacktest(finalizeArgs(makeState(), []))).toThrowError(
      InvalidBacktestRunError,
    );
  });

  it('throws on the no-PIT-path warning even when the null counter is unavailable (pre-FIX-1 cursor)', () => {
    const state = makeState({ scoredCandidateTotal: undefined });
    expect(() =>
      finalizeRegularBacktest(
        finalizeArgs(state, [
          `Board "target" ${NO_PIT_PATH_WARNING_FRAGMENT}; prophet/williams/lynch are the supported boards. All candidates null.`,
        ]),
      ),
    ).toThrowError(InvalidBacktestRunError);
  });

  it('a healthy run (low null rate) finalizes with metrics', () => {
    const state = makeState({ scoredCandidateTotal: 40000 });
    const result = finalizeRegularBacktest(finalizeArgs(state, []));
    expect(result.metrics).toBeDefined();
    expect(result.runId).toBe('bt_test_invalid');
  });
});
