// Phase 4e-1 / Wave 3A (CR-5, M9) — mtm tests.
//
// recomputeMarks is pure (state + bar series in, new state + curve point
// out); runMtm is exercised through its dependency seam (mirrors the
// prophet-cron-dispatcher test pattern).
//
// CR-5 evidence: the synthetic 2:1 split scenario below FAILED against
// the pre-fix shares×adjusted-close code with
//   "expected -0.495 to be close to 0.01" (recorded 2026-06-11)
// — i.e. the old marking read the split as a −49.5% day. The chained
// implementation reads it as the true ~+1% day.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import {
  CRON,
  earliestFetchDate,
  recomputeMarks,
  runMtm,
  type MarkBar,
  type MtmDeps,
} from '../scan-prophet-portfolio-mtm';
import type {
  EquityCurvePoint,
  PortfolioState,
} from '../shared/prophet-portfolio/types';

function bar(date: string, close: number): MarkBar {
  return { date, close };
}

const NO_BENCH = { spy: [] as MarkBar[], qqq: [] as MarkBar[], iwf: [] as MarkBar[] };

function makeState(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    universe: 'largecap',
    asOfDate: '2024-01-08',
    cash: 0,
    equity: 100_000,
    positions: [
      {
        ticker: 'AAPL',
        shares: 500,
        entryDate: '2024-01-01',
        entryPrice: 100,
        currentPrice: 100,
        marketValue: 50_000,
        weight: 0.5,
        sector: 'Technology',
        lastMarkDate: '2024-01-08',
      },
      {
        ticker: 'MSFT',
        shares: 250,
        entryDate: '2024-01-01',
        entryPrice: 200,
        currentPrice: 200,
        marketValue: 50_000,
        weight: 0.5,
        sector: 'Technology',
        lastMarkDate: '2024-01-08',
      },
    ],
    lastRebalanceAt: '2024-01-01T21:00:00.000Z',
    updatedAt: '2024-01-08T22:00:00.000Z',
    ...overrides,
  };
}

