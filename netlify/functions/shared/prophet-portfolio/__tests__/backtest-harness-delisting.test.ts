// Wave 3B (track-3 M3) — delisting/halt realization in the portfolio
// harness.
//
// Pre-fix, `markEquityAt` fell back to `px ?? p.currentPrice`: a position
// whose price source stopped returning bars was marked at its frozen last
// close FOREVER — a bankruptcy read as a flat hold, no warning, and the
// dead name occupied a book slot until the end of the window.
//
// Post-fix, a position with no bar for MORE than
// FORCED_LIQUIDATION_GAP_TRADING_DAYS consecutive mark dates is
// force-liquidated at its last traded close (with the configured
// slippage — a forced sell still crosses the spread), removed from the
// book, and a warning is surfaced per occurrence.
//
// The scenario prices the crash BEFORE the disappearance (200 → 80 →
// missing) so the realized loss is visible in equity: the run ends with
// the -60% MSFT loss locked in as cash, strictly below the frozen
// flat-hold-at-entry reading, and below the pre-fix curve by exactly the
// forced-exit slippage.
//
// Fail-on-pre-fix verified: with `px ?? p.currentPrice` semantics and no
// sweep restored, "force-liquidates" fails (no warning, equity does not
// take the forced-exit slippage, position never leaves the book).

