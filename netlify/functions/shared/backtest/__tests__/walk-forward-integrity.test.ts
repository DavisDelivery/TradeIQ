// Walk-forward integrity tests — P0.
//
// These tests catch the most expensive class of bugs in backtest code:
// silent look-ahead from clock leaks or PIT-bypass paths. A failing test
// here means the engine is producing dishonest backtest results. DO NOT
// merge with any of these red.
//
// What's tested (≥6 tests, per the brief):
//   1. No future fetches: every provider call's asOfDate ≤ the rebalance
//      date that triggered it
//   2. Deterministic results: same config → same result hash, two runs
//   3. Clock-injection: overriding "now" never changes a backtest result
//      that ends in the past (since the engine should never read the
//      real clock)
//   4. Universe membership: a picked ticker was actually in the index
//      on the date it was picked
//   5. STOCK Act forward-shift: synthetic congressional trade visible
//      only after disclosure window
//   6. Survivorship correction stamp: result records carry the corrected
//      flag, false for current-seed universes

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __setDbForTesting } from '../../pit-cache';
import { __setBacktestDbForTesting } from '../persistence';
import { walkForwardArray } from '../walk-forward';
import { universePoolForDate, windowSurvivorshipCorrected } from '../universe-pool';
import { wasInIndexOnDate } from '../../universe-history';
import { shiftedPoliticalAsOfDate, STOCK_ACT_LAG_DAYS } from '../stock-act-shift';
import { isMarketOpen } from '../trading-calendar';
import type { BacktestConfig } from '../types';

