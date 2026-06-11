// Wave 3B (track-3 M3) — delisting/halt realization in the regular engine.
//
// Pre-fix, a held ticker with no bars (delisted mid-segment) contributed
// `rets.find(...)?.ret ?? 0` — a silent 0% daily return — so its weight
// rode the book as a flat hold until the next rebalance, where it
// "exited" via a phantom SELL trade priced at its stale last close (and
// paid slippage on a transaction that could never have happened). No
// warning anywhere.
//
// Post-fix, a position with no daily bar for MORE than
// FORCED_LIQUIDATION_GAP_TRADING_DAYS consecutive trading days is
// treated as a forced liquidation: a warning is surfaced per occurrence
// and the position is removed from the carried portfolio, so the next
// rebalance books NO phantom sell against the stale close. Both engine
// variants must behave identically (equivalence contract).
//
// Fail-on-pre-fix verified: with the `?? 0` flat-ride restored, the
// warning assertion fails and the phantom BBB sell trade reappears.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// BBB prints its last bar on this date, then disappears (delisting).
// Early enough in the first monthly segment (2023-01-03 → 2023-02-02)
// that the missing-bar streak crosses the 10-trading-day gap BEFORE the
// next rebalance: missing trading days run 01-11, 01-12, 01-13, 01-17
// (01-16 is MLK), …, 01-25 (streak 10), 01-26 (streak 11 → liquidate).
const BBB_LAST_BAR = '2023-01-10';

vi.mock('../../data-provider', async () => {
  const actual = await vi.importActual<typeof import('../../data-provider')>(
    '../../data-provider',
  );
  return {
    ...actual,
    getDailyBars: vi.fn(async (ticker: string, from: string, to: string) => {
      const start = new Date(`${from}T12:00:00Z`).getTime();
      const end = new Date(`${to}T12:00:00Z`).getTime();
      const bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> = [];
      let price = 100;
      for (let t = start; t <= end; t += 86400000) {
        const d = new Date(t);
        const dow = d.getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const iso = d.toISOString().slice(0, 10);
        if (ticker === 'BBB' && iso > BBB_LAST_BAR) continue; // delisted
        price *= 1.0005;
        bars.push({ t, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1_000_000 });
      }
      return bars;
    }),
  };
});

vi.mock('../universe-pool', async () => {
  const actual = await vi.importActual<typeof import('../universe-pool')>('../universe-pool');
  return {
    ...actual,
    universePoolForDate: vi.fn(() => ({
      tickers: ['AAA', 'BBB', 'CCC'],
      snapshotDate: '2023-01-01',
      survivorshipCorrected: true,
    })),
    windowSurvivorshipCorrected: vi.fn(() => ({
      corrected: true,
      coverageThrough: '2026-01-01',
    })),
  };
});

vi.mock('../score-at-date', async () => {
  const actual = await vi.importActual<typeof import('../score-at-date')>('../score-at-date');
  return {
    ...actual,
    buildMarketContextAtDate: vi.fn(async (asOfDate: string) => ({
      asOfDate,
      spyBars: [],
      sectorEtfCache: {},
      sectorRank: {},
      regime: null,
      macroBias: 0,
    })),
    scoreTickerAtDate: vi.fn(async (ticker: string, asOfDate: string) => {
      // After the delisting, BBB can no longer be scored (no bars) —
      // it drops out of the target naturally at the next rebalance.
      if (ticker === 'BBB' && asOfDate > BBB_LAST_BAR) return null;
      const base: Record<string, number> = { AAA: 80, BBB: 75, CCC: 70 };
      return {
        ticker,
        composite: base[ticker] ?? 60,
        layers: { fundamental: 65, momentum: 55, technical: 70 },
        sector: 'Tech',
        metadata: { ticker, asOfDate },
      };
    }),
  };
});

import { runBacktest } from '../engine';
import {
  finalizeRegularBacktest,
  initialRegularState,
  prepRun,
  processRegularBatch,
} from '../engine-batched';
import { __setDbForTesting } from '../../pit-cache';
import { __setBacktestDbForTesting } from '../persistence';
import { walkForwardArray } from '../walk-forward';
import type { BacktestConfig, MLTrainingRow } from '../types';