import { describe, expect, it } from 'vitest';
import {
  FORCED_LIQUIDATION_GAP_TRADING_DAYS,
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
  startDate: '2024-01-02',
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

// 25 weekday mark dates, 2024-01-02 .. 2024-02-05 (weekends skipped;
// synthetic calendar — the harness takes markDates as given).
function weekdayMarks(startISO: string, count: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${startISO}T12:00:00Z`);
  while (out.length < count) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

const MARKS = weekdayMarks('2024-01-02', 25);

/**
 * Price source where MSFT trades 200 on entry, crashes to 80 by
 * `lastTradeDate`, then returns NO bar at all afterwards (delisting).
 * Unlike the carry-forward priceMap in the sibling tests, this models
 * what a real bounded-lookback source does once the lookback window
 * slides past the final print: closeAt → null.
 */
function delistingPrices(lastTradeDate: string): PriceSource {
  return {
    async closeAt(ticker, date) {
      if (ticker === 'AAPL') return 100; // flat throughout
      if (ticker !== 'MSFT') return null;
      if (date > lastTradeDate) return null; // delisted — no bar, ever
      if (date >= '2024-01-08') return 80; // crashed
      return 200;
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

const LAST_TRADE = '2024-01-09';
const WINDOW: BacktestWindow = {
  label: 'delisting',
  start: MARKS[0],
  end: MARKS[MARKS.length - 1],
  rebalanceDates: [MARKS[0]],
  markDates: MARKS,
};
const SIGNAL = fixedSignal({
  [MARKS[0]]: [cand('AAPL', 90), cand('MSFT', 85)],
});

describe('runPortfolioBacktest — delisted holding is force-liquidated', () => {
  it('force-liquidates after the gap, warns, and realizes the loss in equity', async () => {
    const result = await runPortfolioBacktest({
      config: CONFIG,
      window: WINDOW,
      signal: SIGNAL,
      prices: delistingPrices(LAST_TRADE),
    });

    // Exactly one forced-liquidation warning, naming the dead ticker.
    const liqWarnings = result.warnings.filter((w) => /forced liquidation/.test(w));
    expect(liqWarnings).toHaveLength(1);
    expect(liqWarnings[0]).toContain('MSFT');
    expect(liqWarnings[0]).toContain('80'); // last traded close

    // Liquidation fires on the (GAP+1)-th consecutive missing mark.
    const missingMarks = MARKS.filter((d) => d > LAST_TRADE);
    const liqDate = missingMarks[FORCED_LIQUIDATION_GAP_TRADING_DAYS]; // index GAP = streak GAP+1
    expect(liqWarnings[0].startsWith(`${liqDate}:`)).toBe(true);

    // Equity realizes the crash: ~50k AAPL (flat) + MSFT proceeds at 80
    // on shares bought at ~200 → final equity far below the frozen
    // flat-hold-at-entry reading (~100k), and the curve takes the
    // forced-exit slippage on the liquidation date.
    const final = result.equityCurve[result.equityCurve.length - 1].portfolio;
    expect(final).toBeLessThan(72_000); // -60% on half the book, realized
    expect(final).toBeGreaterThan(68_000);

    const idx = result.equityCurve.findIndex((p) => p.date === liqDate);
    expect(idx).toBeGreaterThan(0);
    const before = result.equityCurve[idx - 1].portfolio;
    const at = result.equityCurve[idx].portfolio;
    // MSFT was already marked at 80 (frozen) pre-liquidation, so the
    // only equity delta on the liquidation date is the forced-exit
    // slippage (10 bps on the liquidated notional). AAPL is worth
    // 50,000 / 100.1 shares × 100 ≈ 49,950.05 — the rest of `before`
    // is the MSFT notional being liquidated.
    const aaplValue = (50_000 / 100.1) * 100;
    const msftNotional = before - aaplValue;
    const slippageTaken = before - at;
    expect(slippageTaken).toBeGreaterThan(0);
    expect(slippageTaken).toBeCloseTo(msftNotional * (CONFIG.slippageBps / 10_000), 6);

    // After liquidation the equity stays flat (cash + flat AAPL): the
    // dead position no longer occupies the book.
    const after = result.equityCurve.slice(idx).map((p) => p.portfolio);
    for (const v of after) expect(v).toBeCloseTo(at, 6);

    // The forced exit lands in completedHolds (avgHoldDays > 0) but is
    // NOT a swap event (swapCount counts rebalance swaps only).
    expect(result.avgHoldDays).toBeGreaterThan(0);
    expect(result.swapCount).toBe(1);
  });

  it('does NOT liquidate for a short halt (gap <= threshold) — stale-mark fallback holds', async () => {
    // MSFT goes missing for exactly GAP marks, then trades again at 80.
    const missingMarks = MARKS.filter((d) => d > LAST_TRADE);
    const resumeDate = missingMarks[FORCED_LIQUIDATION_GAP_TRADING_DAYS - 1];
    const prices: PriceSource = {
      async closeAt(ticker, date) {
        if (ticker === 'AAPL') return 100;
        if (ticker !== 'MSFT') return null;
        if (date >= resumeDate) return 80; // halt lifted
        if (date > LAST_TRADE) return null; // halted
        if (date >= '2024-01-08') return 80;
        return 200;
      },
    };
    const result = await runPortfolioBacktest({
      config: CONFIG,
      window: WINDOW,
      signal: SIGNAL,
      prices,
    });
    expect(result.warnings.filter((w) => /forced liquidation/.test(w))).toHaveLength(0);
    // Position still on the book at the end, marked at the resumed price.
    const final = result.equityCurve[result.equityCurve.length - 1].portfolio;
    expect(final).toBeGreaterThan(68_000);
  });
});

describe('processPortfolioBatch — delisting equivalence with unbatched harness', () => {
  it('streaks survive batch boundaries: chained batches reproduce the unbatched result', async () => {
    // Rebalance every 5 marks so batchSize=1 forces checkpoints in the
    // MIDDLE of the missing-bar streak — the cursor-carried
    // missingBarStreaks field is what keeps the gap counting.
    const window: BacktestWindow = {
      ...WINDOW,
      rebalanceDates: [MARKS[0], MARKS[5], MARKS[10], MARKS[15], MARKS[20]],
    };
    const picks = Object.fromEntries(
      window.rebalanceDates.map((d) => [d, [cand('AAPL', 90), cand('MSFT', 85)]]),
    );

    const unbatched = await runPortfolioBacktest({
      config: CONFIG,
      window,
      signal: fixedSignal(picks),
      prices: delistingPrices(LAST_TRADE),
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
        window,
        signal: fixedSignal(picks),
        prices: delistingPrices(LAST_TRADE),
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
      window,
      allEquityCurve,
      allSwaps,
      allCompletedHolds,
      allWarnings,
    });

    // Same liquidation, same date, same realized numbers.
    expect(allWarnings).toEqual(unbatched.warnings);
    expect(allWarnings.filter((w) => /forced liquidation/.test(w))).toHaveLength(1);
    expect(batched.equityCurve).toEqual(unbatched.equityCurve);
    expect(batched.portfolioReturnPct).toBeCloseTo(unbatched.portfolioReturnPct, 6);
    expect(batched.costDragPct).toBeCloseTo(unbatched.costDragPct, 6);
    expect(batched.avgHoldDays).toBeCloseTo(unbatched.avgHoldDays, 6);
  });
});