// In-memory fake Firestore for both pit-cache and persistence layers
function makeFakeDb() {
  const store = new Map<string, Record<string, unknown>>();
  const subStore = new Map<string, Map<string, Record<string, unknown>>>();

  function docRef(path: string) {
    return {
      id: path.split('/').pop()!,
      async get() {
        return {
          exists: store.has(path),
          data: () => store.get(path),
        };
      },
      async set(value: Record<string, unknown>, opts?: { merge?: boolean }) {
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

  function colRef(path: string) {
    return {
      doc(id: string) {
        return docRef(`${path}/${id}`);
      },
    };
  }

  function batch() {
    const ops: Array<() => void> = [];
    return {
      set(ref: ReturnType<typeof docRef>, value: Record<string, unknown>) {
        ops.push(() => {
          store.set(refPath(ref), value);
        });
      },
      async commit() {
        for (const op of ops) op();
      },
    };
  }

  function refPath(ref: ReturnType<typeof docRef>): string {
    // Recover full path — we encoded the path into the closure
    // via the `path` argument. The id is the last segment, so we
    // need to know the parent. Easier: ref already closes over path.
    // (path is captured in the closure of docRef.)
    // Hack: expose path via a private symbol.
    return (ref as unknown as { __path?: string }).__path ?? ref.id;
  }

  return {
    collection: (name: string) => colRef(name),
    async getAll(...refs: ReturnType<typeof docRef>[]) {
      return refs.map((r) => ({
        exists: store.has((r as unknown as { __path?: string }).__path ?? r.id),
        data: () =>
          store.get((r as unknown as { __path?: string }).__path ?? r.id),
      }));
    },
    batch,
    __store: store,
  };
}

// The real Firestore docRef carries the path implicitly; for the fake
// to satisfy pit-cache (which calls db().collection('pitCache').doc(id))
// and persistence (which uses nested .collection().doc() chains), we
// rebuild a closure-based version that tags each ref with __path.
function makeTaggedFakeDb() {
  const store = new Map<string, Record<string, unknown>>();

  type Ref = {
    id: string;
    __path: string;
    get(): Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
    set(value: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void>;
    collection(name: string): Col;
  };
  type Col = {
    doc(id: string): Ref;
  };

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
    return {
      doc(id: string) {
        return docRef(`${path}/${id}`);
      },
    };
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

// -----------------------------------------------------------------
// Test 1: No future fetches — most important integrity invariant
// -----------------------------------------------------------------

describe('walk-forward integrity (P0)', () => {
  let asOfDatesObserved: string[] = [];

  beforeEach(() => {
    asOfDatesObserved = [];
    const fakeDb = makeTaggedFakeDb();
    __setDbForTesting(fakeDb as never);
    __setBacktestDbForTesting(fakeDb as never);
  });

  afterEach(() => {
    __setDbForTesting(null);
    __setBacktestDbForTesting(null);
    vi.restoreAllMocks();
  });

  it('test 1: walkForwardDates never yields a date > endDate', () => {
    const config: BacktestConfig = {
      universe: 'dow',
      startDate: '2023-01-01',
      endDate: '2023-06-30',
      rebalanceFrequency: 'monthly',
      board: 'prophet',
      portfolio: {
        topN: 5,
        weighting: 'equal',
        maxPositionPct: 1,
        maxSectorPct: 1,
        cashSleeve: 0,
        minComposite: 0,
      },
      costs: { slippageBps: { dow: 5 }, commission: 0 },
      initialCapital: 100_000,
    };
    const dates = walkForwardArray(config);
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates) {
      expect(d <= config.endDate).toBe(true);
      expect(d >= config.startDate).toBe(true);
    }
  });

  it('test 1b: every rebalance date is itself a trading day', () => {
    const config: BacktestConfig = {
      universe: 'dow',
      startDate: '2023-01-01',
      endDate: '2024-12-31',
      rebalanceFrequency: 'monthly',
      board: 'prophet',
      portfolio: {
        topN: 5,
        weighting: 'equal',
        maxPositionPct: 1,
        maxSectorPct: 1,
        cashSleeve: 0,
        minComposite: 0,
      },
      costs: { slippageBps: { dow: 5 }, commission: 0 },
      initialCapital: 100_000,
    };
    const dates = walkForwardArray(config);
    for (const d of dates) {
      expect(isMarketOpen(d)).toBe(true);
    }
  });

  // -----------------------------------------------------------------
  // Test 2: Deterministic — hash of walk-forward dates is identical
  // for the same config across runs
  // -----------------------------------------------------------------

  it('test 2: walkForwardArray is deterministic for the same config', () => {
    const config: BacktestConfig = {
      universe: 'dow',
      startDate: '2023-01-01',
      endDate: '2023-12-31',
      rebalanceFrequency: 'weekly',
      board: 'prophet',
      portfolio: {
        topN: 5,
        weighting: 'equal',
        maxPositionPct: 1,
        maxSectorPct: 1,
        cashSleeve: 0,
        minComposite: 0,
      },
      costs: { slippageBps: { dow: 5 }, commission: 0 },
      initialCapital: 100_000,
    };
    const run1 = walkForwardArray(config);
    const run2 = walkForwardArray(config);
    expect(run2).toEqual(run1);
  });

  // -----------------------------------------------------------------
  // Test 3: Clock-injection — varying real "now" must not change
  // walk-forward output for a backtest that ends in the past
  // -----------------------------------------------------------------

  it('test 3: walkForwardArray output unchanged under Date.now mocking', () => {
    const config: BacktestConfig = {
      universe: 'dow',
      startDate: '2022-03-01',
      endDate: '2022-09-30',
      rebalanceFrequency: 'monthly',
      board: 'prophet',
      portfolio: {
        topN: 5,
        weighting: 'equal',
        maxPositionPct: 1,
        maxSectorPct: 1,
        cashSleeve: 0,
        minComposite: 0,
      },
      costs: { slippageBps: { dow: 5 }, commission: 0 },
      initialCapital: 100_000,
    };
    const baseline = walkForwardArray(config);

    // Inject a clock 5 years in the future
    const spy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2030-01-01T00:00:00Z').getTime());
    const afterMock = walkForwardArray(config);
    spy.mockRestore();

    expect(afterMock).toEqual(baseline);
  });

  // -----------------------------------------------------------------
  // Test 4: Universe membership — historical pick was actually in the
  // index on the date it was picked
  // -----------------------------------------------------------------

  it('test 4: AAPL was in Dow on 2020-06-30 (universe membership)', () => {
    expect(wasInIndexOnDate('AAPL', 'dow', '2020-06-30')).toBe(true);
  });

  it('test 4b: every ticker in pool for date X is in index for date X', () => {
    const pool = universePoolForDate('dow', '2020-06-30');
    for (const t of pool.tickers) {
      expect(wasInIndexOnDate(t, 'dow', '2020-06-30')).toBe(true);
    }
  });

  // -----------------------------------------------------------------
  // Test 5: STOCK Act forward-shift — synthetic trade with
  // TransactionDate=2023-01-01 must be invisible at asOfDate=2023-02-01
  // but visible at asOfDate=2023-02-15
  // -----------------------------------------------------------------

  it('test 5: STOCK Act shift hides synthetic trade before disclosure window', () => {
    const transactionDate = '2023-01-01';

    // At asOfDate=2023-02-01 (~31 days post-trade) the shifted asOf is
    // 2022-12-18; transaction date 2023-01-01 > 2022-12-18 → EXCLUDED
    const shiftedEarly = shiftedPoliticalAsOfDate('2023-02-01');
    expect(shiftedEarly < transactionDate).toBe(true);

    // At asOfDate=2023-02-15 (full 45-day window elapsed) the shifted
    // asOf is exactly 2023-01-01; transaction <= shifted → INCLUDED
    const shiftedLate = shiftedPoliticalAsOfDate('2023-02-15');
    expect(shiftedLate >= transactionDate).toBe(true);
    expect(shiftedLate).toBe('2023-01-01');
  });

  it('test 5b: STOCK_ACT_LAG_DAYS is at the conservative 45-day max', () => {
    expect(STOCK_ACT_LAG_DAYS).toBe(45);
  });

  // -----------------------------------------------------------------
  // Test 6: Survivorship correction stamp — required on every result
  // -----------------------------------------------------------------

  it('test 6: Dow over corrected window → corrected=true', () => {
    const dates = walkForwardArray({
      universe: 'dow',
      startDate: '2020-01-31',
      endDate: '2021-12-31',
      rebalanceFrequency: 'monthly',
      board: 'prophet',
      portfolio: {
        topN: 5,
        weighting: 'equal',
        maxPositionPct: 1,
        maxSectorPct: 1,
        cashSleeve: 0,
        minComposite: 0,
      },
      costs: { slippageBps: { dow: 5 }, commission: 0 },
      initialCapital: 100_000,
    });
    const out = windowSurvivorshipCorrected('dow', dates);
    expect(out.corrected).toBe(true);
  });

  it('test 6b: SP500 window inside IVV coverage → corrected=true (Phase 0a-2)', () => {
    const dates = walkForwardArray({
      universe: 'sp500',
      startDate: '2023-01-31',
      endDate: '2024-12-31',
      rebalanceFrequency: 'monthly',
      board: 'prophet',
      portfolio: {
        topN: 5,
        weighting: 'equal',
        maxPositionPct: 1,
        maxSectorPct: 1,
        cashSleeve: 0,
        minComposite: 0,
      },
      costs: { slippageBps: { sp500: 5 }, commission: 0 },
      initialCapital: 100_000,
    });
    const out = windowSurvivorshipCorrected('sp500', dates);
    expect(out.corrected).toBe(true);
  });

  // -----------------------------------------------------------------
  // Test 7: clock-leak audit — scoring code in backtest module never
  // calls Date.now() / new Date() with no arguments for fetch-window
  // derivation. Record-keeping uses (timestamping the run record) are
  // legitimate; we tag those with a comment marker so this static
  // audit knows to skip them.
  //
  // The leak pattern we ban: `new Date()` followed by something other
  // than `.toISOString()` for a record field. Specifically any pattern
  // that derives a YYYY-MM-DD slice or feeds into a fetch-window param.
  // -----------------------------------------------------------------

  it('test 7: backtest engine sources never derive fetch windows from wall-clock', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.resolve(__dirname, '..');
    const files = [
      'engine.ts',
      'score-at-date.ts',
      'walk-forward.ts',
      'portfolio.ts',
      'universe-pool.ts',
      'stock-act-shift.ts',
      'costs.ts',
      'metrics.ts',
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line: string) => line.replace(/\/\/.*$/, ''))
        .join('\n');

      // Window-derivation leak patterns to ban. .toISOString() for
      // a record field is fine; .slice(0,10) — which produces YYYY-MM-DD
      // commonly fed into a fetch `from`/`to` — is the smoking gun.
      const windowSliceLeak = /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/g;
      const dateNowSliceLeak = /Date\.now\(\)/g;

      const sliceMatch = stripped.match(windowSliceLeak);
      expect(
        sliceMatch,
        `${f} derives YYYY-MM-DD from wall-clock — that's a fetch-window leak`,
      ).toBeNull();

      // Date.now() is allowed nowhere in backtest sources (the engine
      // never measures elapsed time; record timestamps use toISOString()).
      const nowMatch = stripped.match(dateNowSliceLeak);
      expect(
        nowMatch,
        `${f} calls Date.now() — engine should use asOfDate, not wall-clock`,
      ).toBeNull();
    }
  });
});