describe('recomputeMarks — split-safe return chaining (CR-5)', () => {
  it('chains daily returns from same-fetch adjusted closes', () => {
    const bars = new Map<string, MarkBar[]>([
      ['AAPL', [bar('2024-01-08', 100), bar('2024-01-09', 105)]],
      ['MSFT', [bar('2024-01-08', 200), bar('2024-01-09', 210)]],
    ]);
    const res = recomputeMarks(
      makeState(),
      bars,
      { spy: [bar('2024-01-08', 495), bar('2024-01-09', 500)], qqq: [], iwf: [] },
      '2024-01-09T22:00:00.000Z',
    );
    expect(res).not.toBeNull();
    const { newState, curvePoint } = res!;
    expect(newState.equity).toBeCloseTo(105_000, 2);
    expect(newState.positions[0].marketValue).toBeCloseTo(52_500, 2);
    expect(newState.positions[0].currentPrice).toBe(105);
    expect(newState.positions[0].weight).toBeCloseTo(0.5, 4);
    expect(newState.positions[0].lastMarkDate).toBe('2024-01-09');
    expect(curvePoint.equity).toBeCloseTo(105_000, 2);
    expect(curvePoint.dailyReturn).toBeCloseTo(0.05, 4);
    expect(curvePoint.spyClose).toBe(500);
  });

  it('a synthetic 2:1 split has ~0% equity impact (pre-fix code read −49.5%)', () => {
    // AAPL 2:1 split overnight; stock economically +1% on the day.
    // Post-split fetch returns BOTH days in the new adjusted basis:
    // yesterday re-adjusts to 50, today closes 50.5. The persisted
    // shares (500 @ entry) are stale-basis and must not matter.
    const state = makeState({
      positions: [
        {
          ticker: 'AAPL',
          shares: 500,
          entryDate: '2024-01-01',
          entryPrice: 100,
          currentPrice: 100, // pre-split basis from yesterday's mark
          marketValue: 50_000,
          weight: 1,
          sector: 'Technology',
          lastMarkDate: '2024-01-08',
        },
      ],
      cash: 50_000,
    });
    const bars = new Map<string, MarkBar[]>([
      ['AAPL', [bar('2024-01-08', 50), bar('2024-01-09', 50.5)]],
    ]);
    const res = recomputeMarks(state, bars, NO_BENCH, '2024-01-09T22:00:00.000Z');
    expect(res).not.toBeNull();
    const { newState, curvePoint } = res!;
    // 50,000 × (50.5/50) = 50,500 → equity 100,500 (+0.5% on the book).
    expect(newState.positions[0].marketValue).toBeCloseTo(50_500, 2);
    expect(newState.equity).toBeCloseTo(100_500, 2);
    expect(curvePoint.dailyReturn).toBeCloseTo(0.005, 6);
    // NOT the −24.75% the shares×price valuation would produce here
    // (500 × 50.5 + 50,000 cash = 75,250).
    expect(curvePoint.equity).not.toBeLessThan(99_000);
  });

  it('compounds across multi-session gaps in one fetch (cron outage)', () => {
    // lastMarkDate Mon 01-08; cron missed Tue; Wed run fetches all bars.
    const state = makeState({
      positions: [
        {
          ...makeState().positions[0],
          lastMarkDate: '2024-01-08',
          marketValue: 50_000,
        },
      ],
      cash: 0,
      equity: 50_000,
    });
    const bars = new Map<string, MarkBar[]>([
      ['AAPL', [bar('2024-01-08', 100), bar('2024-01-09', 102), bar('2024-01-10', 104.04)]],
    ]);
    const res = recomputeMarks(state, bars, NO_BENCH, '2024-01-10T22:00:00.000Z');
    expect(res!.newState.positions[0].marketValue).toBeCloseTo(50_000 * 1.0404, 2);
    expect(res!.newState.positions[0].lastMarkDate).toBe('2024-01-10');
  });

  it('migrates pre-Wave-3A positions (no lastMarkDate) by seeding from shares×price at asOfDate', () => {
    const state = makeState({
      positions: [
        {
          ticker: 'AAPL',
          shares: 500,
          entryDate: '2024-01-01',
          entryPrice: 100,
          currentPrice: 100,
          marketValue: 50_000, // legacy shares×price mark as of asOfDate
          weight: 1,
          sector: 'Technology',
          // no lastMarkDate — old persisted shape
        },
      ],
      asOfDate: '2024-01-08',
      cash: 0,
      equity: 50_000,
    });
    const bars = new Map<string, MarkBar[]>([
      ['AAPL', [bar('2024-01-08', 100), bar('2024-01-09', 101)]],
    ]);
    const res = recomputeMarks(state, bars, NO_BENCH, '2024-01-09T22:00:00.000Z');
    expect(res!.newState.positions[0].marketValue).toBeCloseTo(50_500, 2);
    expect(res!.newState.positions[0].lastMarkDate).toBe('2024-01-09');
    expect(res!.curvePoint.dailyReturn).toBeCloseTo(0.01, 6);
  });

  it('holds value stale (with warning) when a ticker has no usable bars', () => {
    const state = makeState();
    const bars = new Map<string, MarkBar[]>([
      ['AAPL', [bar('2024-01-08', 100), bar('2024-01-09', 105)]],
      ['MSFT', []], // provider failure
    ]);
    const res = recomputeMarks(state, bars, NO_BENCH, '2024-01-09T22:00:00.000Z');
    const { newState, warnings } = res!;
    expect(newState.positions[1].marketValue).toBeCloseTo(50_000, 2); // unchanged
    expect(newState.positions[1].currentPrice).toBe(200); // unchanged
    expect(warnings.some((w) => w.includes('MSFT'))).toBe(true);
    expect(newState.equity).toBeCloseTo(102_500, 2);
  });

  it('derives the curve-point date from the BAR date, not the wall clock (M9)', () => {
    // Cron runs Friday night but the latest settled bar is Friday's;
    // nowIso (wall clock) is already Saturday UTC.
    const bars = new Map<string, MarkBar[]>([
      ['AAPL', [bar('2024-01-08', 100), bar('2024-01-12', 110)]],
      ['MSFT', [bar('2024-01-08', 200), bar('2024-01-12', 220)]],
    ]);
    const res = recomputeMarks(
      makeState(),
      bars,
      { spy: [bar('2024-01-12', 500)], qqq: [], iwf: [] },
      '2024-01-13T00:30:00.000Z',
    );
    expect(res!.curvePoint.date).toBe('2024-01-12');
    expect(res!.newState.asOfDate).toBe('2024-01-12');
  });

  it('returns null when there are no bars at all', () => {
    const res = recomputeMarks(
      makeState(),
      new Map(),
      NO_BENCH,
      '2024-01-09T22:00:00.000Z',
    );
    expect(res).toBeNull();
  });

  it('handles 0-equity edge case without NaN', () => {
    const state = makeState({
      cash: 0,
      equity: 0,
      positions: [
        {
          ...makeState().positions[0],
          shares: 0,
          marketValue: 0,
          weight: 0,
        },
      ],
    });
    const bars = new Map<string, MarkBar[]>([
      ['AAPL', [bar('2024-01-08', 100), bar('2024-01-09', 101)]],
    ]);
    const res = recomputeMarks(state, bars, NO_BENCH, '2024-01-09T22:00:00.000Z');
    expect(res!.newState.equity).toBe(0);
    expect(res!.newState.positions[0].weight).toBe(0);
    expect(res!.curvePoint.dailyReturn).toBe(0);
  });
});

