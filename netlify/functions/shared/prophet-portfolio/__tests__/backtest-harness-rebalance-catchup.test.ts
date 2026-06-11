// Wave 3B (track-2 M6) — rebalance/markDates misalignment.
//
// Pre-fix, the harness matched rebalance dates against mark dates with a
// strict `date === rebalanceDates[rebalanceIdx]` and never advanced the
// index on a miss. A single rebalance date absent from markDates (e.g. a
// market holiday produced by a calendar-day rebalance stepper) silently
// disabled EVERY later rebalance — the run degraded to buy-and-hold.
//
// These tests pin the catch-up semantics in BOTH harnesses:
//   1. A rebalance date that is not a mark date fires at the NEXT mark
//      date instead of being dropped.
//   2. All later rebalances still execute.
//   3. Multiple stale rebalance dates collapse into ONE rebalance at the
//      next mark date (at most one rebalance per mark date).
//   4. Batched harness behaves identically (equivalence contract).
//
// Fail-on-pre-fix verified: with the strict-equality matching restored,
// "executes the post-holiday rebalances" fails (no swap at 2024-01-16,
// no swap at 2024-01-22).

import { describe, expect, it } from 'vitest';
import {
  runPortfolioBacktest,
  type BacktestWindow,
  type PriceSource,
} from '../backtest-harness';
import {
  finalizePortfolioBacktest,
  initialPortfolioState,
  processPortfolioBatch,
} from '../backtest-harness-batched';
import type { PortfolioConfig, RankingResult, RankingSignal } from '../types';

const CONFIG: PortfolioConfig = {
  universe: 'largecap',
  startDate: '2024-01-08',
  startCapital: 100_000,
  positionCount: 2,
  minHoldDays: 0,
  maxSwapsPerRebalance: 5,
  sectorCap: 4,
  slippageBps: 10,
  minComposite: 50,
  candidatePool: 5,
  version: 'v1',
};

function priceMap(m: Record<string, Record<string, number>>): PriceSource {
  return {
    async closeAt(ticker, date) {
      const series = m[ticker];
      if (!series) return null;
      const sorted = Object.keys(series).sort();
      let chosen: string | null = null;
      for (const d of sorted) {
        if (d <= date) chosen = d;
        else break;
      }
      return chosen ? series[chosen] : null;
    },
  };
}

function trackingSignal(picksByDate: Record<string, RankingResult[]>): RankingSignal & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    id: 'fixed-signal-test',
    calls,
    async rankAtDate({ asOfDate, topN }) {
      calls.push(asOfDate);
      return (picksByDate[asOfDate] ?? []).slice(0, topN);
    },
  };
}

function cand(ticker: string, composite: number, sector = 'Technology'): RankingResult {
  return {
    ticker,
    name: ticker,
    sector,
    composite,
    layers: { fundamental: { score: composite, pass: true } },
    fundamentalPass: true,
    regime: 'neutral',
    signalId: 'fixed-signal-test',
  };
}

// Trading days around MLK Day 2024 (Mon 2024-01-15 — market closed).
const MARK_DATES = [
  '2024-01-08',
  '2024-01-09',
  '2024-01-10',
  '2024-01-11',
  '2024-01-12',
  // 2024-01-15 is a holiday — NOT a mark date.
  '2024-01-16',
  '2024-01-17',
  '2024-01-18',
  '2024-01-19',
  '2024-01-22',
];

// Calendar-day weekly stepper lands the middle rebalance on the holiday.
const HOLIDAY_WINDOW: BacktestWindow = {
  label: 'holiday-rebalance',
  start: '2024-01-08',
  end: '2024-01-22',
  rebalanceDates: ['2024-01-08', '2024-01-15', '2024-01-22'],
  markDates: MARK_DATES,
};

const FLAT_PRICES = priceMap({
  AAPL: Object.fromEntries(MARK_DATES.map((d) => [d, 100])),
  MSFT: Object.fromEntries(MARK_DATES.map((d) => [d, 200])),
  NVDA: Object.fromEntries(MARK_DATES.map((d) => [d, 500])),
  TSLA: Object.fromEntries(MARK_DATES.map((d) => [d, 250])),
});

