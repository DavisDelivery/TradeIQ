// Phase 4e-1 — Backtest harness tests against synthetic fixtures.
//
// Two-rebalance scenario with hand-rolled price paths so we can
// verify the harness:
//   1. asks the signal at each rebalance date
//   2. exits + enters at slippage-adjusted prices
//   3. marks equity through the window
//   4. computes the expected return + cost drag
//
// These tests don't validate the rule's edge against SPY (that would
// require live data); they validate the harness mechanics.

import { describe, expect, it } from 'vitest';
import {
  _internals,
  runPortfolioBacktest,
  type BacktestWindow,
  type PriceSource,
} from '../backtest-harness';
import type {
  PortfolioConfig,
  RankingResult,
  RankingSignal,
} from '../types';

const BASE_CONFIG: PortfolioConfig = {
  universe: 'largecap',
  startDate: '2024-01-08',
  startCapital: 100_000,
  positionCount: 2,
  minHoldDays: 0, // disabled for tests
  maxSwapsPerRebalance: 5,
  sectorCap: 4,
  slippageBps: 10,
  minComposite: 50,
  candidatePool: 5,
  version: 'v1',
};

function priceMap(
  m: Record<string, Record<string, number>>,
): PriceSource {
  return {
    async closeAt(ticker, date) {
      const series = m[ticker];
      if (!series) return null;
      // Find the most recent date ≤ asOfDate
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
      const list = picksByDate[asOfDate] ?? [];
      return list.slice(0, topN);
    },
  };
}

