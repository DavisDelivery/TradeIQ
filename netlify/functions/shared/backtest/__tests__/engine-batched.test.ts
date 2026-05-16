// Phase 4e-1-infra — batched-engine equivalence + checkpoint mechanics.
//
// Pins three contracts the bg-function depends on:
//
//   1. Chained batches across the full schedule produce the same numeric
//      result as the unbatched runBacktest. Equivalent portfolios →
//      equivalent trades → equivalent metrics.
//   2. Stopping rules: rebalancesProcessed never exceeds batchSize; the
//      cursor lands cleanly on a rebalance boundary; done flips exactly
//      when nextRebalanceIdx == totalRebalances.
//   3. Survivorship warnings fire ONCE across a chain, not once per
//      batch — the sticky survivorshipWarned flag survives state hops.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../data-provider', async () => {
  const actual = await vi.importActual<typeof import('../../data-provider')>(
    '../../data-provider',
  );
  return {
    ...actual,
    getDailyBars: vi.fn(async (_ticker: string, from: string, to: string) => {
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
        if (dow === 0 || dow === 6) continue;
        price *= 1.0005;
        bars.push({ t, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1_000_000 });
      }
      return bars;
    }),
  };
});

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
      const hash = ticker
        .split('')
        .reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 1000, 0);
      return {
        ticker,
        composite: 60 + (hash % 20),
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
import { __setBacktestDbForTesting, appendMLTrainingRows } from '../persistence';
import type { BacktestConfig, MLTrainingRow } from '../types';
import { walkForwardArray } from '../walk-forward';

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

const CONFIG: BacktestConfig = {
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

describe('engine-batched — equivalence with unbatched runBacktest', () => {
  beforeEach(() => {
    const fakeDb = makeTaggedFakeDb();
    __setDbForTesting(fakeDb as never);
    __setBacktestDbForTesting(fakeDb as never);
  });

  afterEach(() => {
    __setDbForTesting(null);
    __setBacktestDbForTesting(null);
  });

  it('chained batches reproduce the unbatched trades + dailyEquity + metrics', async () => {
    const unbatched = await runBacktest(CONFIG, { noPersist: true });

    const rebalanceDates = walkForwardArray(CONFIG);
    let state = initialRegularState(CONFIG, rebalanceDates.length, rebalanceDates[0]);
    const allMlRows: MLTrainingRow[] = [];

    let done = false;
    let safety = 0;
    while (!done) {
      const res = await processRegularBatch({
        config: CONFIG,
        runId: unbatched.runId,
        state,
        batchSize: 1,
      });
      state = res.state;
      done = res.done;
      allMlRows.push(...res.batchMlRows);
      if (safety++ > 100) throw new Error('runaway loop');
    }

    const prep = await prepRun(CONFIG);
    const batched = finalizeRegularBacktest({
      config: CONFIG,
      runId: unbatched.runId,
      state,
      allMlRows,
      benchBars: prep.benchBars,
      benchTicker: prep.benchTicker,
      rebalanceDates: prep.rebalanceDates,
      survivorship: prep.survivorship,
    });

    // Trade counts + arrays must match.
    expect(batched.trades.length).toBe(unbatched.trades.length);
    expect(batched.perAnalystAttribution.length).toBe(unbatched.perAnalystAttribution.length);
    expect(batched.dailyEquity.length).toBe(unbatched.dailyEquity.length);

    // Phase 5a-prep: ml rows are now per-scored-candidate. The batched
    // engine must produce the SAME row set as the unbatched engine —
    // equivalence still holds, just over the larger row set. The dow
    // universe has 30 names and the mock scores every one, so each
    // rebalance emits exactly 30 ml rows.
    const DOW_UNIVERSE_SIZE = 30;
    const scheduleLen = walkForwardArray(CONFIG).length;
    expect(allMlRows.length).toBe(scheduleLen * DOW_UNIVERSE_SIZE);
    const keyOf = (r: MLTrainingRow) => `${r.asOfDate}|${r.ticker}`;
    const batchedKeys = allMlRows.map(keyOf).sort();
    // Per-rebalance: exactly topN (5) rows flagged inPortfolio across each
    // rebalance's 30 candidates.
    const byDate = new Map<string, MLTrainingRow[]>();
    for (const r of allMlRows) {
      const arr = byDate.get(r.asOfDate) ?? [];
      arr.push(r);
      byDate.set(r.asOfDate, arr);
    }
    expect(byDate.size).toBe(scheduleLen);
    for (const [, rows] of byDate) {
      expect(rows.length).toBe(DOW_UNIVERSE_SIZE);
      expect(rows.filter((r) => r.inPortfolio).length).toBe(CONFIG.portfolio.topN);
    }
    expect(new Set(batchedKeys).size).toBe(batchedKeys.length); // no dup (date,ticker)

    // Final NAV closely matches.
    const batchedFinal = batched.dailyEquity[batched.dailyEquity.length - 1].value;
    const unbatchedFinal = unbatched.dailyEquity[unbatched.dailyEquity.length - 1].value;
    expect(batchedFinal).toBeCloseTo(unbatchedFinal, 4);

    // Metrics agree on tradeCount + rebalanceCount.
    expect(batched.metrics.tradeCount).toBe(unbatched.metrics.tradeCount);
    expect(batched.metrics.rebalanceCount).toBe(unbatched.metrics.rebalanceCount);
    expect(batched.metrics.totalReturnPct).toBeCloseTo(
      unbatched.metrics.totalReturnPct,
      4,
    );

    // tickerFailures shape matches (no failures in happy-path mock).
    expect(batched.tickerFailures.total).toBe(unbatched.tickerFailures.total);
    expect(batched.tickerFailures.totalAttempts).toBe(unbatched.tickerFailures.totalAttempts);
  });

  it('single-batch covering the full schedule equals unbatched run', async () => {
    const unbatched = await runBacktest(CONFIG, { noPersist: true });

    const rebalanceDates = walkForwardArray(CONFIG);
    const initial = initialRegularState(CONFIG, rebalanceDates.length, rebalanceDates[0]);
    const res = await processRegularBatch({
      config: CONFIG,
      runId: unbatched.runId,
      state: initial,
      batchSize: 100,
    });
    expect(res.done).toBe(true);

    const prep = await prepRun(CONFIG);
    const batched = finalizeRegularBacktest({
      config: CONFIG,
      runId: unbatched.runId,
      state: res.state,
      allMlRows: res.batchMlRows,
      benchBars: prep.benchBars,
      benchTicker: prep.benchTicker,
      rebalanceDates: prep.rebalanceDates,
      survivorship: prep.survivorship,
    });

    expect(batched.trades.length).toBe(unbatched.trades.length);
    expect(batched.metrics.totalReturnPct).toBeCloseTo(unbatched.metrics.totalReturnPct, 4);
  });

  it('ml rows are batch-invariant: 1-batch run === chained per-rebalance run', async () => {
    // Phase 5a-prep — the equivalence guarantee for the larger per-
    // candidate row set: however the schedule is sliced into batches, the
    // emitted ml rows must be the same set with the same field values.
    const singleBatch = await processRegularBatch({
      config: CONFIG,
      runId: 'bt_ml_equiv',
      state: initialRegularState(
        CONFIG,
        walkForwardArray(CONFIG).length,
        walkForwardArray(CONFIG)[0],
      ),
      batchSize: 100,
    });
    expect(singleBatch.done).toBe(true);

    let state = initialRegularState(
      CONFIG,
      walkForwardArray(CONFIG).length,
      walkForwardArray(CONFIG)[0],
    );
    const chained: MLTrainingRow[] = [];
    let done = false;
    let safety = 0;
    while (!done) {
      const res = await processRegularBatch({
        config: CONFIG,
        runId: 'bt_ml_equiv',
        state,
        batchSize: 1,
      });
      state = res.state;
      done = res.done;
      chained.push(...res.batchMlRows);
      if (safety++ > 100) throw new Error('runaway loop');
    }

    // Same count.
    expect(chained.length).toBe(singleBatch.batchMlRows.length);

    // Same rows, field-for-field, compared via a stable (date,ticker) key
    // so the only difference that could remain is genuine value drift.
    const norm = (rows: MLTrainingRow[]) =>
      new Map(rows.map((r) => [`${r.asOfDate}|${r.ticker}`, r]));
    const single = norm(singleBatch.batchMlRows);
    const multi = norm(chained);
    expect(multi.size).toBe(single.size);
    for (const [key, sRow] of single) {
      const mRow = multi.get(key);
      expect(mRow).toBeDefined();
      expect(mRow).toEqual(sRow);
    }
  });
});

describe('engine-batched — checkpoint mechanics', () => {
  beforeEach(() => {
    const fakeDb = makeTaggedFakeDb();
    __setDbForTesting(fakeDb as never);
    __setBacktestDbForTesting(fakeDb as never);
  });

  afterEach(() => {
    __setDbForTesting(null);
    __setBacktestDbForTesting(null);
  });

  it('respects batchSize: rebalancesProcessed never exceeds it', async () => {
    const rebalanceDates = walkForwardArray(CONFIG);
    const state = initialRegularState(CONFIG, rebalanceDates.length, rebalanceDates[0]);
    const res = await processRegularBatch({
      config: CONFIG,
      runId: 'bt_test',
      state,
      batchSize: 2,
    });
    expect(res.rebalancesProcessed).toBeLessThanOrEqual(2);
    expect(res.state.nextRebalanceIdx).toBeLessThanOrEqual(2);
    expect(res.done).toBe(false);
  });

  it('done flips exactly when nextRebalanceIdx reaches totalRebalances', async () => {
    const rebalanceDates = walkForwardArray(CONFIG);
    const initial = initialRegularState(CONFIG, rebalanceDates.length, rebalanceDates[0]);
    const res = await processRegularBatch({
      config: CONFIG,
      runId: 'bt_test',
      state: initial,
      batchSize: rebalanceDates.length,
    });
    expect(res.done).toBe(true);
    expect(res.state.nextRebalanceIdx).toBe(rebalanceDates.length);
  });

  it('watchdog expiry yields a resumable state mid-schedule', async () => {
    const rebalanceDates = walkForwardArray(CONFIG);
    let calls = 0;
    const state = initialRegularState(CONFIG, rebalanceDates.length, rebalanceDates[0]);
    const res = await processRegularBatch({
      config: CONFIG,
      runId: 'bt_test',
      state,
      batchSize: rebalanceDates.length,
      isExpired: () => ++calls > 1, // expire after the first rebalance
    });
    expect(res.done).toBe(false);
    expect(res.state.nextRebalanceIdx).toBeGreaterThan(0);
    expect(res.state.nextRebalanceIdx).toBeLessThan(rebalanceDates.length);

    // Resume from the returned state — chain completes.
    const tail = await processRegularBatch({
      config: CONFIG,
      runId: 'bt_test',
      state: res.state,
      batchSize: rebalanceDates.length,
    });
    expect(tail.done).toBe(true);
  });

  it('does not mutate the caller-supplied state object', async () => {
    const rebalanceDates = walkForwardArray(CONFIG);
    const state = initialRegularState(CONFIG, rebalanceDates.length, rebalanceDates[0]);
    const stateBefore = JSON.parse(JSON.stringify(state));
    await processRegularBatch({
      config: CONFIG,
      runId: 'bt_test',
      state,
      batchSize: 1,
    });
    expect(state).toEqual(stateBefore);
  });

  it('initialRegularState seeds the equity curve with the first rebalance date + initial capital', () => {
    const s = initialRegularState(CONFIG, 6, '2023-01-03');
    expect(s.dailyEquity).toEqual([{ date: '2023-01-03', value: 100_000 }]);
    expect(s.nav).toBe(100_000);
    expect(s.nextRebalanceIdx).toBe(0);
    expect(s.totalRebalances).toBe(6);
  });
});

// Phase 5a-prep — per-candidate ml-row emission + cursor arithmetic.
describe('engine-batched — Phase 5a-prep per-candidate ml rows', () => {
  // Hold the fake-DB handle so the cursor test can read its __store back.
  let fakeDb: ReturnType<typeof makeTaggedFakeDb>;

  beforeEach(() => {
    fakeDb = makeTaggedFakeDb();
    __setDbForTesting(fakeDb as never);
    __setBacktestDbForTesting(fakeDb as never);
  });

  afterEach(() => {
    __setDbForTesting(null);
    __setBacktestDbForTesting(null);
  });

  it('emits exactly N rows per rebalance (N = scored candidates), M flagged inPortfolio (M = topN)', async () => {
    // The mock scoreTickerAtDate scores every pool ticker, so for the dow
    // universe N = 30 scored candidates per rebalance. buildPortfolio
    // takes topN by composite (all 30 clear minComposite 50), so M = 5.
    const N = 30; // dow universe size
    const M = CONFIG.portfolio.topN; // 5
    const rebalanceDates = walkForwardArray(CONFIG);

    const res = await processRegularBatch({
      config: CONFIG,
      runId: 'bt_nm',
      state: initialRegularState(CONFIG, rebalanceDates.length, rebalanceDates[0]),
      batchSize: 100,
    });
    expect(res.done).toBe(true);

    const byDate = new Map<string, MLTrainingRow[]>();
    for (const r of res.batchMlRows) {
      const arr = byDate.get(r.asOfDate) ?? [];
      arr.push(r);
      byDate.set(r.asOfDate, arr);
    }
    // One bucket per rebalance, each with exactly N rows / M held.
    expect(byDate.size).toBe(rebalanceDates.length);
    for (const [, rows] of byDate) {
      expect(rows.length).toBe(N);
      expect(rows.filter((r) => r.inPortfolio).length).toBe(M);

      // The held set must be exactly the top-M candidates by composite,
      // with ties broken by ticker — mirroring buildPortfolio's sort.
      const expectedHeld = new Set(
        [...rows]
          .sort((a, b) =>
            b.composite !== a.composite
              ? b.composite - a.composite
              : a.ticker.localeCompare(b.ticker),
          )
          .slice(0, M)
          .map((r) => r.ticker),
      );
      const actualHeld = new Set(
        rows.filter((r) => r.inPortfolio).map((r) => r.ticker),
      );
      expect(actualHeld).toEqual(expectedHeld);
    }
  });

  it('cursor arithmetic: 2-batch run writes the same contiguous mlTraining doc ids as a 1-batch run', async () => {
    const rebalanceDates = walkForwardArray(CONFIG);

    // --- 1-batch reference run ---
    const single = await processRegularBatch({
      config: CONFIG,
      runId: 'bt_cursor_single',
      state: initialRegularState(CONFIG, rebalanceDates.length, rebalanceDates[0]),
      batchSize: 100,
    });
    expect(single.done).toBe(true);
    // Production wiring: startIdx is the cumulative count, which begins
    // at 0 for a fresh run.
    await appendMLTrainingRows('bt_cursor_single', single.batchMlRows, 0);

    // --- 2-batch run over the SAME window ---
    const half = Math.ceil(rebalanceDates.length / 2);
    const firstHalf = await processRegularBatch({
      config: CONFIG,
      runId: 'bt_cursor_split',
      state: initialRegularState(CONFIG, rebalanceDates.length, rebalanceDates[0]),
      batchSize: half,
    });
    expect(firstHalf.done).toBe(false);
    // First batch: startIdx 0.
    await appendMLTrainingRows('bt_cursor_split', firstHalf.batchMlRows, 0);
    // The cursor's running count advances by the ACTUAL per-batch row
    // count — not a hardcoded estimate. This is the arithmetic the
    // background function performs (mlTrainingCount += batchMlRows.length).
    const runningCount = firstHalf.batchMlRows.length;
    expect(firstHalf.state.mlTrainingRowCount).toBe(runningCount);

    const secondHalf = await processRegularBatch({
      config: CONFIG,
      runId: 'bt_cursor_split',
      state: firstHalf.state,
      batchSize: half,
    });
    expect(secondHalf.done).toBe(true);
    // Second batch: startIdx is the running count from batch 1.
    await appendMLTrainingRows(
      'bt_cursor_split',
      secondHalf.batchMlRows,
      runningCount,
    );
    expect(secondHalf.state.mlTrainingRowCount).toBe(
      runningCount + secondHalf.batchMlRows.length,
    );

    // Same total row count across the split.
    const splitTotal = firstHalf.batchMlRows.length + secondHalf.batchMlRows.length;
    expect(splitTotal).toBe(single.batchMlRows.length);

    // Inspect the fake-DB store: both runs' mlTraining subcollections must
    // hold identical doc-id sets — contiguous 00000000..N-1, no gaps,
    // no duplicates, no overwrite at the batch seam.
    const store = fakeDb.__store;
    const idsFor = (runId: string) =>
      [...store.keys()]
        .filter((k) => k.startsWith(`backtestRuns/${runId}/mlTraining/`))
        .map((k) => k.split('/').pop()!)
        .sort();

    const singleIds = idsFor('bt_cursor_single');
    const splitIds = idsFor('bt_cursor_split');

    // Same count of docs written.
    expect(splitIds.length).toBe(singleIds.length);
    expect(splitIds.length).toBe(splitTotal);

    // Contiguous 0..N-1 (8-digit padded), no gap / no dup.
    const expectedIds = Array.from({ length: splitTotal }, (_, i) =>
      String(i).padStart(8, '0'),
    ).sort();
    expect(splitIds).toEqual(expectedIds);
    expect(singleIds).toEqual(expectedIds);
    // Doc-id sets are byte-identical between the two batchings.
    expect(splitIds).toEqual(singleIds);
  });
});