// Picks change at the (missed) second rebalance and again at the third.
// The catch-up executes the second rebalance on 2024-01-16 — the first
// mark date after the holiday — so picks are keyed by that date.
const PICKS: Record<string, RankingResult[]> = {
  '2024-01-08': [cand('AAPL', 90), cand('MSFT', 85)],
  '2024-01-16': [cand('AAPL', 90), cand('NVDA', 85)],
  '2024-01-22': [cand('AAPL', 90), cand('TSLA', 85)],
};

describe('runPortfolioBacktest — rebalance date on a holiday (catch-up)', () => {
  it('executes the post-holiday rebalances instead of degrading to buy-and-hold', async () => {
    const signal = trackingSignal(PICKS);
    const result = await runPortfolioBacktest({
      config: CONFIG,
      window: HOLIDAY_WINDOW,
      signal,
      prices: FLAT_PRICES,
    });

    // The missed 2024-01-15 rebalance fires on the next mark (01-16)…
    const catchUp = result.swaps.find((s) => s.asOfDate === '2024-01-16');
    expect(catchUp).toBeDefined();
    expect(catchUp!.out.map((o) => o.ticker)).toContain('MSFT');
    expect(catchUp!.in.map((i) => i.ticker)).toContain('NVDA');

    // …and the THIRD rebalance still executes (pre-fix: the index never
    // advanced past 01-15, so 01-22 was silently skipped too).
    const third = result.swaps.find((s) => s.asOfDate === '2024-01-22');
    expect(third).toBeDefined();
    expect(third!.out.map((o) => o.ticker)).toContain('NVDA');
    expect(third!.in.map((i) => i.ticker)).toContain('TSLA');

    // The signal was consulted exactly once per executed rebalance.
    expect(signal.calls).toEqual(['2024-01-08', '2024-01-16', '2024-01-22']);
  });

  it('collapses multiple stale rebalance dates into ONE rebalance at the next mark', async () => {
    const window: BacktestWindow = {
      ...HOLIDAY_WINDOW,
      // 01-13 (Sat) and 01-14 (Sun) are both stale by the 01-16 mark.
      rebalanceDates: ['2024-01-08', '2024-01-13', '2024-01-14', '2024-01-22'],
    };
    const signal = trackingSignal(PICKS);
    const result = await runPortfolioBacktest({
      config: CONFIG,
      window,
      signal,
      prices: FLAT_PRICES,
    });
    // Exactly one catch-up rebalance on 01-16, not two.
    expect(signal.calls).toEqual(['2024-01-08', '2024-01-16', '2024-01-22']);
    expect(result.swaps.filter((s) => s.asOfDate === '2024-01-16')).toHaveLength(1);
  });
});

describe('processPortfolioBatch — holiday catch-up equivalence with unbatched harness', () => {
  it('chained batches reproduce the unbatched result on the holiday window', async () => {
    const unbatched = await runPortfolioBacktest({
      config: CONFIG,
      window: HOLIDAY_WINDOW,
      signal: trackingSignal(PICKS),
      prices: FLAT_PRICES,
    });

    let state = initialPortfolioState(CONFIG);
    let done = false;
    let safety = 0;
    const allEquityCurve: any[] = [];
    const allSwaps: any[] = [];
    const allCompletedHolds: number[] = [];
    const allWarnings: string[] = [];
    while (!done) {
      const res = await processPortfolioBatch({
        config: CONFIG,
        window: HOLIDAY_WINDOW,
        signal: trackingSignal(PICKS),
        prices: FLAT_PRICES,
        state,
        batchSize: 1,
      });
      state = res.state;
      done = res.done;
      allEquityCurve.push(...res.batchEquityCurve);
      allSwaps.push(...res.batchSwaps);
      allCompletedHolds.push(...res.batchCompletedHolds);
      allWarnings.push(...res.batchWarnings);
      if (safety++ > 100) throw new Error('runaway loop');
    }

    const batched = finalizePortfolioBacktest({
      state,
      config: CONFIG,
      window: HOLIDAY_WINDOW,
      allEquityCurve,
      allSwaps,
      allCompletedHolds,
      allWarnings,
    });

    expect(batched.swaps.map((s: any) => s.asOfDate)).toEqual(
      unbatched.swaps.map((s) => s.asOfDate),
    );
    expect(batched.swaps).toEqual(unbatched.swaps);
    expect(batched.equityCurve).toEqual(unbatched.equityCurve);
    expect(batched.portfolioReturnPct).toBeCloseTo(unbatched.portfolioReturnPct, 6);
    expect(batched.turnoverPct).toBeCloseTo(unbatched.turnoverPct, 6);
  });
});