function cand(
  ticker: string,
  composite: number,
  sector = 'Technology',
): RankingResult {
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

describe('_internals math', () => {
  it('dailyReturns produces N-1 returns from N values', () => {
    const rets = _internals.dailyReturns([100, 110, 100]);
    expect(rets).toHaveLength(2);
    expect(rets[0]).toBeCloseTo(0.1, 5);
    expect(rets[1]).toBeCloseTo(-10 / 110, 5);
  });

  it('annualizedSharpe is 0 when returns are constant', () => {
    expect(_internals.annualizedSharpe([0.001, 0.001, 0.001])).toBe(0);
  });

  it('maxDrawdownPct identifies the worst peak-to-trough', () => {
    // 100 → 120 → 90 → 110 — worst DD is (120-90)/120 = 25%
    expect(_internals.maxDrawdownPct([100, 120, 90, 110])).toBeCloseTo(25, 2);
  });

  it('longestUnderwaterDays measures the longest non-recovery stretch', () => {
    // 100, 90, 80, 100, 95, 90, 95, 100 — peak at idx 0, recovered at idx 3,
    // peak at idx 3, never recovered → trailing run 4
    const curve = [100, 90, 80, 100, 95, 90, 95, 100].map((v, i) => ({
      date: `2024-01-${(i + 1).toString().padStart(2, '0')}`,
      value: v,
    }));
    expect(_internals.longestUnderwaterDays(curve)).toBeGreaterThanOrEqual(3);
  });
});

describe('runPortfolioBacktest — single rebalance, flat hold', () => {
  it('buys two equal-weight names, holds flat, returns 0% before costs', async () => {
    const window: BacktestWindow = {
      label: 'flat',
      start: '2024-01-08',
      end: '2024-01-12',
      rebalanceDates: ['2024-01-08'],
      markDates: [
        '2024-01-08',
        '2024-01-09',
        '2024-01-10',
        '2024-01-11',
        '2024-01-12',
      ],
    };
    // AAPL = 100 throughout, MSFT = 200 throughout (flat).
    const prices = priceMap({
      AAPL: {
        '2024-01-08': 100,
        '2024-01-09': 100,
        '2024-01-10': 100,
        '2024-01-11': 100,
        '2024-01-12': 100,
      },
      MSFT: {
        '2024-01-08': 200,
        '2024-01-09': 200,
        '2024-01-10': 200,
        '2024-01-11': 200,
        '2024-01-12': 200,
      },
    });
    const signal = fixedSignal({
      '2024-01-08': [cand('AAPL', 90), cand('MSFT', 85)],
    });
    const result = await runPortfolioBacktest({
      config: BASE_CONFIG,
      window,
      signal,
      prices,
    });
    expect(result.swapCount).toBe(1);
    // Equity ends very close to starting capital minus slippage drag.
    // With 10 bps slippage on 100% of capital: ~0.10% drag.
    const expectedEndValue = 100_000 - 100_000 * 0.001;
    expect(result.equityCurve[result.equityCurve.length - 1].portfolio).toBeCloseTo(
      expectedEndValue,
      0,
    );
    expect(result.costDragPct).toBeCloseTo(0.1, 1);
  });
});

describe('runPortfolioBacktest — price rally generates excess vs SPY', () => {
  it('captures a 20% rally on holdings while SPY stays flat', async () => {
    const dates = [
      '2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12',
    ];
    const prices = priceMap({
      AAPL: {
        '2024-01-08': 100, '2024-01-09': 105, '2024-01-10': 110,
        '2024-01-11': 115, '2024-01-12': 120,
      },
      MSFT: {
        '2024-01-08': 200, '2024-01-09': 210, '2024-01-10': 220,
        '2024-01-11': 230, '2024-01-12': 240,
      },
    });
    const spy = priceMap({
      SPY: Object.fromEntries(dates.map((d) => [d, 500])),
    });
    const qqq = priceMap({
      QQQ: Object.fromEntries(dates.map((d) => [d, 400])),
    });
    const iwf = priceMap({
      IWF: Object.fromEntries(dates.map((d) => [d, 250])),
    });
    const signal = fixedSignal({
      '2024-01-08': [cand('AAPL', 90), cand('MSFT', 85)],
    });
    const result = await runPortfolioBacktest({
      config: BASE_CONFIG,
      window: {
        label: 'rally',
        start: '2024-01-08',
        end: '2024-01-12',
        rebalanceDates: ['2024-01-08'],
        markDates: dates,
      },
      signal,
      prices,
      benchmarks: { spy, qqq, iwf },
    });
    // Both names rallied 20%; portfolio should be up ~20% minus slippage.
    expect(result.portfolioReturnPct).toBeGreaterThan(19);
    expect(result.spyReturnPct).toBe(0);
    expect(result.excessReturnPct).toBeCloseTo(result.portfolioReturnPct, 2);
  });
});

describe('runPortfolioBacktest — multi-rebalance swaps tracked', () => {
  it('records swaps when the signal changes its picks', async () => {
    const dates = [
      '2024-01-08', '2024-01-15', '2024-01-22',
    ];
    const prices = priceMap({
      AAPL: { '2024-01-08': 100, '2024-01-15': 100, '2024-01-22': 100 },
      MSFT: { '2024-01-08': 200, '2024-01-15': 200, '2024-01-22': 200 },
      NVDA: { '2024-01-08': 500, '2024-01-15': 500, '2024-01-22': 500 },
    });
    const signal = fixedSignal({
      '2024-01-08': [cand('AAPL', 90), cand('MSFT', 85)],
      // At second rebalance, MSFT drops out of top-15 entirely.
      '2024-01-15': [cand('AAPL', 90), cand('NVDA', 85)],
      '2024-01-22': [cand('AAPL', 90), cand('NVDA', 85)],
    });
    const result = await runPortfolioBacktest({
      config: BASE_CONFIG,
      window: {
        label: 'swap',
        start: '2024-01-08',
        end: '2024-01-22',
        rebalanceDates: ['2024-01-08', '2024-01-15', '2024-01-22'],
        markDates: dates,
      },
      signal,
      prices,
    });
    expect(result.rebalanceCount).toBe(3);
    // Second rebalance should produce a MSFT-out, NVDA-in swap.
    const mid = result.swaps.find((s) => s.asOfDate === '2024-01-15');
    expect(mid?.out.find((o) => o.ticker === 'MSFT')?.reasonCode).toBe(
      'fell_out_of_top_N',
    );
    expect(mid?.in.find((i) => i.ticker === 'NVDA')).toBeDefined();
  });
});
