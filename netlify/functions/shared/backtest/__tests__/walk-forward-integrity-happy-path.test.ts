// Walk-forward integrity test — happy-path (P0).
//
// Part of the W11 integrity suite per the Phase 4a hotfix brief.
// This is in a separate file from walk-forward-integrity.test.ts because
// it relies on vitest module-level mocks (vi.mock hoists to the top of
// the file) and we want to keep the other integrity tests' mock state
// clean.
//
// What this catches that the original W11 suite missed:
//
//   The Phase 4a smoke test produced an all-zeros backtest — NAV held
//   at $100k for 7 years, 0 trades, 0 attribution. Root cause: every
//   ticker scoring attempt threw a Firestore-undefined error from the
//   cache write, the engine's silent catch{} swallowed it, every
//   portfolio was empty, NAV never moved. The run looked clean.
//
//   The pre-existing integrity tests only verified PIT correctness,
//   determinism, clock-leak audits, and survivorship stamping. None
//   of them actually called runBacktest end-to-end against working
//   inputs to verify trades.length > 0.
//
//   With the hotfix in place (or without the bug), this test passes.
//   Without the hotfix, this test catches it at PR time instead of
//   after a 13-minute smoke test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock data-provider's getDailyBars so the engine's benchmark + position
// marking fetches return synthetic upward-drifting bars. Hoisted to the
// top of the file by vitest.
vi.mock('../../data-provider', async () => {
  const actual = await vi.importActual<typeof import('../../data-provider')>(
    '../../data-provider',
  );
  return {
    ...actual,
    getDailyBars: vi.fn(async (_ticker: string, from: string, to: string) => {
      // Generate one synthetic bar per calendar day in [from, to], drifting
      // upward at 0.05% per day so the portfolio shows a positive return.
      const start = new Date(`${from}T12:00:00Z`).getTime();
      const end = new Date(`${to}T12:00:00Z`).getTime();
      const bars: Array<{
        t: number;
        o: number;
        h: number;
        l: number;
        c: number;
        v: number;
      }> = [];
      let price = 100;
      for (let t = start; t <= end; t += 86400000) {
        const d = new Date(t);
        const dow = d.getUTCDay();
        if (dow === 0 || dow === 6) continue; // weekends
        price *= 1.0005; // +5bps/day
        bars.push({ t, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1_000_000 });
      }
      return bars;
    }),
  };
});

// Mock scoreTickerAtDate to return a sane composite for every ticker —
// the whole point: realistic inputs to the engine, asserting it produces
// non-trivial output.
vi.mock('../score-at-date', async () => {
  const actual = await vi.importActual<typeof import('../score-at-date')>(
    '../score-at-date',
  );
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
      // Deterministic, well-above-minComposite score so candidates pass
      // the filter. Slight variance via ticker hash so picks are stable
      // but not all identical.
      const hash = ticker
        .split('')
        .reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 1000, 0);
      return {
        ticker,
        composite: 60 + (hash % 20), // 60..79 range, comfortably above 50
        layers: { fundamental: 65, momentum: 55, technical: 70 },
        sector: 'Tech',
        metadata: { ticker, asOfDate },
      };
    }),
  };
});

// Import AFTER mocks are declared so the hoisted vi.mock takes effect.
import { runBacktest } from '../engine';
import { __setDbForTesting } from '../../pit-cache';
import { __setBacktestDbForTesting } from '../persistence';
import type { BacktestConfig } from '../types';

// Minimal Firestore fake — same pattern as the existing integrity test.
function makeTaggedFakeDb() {
  const store = new Map<string, Record<string, unknown>>();
  type Ref = {
    id: string;
    __path: string;
    get(): Promise<{
      exists: boolean;
      data: () => Record<string, unknown> | undefined;
    }>;
    set(value: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void>;
    collection(name: string): Col;
  };
  type Col = { doc(id: string): Ref };

  function docRef(path: string): Ref {
    return {
      id: path.split('/').pop()!,
      __path: path,
      async get() {
        return {
          exists: store.has(path),
          data: () => store.get(path),
        };
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
      return refs.map((r) => ({
        exists: store.has(r.__path),
        data: () => store.get(r.__path),
      }));
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
    __store: store,
  };
}

describe('walk-forward integrity (happy-path P0)', () => {
  beforeEach(() => {
    const fakeDb = makeTaggedFakeDb();
    __setDbForTesting(fakeDb as never);
    __setBacktestDbForTesting(fakeDb as never);
  });

  afterEach(() => {
    __setDbForTesting(null);
    __setBacktestDbForTesting(null);
  });

  it('produces non-trivial output for a sane backtest config', async () => {
    const config: BacktestConfig = {
      universe: 'dow',
      startDate: '2023-01-01',
      endDate: '2023-06-30',
      rebalanceFrequency: 'monthly',
      board: 'prophet',
      portfolio: {
        topN: 5,
        weighting: 'equal',
        maxPositionPct: 0.25,
        maxSectorPct: 1.0, // Tech-heavy mock; ignore sector cap
        cashSleeve: 0.05,
        minComposite: 50,
      },
      costs: {
        slippageBps: { dow: 3, sp500: 5, ndx: 5, russell2k: 20 },
        commission: 0,
      },
      initialCapital: 100_000,
    };

    const result = await runBacktest(config);

    // The whole point of this test: against realistic mocked scores,
    // the engine MUST produce trades. Empty portfolio = silent failure.
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.metrics.rebalanceCount).toBeGreaterThan(0);
    expect(result.perAnalystAttribution.length).toBeGreaterThan(0);

    // NAV should have moved — synthetic bars drift up, so the curve
    // should end above $100k.
    const finalEquity = result.dailyEquity[result.dailyEquity.length - 1];
    expect(finalEquity.value).not.toBe(100_000);
    expect(finalEquity.value).toBeGreaterThan(100_000);

    // Hotfix sanity: no high-failure-rate warning when scoring works.
    expect(
      result.warnings.find((w) => w.includes('HIGH FAILURE RATE')),
    ).toBeUndefined();
    expect(result.tickerFailures.failureRatePct).toBeLessThan(50);
  });

  it('surfaces HIGH FAILURE RATE warning when scoring throws for everyone', async () => {
    // Override the mock for this test to throw — simulates the original
    // bug (Firestore undefined-rejection bubbling out of every score
    // call). The hotfix path must surface this as a warning instead of
    // silently producing an all-zeros result.
    const { scoreTickerAtDate } = await import('../score-at-date');
    vi.mocked(scoreTickerAtDate).mockImplementation(async () => {
      throw new Error(
        'Value for argument "data" is not a valid Firestore document. ' +
          'Cannot use "undefined" as a Firestore value (synthetic test)',
      );
    });

    const config: BacktestConfig = {
      universe: 'dow',
      startDate: '2023-01-01',
      endDate: '2023-06-30',
      rebalanceFrequency: 'monthly',
      board: 'prophet',
      portfolio: {
        topN: 5,
        weighting: 'equal',
        maxPositionPct: 0.25,
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

    const result = await runBacktest(config);

    expect(result.trades.length).toBe(0);
    expect(result.tickerFailures.total).toBeGreaterThan(0);
    expect(result.tickerFailures.failureRatePct).toBeGreaterThanOrEqual(50);
    expect(
      result.warnings.find((w) => w.includes('HIGH FAILURE RATE')),
    ).toBeDefined();
    expect(result.tickerFailures.sample.length).toBeGreaterThan(0);
    expect(result.tickerFailures.sample[0].message).toContain('undefined');
  });
});