describe('earliestFetchDate', () => {
  it('reaches back past the oldest chain base with buffer', () => {
    const state = makeState({
      positions: [{ ...makeState().positions[0], lastMarkDate: '2023-12-20' }],
    });
    // 2023-12-20 − 7d = 2023-12-13
    expect(earliestFetchDate(state, '2024-01-09')).toBe('2023-12-13');
  });

  it('fetches at least the 14-day minimum window when state is fresh', () => {
    // base 2024-01-08 − 7d = 01-01, but the 14-day floor (2023-12-26)
    // is earlier and wins — benchmarks always get a usable series.
    expect(earliestFetchDate(makeState(), '2024-01-09')).toBe('2023-12-26');
  });
});

// --- runMtm via the dependency seam (M9 discipline) --------------------------

function makeDeps(overrides: Partial<MtmDeps>): {
  deps: MtmDeps;
  writes: { state: PortfolioState[]; points: EquityCurvePoint[] };
} {
  const writes = { state: [] as PortfolioState[], points: [] as EquityCurvePoint[] };
  const barsByTicker: Record<string, MarkBar[]> = {
    AAPL: [bar('2024-01-08', 100), bar('2024-01-09', 105)],
    MSFT: [bar('2024-01-08', 200), bar('2024-01-09', 210)],
    SPY: [bar('2024-01-08', 495), bar('2024-01-09', 500)],
    QQQ: [bar('2024-01-09', 400)],
    IWF: [bar('2024-01-09', 250)],
  };
  const deps: MtmDeps = {
    now: () => new Date('2024-01-09T22:00:05.000Z'), // a Tuesday
    marketClosed: () => false,
    getState: async () => makeState(),
    writeState: async (_u, s) => {
      writes.state.push(s);
    },
    getCurvePoint: async () => null,
    appendCurvePoint: async (_u, p) => {
      writes.points.push(p);
    },
    fetchBars: async (t) => barsByTicker[t] ?? [],
    ...overrides,
  };
  return { deps, writes };
}

describe('runMtm', () => {
  it('cron moved to 22:00 UTC weekdays (after EOD settlement)', () => {
    expect(CRON).toBe('0 22 * * 1-5');
  });

  it('marks, writes state + a bar-dated curve point on a normal day', async () => {
    const { deps, writes } = makeDeps({});
    const res = await runMtm(deps);
    expect(res.statusCode).toBe(200);
    expect(writes.state).toHaveLength(1);
    expect(writes.points).toHaveLength(1);
    expect(writes.points[0].date).toBe('2024-01-09');
    expect(writes.points[0].equity).toBeCloseTo(105_000, 2);
  });

  it('skips on NYSE holidays without touching state or the curve (M9)', async () => {
    const { deps, writes } = makeDeps({
      now: () => new Date('2026-12-25T22:00:00.000Z'), // Christmas, a Friday
      marketClosed: (d) => d.toISOString().slice(0, 10) === '2026-12-25',
    });
    const res = await runMtm(deps);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string).action).toBe('skipped-market-closed');
    expect(writes.state).toHaveLength(0);
    expect(writes.points).toHaveLength(0);
  });

  it('skips when the latest bar date already has a curve point (M9 duplicate guard)', async () => {
    const { deps, writes } = makeDeps({
      getCurvePoint: async (_u, date) =>
        date === '2024-01-09'
          ? ({ date } as unknown as EquityCurvePoint)
          : null,
    });
    const res = await runMtm(deps);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string).action).toBe('skipped-duplicate-bar-date');
    expect(writes.state).toHaveLength(0);
    expect(writes.points).toHaveLength(0);
  });

  it('no-ops when no portfolio state exists (pre-W5)', async () => {
    const { deps, writes } = makeDeps({ getState: async () => null });
    const res = await runMtm(deps);
    expect(JSON.parse(res.body as string).action).toBe('no-state');
    expect(writes.points).toHaveLength(0);
  });
});
