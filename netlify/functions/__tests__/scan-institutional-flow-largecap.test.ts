// Phase 4f W7 — scheduled flow scanner integration tests.
//
// The handler itself wraps schedule(). We exercise the extracted
// scanOneTicker helper against stubbed Polygon + firebase-admin
// fetchers and verify it produces sane signals end-to-end (dark-pool
// + block-trades + options-flow [4f-finish]).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Polygon fetcher BEFORE importing the function under test.
const fixtureTrades: Record<string, Array<{ t: number; p: number; s: number; x?: number; c?: number[] }>> = {};

vi.mock('../shared/institutional-flow/polygon-trades', () => ({
  getTradesForDay: vi.fn(async (ticker: string, date: string) => ({
    trades: fixtureTrades[`${ticker}|${date}`] ?? [],
    pagesFetched: 1,
    truncated: false,
    warnings: [],
  })),
}));

// Phase 4f-finish — options snapshot fetcher + firebase-admin read for
// prior-day OI. Both default to "nothing", matching first-day-after-
// deploy behavior (no spikes, no prior OI cache).
vi.mock('../shared/institutional-flow/polygon-options-snapshot', () => ({
  getOptionsSnapshot: vi.fn(async () => ({
    window: { trades: [], openInterest: [] },
    oiToday: {},
    pagesFetched: 1,
    warnings: [],
  })),
}));

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: false }),
          }),
        }),
      }),
    }),
  })),
}));

import { _internals } from '../scan-institutional-flow-largecap-background';

beforeEach(() => {
  for (const k of Object.keys(fixtureTrades)) delete fixtureTrades[k];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setDay(
  ticker: string,
  date: string,
  trades: Array<{ p: number; s: number; x?: number; c?: number[] }>,
): void {
  fixtureTrades[`${ticker}|${date}`] = trades.map((t, i) => ({ t: i, ...t }));
}

describe('_internals.scanOneTicker', () => {
  it('produces dark-pool + block-trades signals end-to-end', async () => {
    const asOf = '2024-06-30';
    // Today: 50% dark, plus one obvious block.
    setDay('AAPL', asOf, [
      { p: 150, s: 100_000, x: 4 }, // dark + block
      { p: 150, s: 50_000, x: 10 }, // lit + block
    ]);
    // Baseline days: alternate 0% and 5% dark so baseline has nonzero
    // stdev — needed for the z-score to be defined.
    const baseline = _internals.priorTradingDays(new Date(`${asOf}T00:00:00Z`), 30);
    baseline.forEach((d, i) => {
      const dark = i % 2 === 0 ? 0 : 5;
      setDay('AAPL', d, [
        { p: 150, s: dark, x: 4 },
        { p: 150, s: 100 - dark, x: 10 },
      ]);
    });
    const out = await _internals.scanOneTicker('AAPL', asOf);
    expect(out.ticker).toBe('AAPL');
    expect(out.darkPool).not.toBeNull();
    expect(out.darkPool!.darkPoolPct).toBeCloseTo(100_000 / 150_000, 4);
    expect(out.darkPool!.zScore).toBeGreaterThan(0);
    expect(out.blockTrades.blockCount).toBe(2);
    expect(out.blockTrades.blockNotional).toBe(100_000 * 150 + 50_000 * 150);
    // 4f-finish: options snapshot returned empty in this mock; signal
    // is null, oiToday is empty.
    expect(out.optionsFlow).toBeNull();
    expect(out.oiToday).toEqual({});
  });

  it('returns dark-pool null when today has no trades', async () => {
    const asOf = '2024-06-30';
    // No trades today (weekend/holiday).
    setDay('AAPL', asOf, []);
    const baseline = _internals.priorTradingDays(new Date(`${asOf}T00:00:00Z`), 30);
    for (const d of baseline) {
      setDay('AAPL', d, [{ p: 100, s: 1000, x: 10 }]);
    }
    const out = await _internals.scanOneTicker('AAPL', asOf);
    expect(out.darkPool).toBeNull();
    // Block-trades signal still emits with zero counts.
    expect(out.blockTrades.blockCount).toBe(0);
  });
});

describe('_internals.priorTradingDays', () => {
  it('returns N prior calendar days descending', () => {
    const days = _internals.priorTradingDays(new Date('2024-06-30T00:00:00Z'), 3);
    expect(days).toEqual(['2024-06-29', '2024-06-28', '2024-06-27']);
  });
});