function makeFakeDb() {
  const store = new Map<string, Record<string, unknown>>();
  type Ref = {
    id: string;
    __path: string;
    get(): Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
    set(value: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void>;
    collection(name: string): Col;
  };
  type Col = { doc(id: string): Ref };
  function docRef(path: string): Ref {
    return {
      id: path.split('/').pop()!,
      __path: path,
      async get() {
        return { exists: store.has(path), data: () => store.get(path) };
      },
      async set(value, opts) {
        if (opts?.merge && store.has(path)) {
          store.set(path, { ...store.get(path)!, ...value });
        } else {
          store.set(path, value);
        }
      },
      collection(name: string) {
        return colRef(`${path}/${name}`);
      },
    };
  }
  function colRef(path: string): Col {
    return { doc: (id: string) => docRef(`${path}/${id}`) };
  }
  return {
    collection: colRef,
    async getAll(...refs: Ref[]) {
      return refs.map((r) => ({ exists: store.has(r.__path), data: () => store.get(r.__path) }));
    },
    batch() {
      const ops: Array<() => void> = [];
      return {
        set(ref: Ref, value: Record<string, unknown>) {
          ops.push(() => store.set(ref.__path, value));
        },
        async commit() {
          for (const op of ops) op();
        },
      };
    },
  };
}

// Monthly cadence: each segment spans ~21 trading days, so BBB's
// missing-bar streak crosses FORCED_LIQUIDATION_GAP_TRADING_DAYS (10)
// well before the next rebalance — the pre-fix free ride this fixes.
const CONFIG: BacktestConfig = {
  universe: 'dow',
  startDate: '2023-01-02',
  endDate: '2023-03-15',
  rebalanceFrequency: 'monthly',
  board: 'prophet',
  portfolio: {
    topN: 3,
    weighting: 'equal',
    maxPositionPct: 0.5,
    maxSectorPct: 1.0,
    cashSleeve: 0.05,
    minComposite: 50,
  },
  costs: {
    slippageBps: { dow: 3, sp500: 5, ndx: 5, russell2k: 20 },
    commission: 0,
  },
  initialCapital: 100_000,
};

describe('engine — delisted ticker is force-liquidated (Wave 3B M3)', () => {
  beforeEach(() => {
    const fakeDb = makeFakeDb();
    __setDbForTesting(fakeDb as never);
    __setBacktestDbForTesting(fakeDb as never);
  });

  afterEach(() => {
    __setDbForTesting(null);
    __setBacktestDbForTesting(null);
  });

  it('warns once, and books NO phantom sell for the dead ticker at the next rebalance', async () => {
    const result = await runBacktest(CONFIG, { noPersist: true });

    // BBB was bought at the first rebalance…
    const bbbBuys = result.trades.filter((t) => t.ticker === 'BBB' && t.side === 'buy');
    expect(bbbBuys.length).toBeGreaterThan(0);

    // …then disappeared mid-segment → exactly one forced-liquidation
    // warning (pre-fix: silent flat ride, zero warnings).
    const liqWarnings = result.warnings.filter(
      (w) => /forced liquidation/.test(w) && w.includes('BBB'),
    );
    expect(liqWarnings).toHaveLength(1);
    // Fires only after the gap: the 11th consecutive missing trading
    // day past the 2023-01-10 last bar is 2023-01-26.
    const warnDate = liqWarnings[0].slice(0, 10);
    expect(warnDate).toBe('2023-01-26');

    // The position was REMOVED from the carried book, so the next
    // rebalance's diff books no sell at the stale close (pre-fix it
    // emitted a phantom BBB sell trade priced at the last bar).
    const bbbSells = result.trades.filter((t) => t.ticker === 'BBB' && t.side === 'sell');
    expect(bbbSells).toHaveLength(0);
  });

  it('batched engine produces the identical warning + trade set (equivalence)', async () => {
    const unbatched = await runBacktest(CONFIG, { noPersist: true });

    const rebalanceDates = walkForwardArray(CONFIG);
    let state = initialRegularState(CONFIG, rebalanceDates.length, rebalanceDates[0]);
    const allMlRows: MLTrainingRow[] = [];
    const allDailyEquity: typeof unbatched.dailyEquity = [];
    const allTrades: typeof unbatched.trades = [];
    const allAttribution: typeof unbatched.perAnalystAttribution = [];
    const allWarnings: string[] = [];

    let done = false;
    let safety = 0;
    while (!done) {
      const res = await processRegularBatch({
        config: CONFIG,
        runId: unbatched.runId,
        state,
        batchSize: 1, // checkpoint at every rebalance — streaks cross batches
      });
      state = res.state;
      done = res.done;
      allMlRows.push(...res.batchMlRows);
      allDailyEquity.push(...res.batchDailyEquity);
      allTrades.push(...res.batchTrades);
      allAttribution.push(...res.batchAttribution);
      allWarnings.push(...res.batchWarnings);
      if (safety++ > 100) throw new Error('runaway loop');
    }

    const prep = await prepRun(CONFIG);
    const batched = finalizeRegularBacktest({
      config: CONFIG,
      runId: unbatched.runId,
      state,
      allMlRows,
      allDailyEquity,
      allTrades,
      allAttribution,
      allWarnings,
      benchBars: prep.benchBars,
      benchTicker: prep.benchTicker,
      rebalanceDates: prep.rebalanceDates,
      survivorship: prep.survivorship,
    });

    expect(
      batched.warnings.filter((w) => /forced liquidation/.test(w) && w.includes('BBB')),
    ).toHaveLength(1);
    expect(batched.warnings).toEqual(unbatched.warnings);
    expect(batched.trades).toEqual(unbatched.trades);
    const f1 = batched.dailyEquity[batched.dailyEquity.length - 1].value;
    const f2 = unbatched.dailyEquity[unbatched.dailyEquity.length - 1].value;
    expect(f1).toBeCloseTo(f2, 6);
  });
});
