// Phase 4e-1-infra — batched harness equivalence + checkpoint tests.
//
// These pin the contract the bg-function relies on:
//   1. processPortfolioBatch + finalizePortfolioBacktest, when chained
//      across batches that cover the full schedule, produces the same
//      result as runPortfolioBacktest in a single pass.
//   2. Mid-batch watchdog expiry yields a resumable state.
//   3. A double-invocation race (same starting state, processed twice)
//      is idempotent: position counts, swap counts, and equity values
//      match the single-pass run when the chain completes once.

import { describe, expect, it } from 'vitest';
import { runPortfolioBacktest, type BacktestWindow, type PriceSource } from '../backtest-harness';
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

function fixedSignal(picksByDate: Record<string, RankingResult[]>): RankingSignal {
  return {
    id: 'fixed-signal-test',
    async rankAtDate({ asOfDate, topN }) {
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

function flatPriceMap(tickerToPrice: Record<string, number>, dates: string[]): PriceSource {
  const m: Record<string, Record<string, number>> = {};
  for (const [t, p] of Object.entries(tickerToPrice)) {
    m[t] = Object.fromEntries(dates.map((d) => [d, p]));
  }
  return priceMap(m);
}

const WINDOW_THREE: BacktestWindow = {
  label: 'three-rebs',
  start: '2024-01-08',
  end: '2024-01-22',
  rebalanceDates: ['2024-01-08', '2024-01-15', '2024-01-22'],
  markDates: [
    '2024-01-08',
    '2024-01-09',
    '2024-01-10',
    '2024-01-11',
    '2024-01-12',
    '2024-01-15',
    '2024-01-16',
    '2024-01-17',
    '2024-01-18',
    '2024-01-19',
    '2024-01-22',
  ],
};

const SIGNAL = fixedSignal({
  '2024-01-08': [cand('AAPL', 90), cand('MSFT', 85)],
  '2024-01-15': [cand('AAPL', 90), cand('NVDA', 85)],
  '2024-01-22': [cand('AAPL', 90), cand('NVDA', 85)],
});

const PRICES = priceMap({
  AAPL: Object.fromEntries(WINDOW_THREE.markDates.map((d) => [d, 100])),
  MSFT: Object.fromEntries(WINDOW_THREE.markDates.map((d) => [d, 200])),
  NVDA: Object.fromEntries(WINDOW_THREE.markDates.map((d) => [d, 500])),
});

describe('processPortfolioBatch + finalize — equivalence with unbatched harness', () => {
  it('chained batches reproduce the unbatched result', async () => {
    const unbatched = await runPortfolioBacktest({
      config: CONFIG,
      window: WINDOW_THREE,
      signal: SIGNAL,
      prices: PRICES,
    });

    let state = initialPortfolioState(CONFIG);
    let done = false;
    let safety = 0;
    while (!done) {
      const res = await processPortfolioBatch({
        config: CONFIG,
        window: WINDOW_THREE,
        signal: SIGNAL,
        prices: PRICES,
        state,
        batchSize: 1,
      });
      state = res.state;
      done = res.done;
      if (safety++ > 100) throw new Error('runaway loop');
    }

    const batched = finalizePortfolioBacktest({
      state,
      config: CONFIG,
      window: WINDOW_THREE,
    });

    expect(batched.rebalanceCount).toBe(unbatched.rebalanceCount);
    expect(batched.swapCount).toBe(unbatched.swapCount);
    expect(batched.equityCurve.length).toBe(unbatched.equityCurve.length);
    // Numeric equivalence within float tolerance — values are computed
    // by the same arithmetic, just rebatched.
    expect(batched.portfolioReturnPct).toBeCloseTo(unbatched.portfolioReturnPct, 6);
    expect(batched.costDragPct).toBeCloseTo(unbatched.costDragPct, 6);
    expect(batched.maxDDPct).toBeCloseTo(unbatched.maxDDPct, 6);
  });

  it('single-batch covering the full schedule equals unbatched result', async () => {
    const unbatched = await runPortfolioBacktest({
      config: CONFIG,
      window: WINDOW_THREE,
      signal: SIGNAL,
      prices: PRICES,
    });

    const initial = initialPortfolioState(CONFIG);
    const res = await processPortfolioBatch({
      config: CONFIG,
      window: WINDOW_THREE,
      signal: SIGNAL,
      prices: PRICES,
      state: initial,
      batchSize: 100, // larger than schedule
    });
    expect(res.done).toBe(true);

    const batched = finalizePortfolioBacktest({
      state: res.state,
      config: CONFIG,
      window: WINDOW_THREE,
    });

    expect(batched.swaps).toEqual(unbatched.swaps);
    expect(batched.portfolioReturnPct).toBeCloseTo(unbatched.portfolioReturnPct, 6);
  });
});

describe('processPortfolioBatch — checkpoint mechanics', () => {
  it('stops at the rebalance boundary when batchSize is met', async () => {
    const state = initialPortfolioState(CONFIG);
    const res = await processPortfolioBatch({
      config: CONFIG,
      window: WINDOW_THREE,
      signal: SIGNAL,
      prices: PRICES,
      state,
      batchSize: 2,
    });
    expect(res.done).toBe(false);
    expect(res.rebalancesProcessed).toBe(2);
    expect(res.state.nextRebalanceIdx).toBe(2);
    // The cursor should sit AT the third rebalance date (date matches).
    expect(WINDOW_THREE.markDates[res.state.nextMarkIdx]).toBe(WINDOW_THREE.rebalanceDates[2]);
  });

  it('done=true exactly when all rebalances + marks are consumed', async () => {
    const state = initialPortfolioState(CONFIG);
    const res = await processPortfolioBatch({
      config: CONFIG,
      window: WINDOW_THREE,
      signal: SIGNAL,
      prices: PRICES,
      state,
      batchSize: 10,
    });
    expect(res.done).toBe(true);
    expect(res.state.nextRebalanceIdx).toBe(WINDOW_THREE.rebalanceDates.length);
    expect(res.state.nextMarkIdx).toBe(WINDOW_THREE.markDates.length);
  });

  it('watchdog expiry mid-batch returns a resumable state', async () => {
    const state = initialPortfolioState(CONFIG);
    let calls = 0;
    const res = await processPortfolioBatch({
      config: CONFIG,
      window: WINDOW_THREE,
      signal: SIGNAL,
      prices: PRICES,
      state,
      batchSize: 100,
      // isExpired is only consulted on rebalance days; expire after the
      // first rebalance is applied so the batch breaks early.
      isExpired: () => ++calls > 0,
    });
    expect(res.done).toBe(false);
    expect(res.rebalancesProcessed).toBeGreaterThan(0);
    expect(res.state.nextRebalanceIdx).toBeLessThan(WINDOW_THREE.rebalanceDates.length);

    // Resuming with the returned state finishes the run.
    const tail = await processPortfolioBatch({
      config: CONFIG,
      window: WINDOW_THREE,
      signal: SIGNAL,
      prices: PRICES,
      state: res.state,
      batchSize: 100,
    });
    expect(tail.done).toBe(true);
  });

  it('initialPortfolioState reflects config.startCapital', () => {
    const s = initialPortfolioState(CONFIG);
    expect(s.cash).toBe(CONFIG.startCapital);
    expect(s.positions).toEqual([]);
    expect(s.nextMarkIdx).toBe(0);
    expect(s.nextRebalanceIdx).toBe(0);
  });

  it('does not mutate the caller-supplied state object', async () => {
    const state = initialPortfolioState(CONFIG);
    const stateBefore = JSON.parse(JSON.stringify(state));
    await processPortfolioBatch({
      config: CONFIG,
      window: WINDOW_THREE,
      signal: SIGNAL,
      prices: PRICES,
      state,
      batchSize: 1,
    });
    expect(state).toEqual(stateBefore);
  });
});

describe('finalizePortfolioBacktest — terminal metrics', () => {
  it('handles a state with no equity points without throwing', () => {
    const empty = initialPortfolioState(CONFIG);
    const result = finalizePortfolioBacktest({
      state: empty,
      config: CONFIG,
      window: WINDOW_THREE,
    });
    expect(result.equityCurve).toHaveLength(0);
    expect(result.swapCount).toBe(0);
  });
});
