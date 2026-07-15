// Phase 4e-1 — Forward-return populator tests.
//
// Mocks the state-CRUD reader/writer and the Polygon bars provider.
// Verifies the maturity logic + the end-to-end populate flow on a
// small fixture.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecisionLogRow } from '../shared/prophet-portfolio/types';

type MockRow = DecisionLogRow;

const fixture: {
  rows: MockRow[];
  patches: Array<{ ticker: string; date: string; patch: Record<string, number | null | string> }>;
  bars: Record<string, Array<{ t: number; c: number }>>;
} = { rows: [], patches: [], bars: {} };

vi.mock('../shared/prophet-portfolio/state', () => ({
  listDecisionLogRowsOlderThan: vi.fn(async () => fixture.rows),
  updateDecisionLogForwardReturns: vi.fn(
    async (_u: string, ticker: string, date: string, patch: any) => {
      fixture.patches.push({ ticker, date, patch });
    },
  ),
}));

vi.mock('../shared/data-provider', () => ({
  getDailyBars: vi.fn(async (ticker: string) => fixture.bars[ticker] ?? []),
}));

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import {
  MAX_FWD_RETURN_ATTEMPTS,
  maturedWindowsFor,
  populateForwardReturns,
} from '../scan-prophet-portfolio-fwd-returns-background';

function row(decisionDate: string, ticker: string, patch: Partial<MockRow> = {}): MockRow {
  return {
    decisionDate,
    ticker,
    action: 'ADD',
    composite: 80,
    layers: {},
    regime: 'risk_on',
    signalId: 'composite-v1',
    ...patch,
  };
}

function linearBars(startDate: string, count: number, step: number): Array<{ t: number; c: number }> {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => ({
    t: startMs + i * 86_400_000,
    c: 100 + i * step,
  }));
}

beforeEach(() => {
  fixture.rows = [];
  fixture.patches = [];
  fixture.bars = {};
});

describe('maturedWindowsFor', () => {
  it('returns [] for rows younger than 30+5 days', () => {
    expect(maturedWindowsFor(row('2024-01-01', 'A'), '2024-01-15')).toEqual([]);
  });

  it('returns [30] for rows ~35 days old missing only 30d return', () => {
    expect(maturedWindowsFor(row('2024-01-01', 'A'), '2024-02-10')).toEqual([30]);
  });

  it('returns [30,60,90] for rows >95 days old with all fields null', () => {
    expect(maturedWindowsFor(row('2024-01-01', 'A'), '2024-04-15')).toEqual([
      30, 60, 90,
    ]);
  });

  it('skips windows already populated', () => {
    const r = row('2024-01-01', 'A', { forwardReturn30d: 0.05 });
    expect(maturedWindowsFor(r, '2024-04-15')).toEqual([60, 90]);
  });
});

describe('populateForwardReturns', () => {
  it('writes forward-return patch for a matured row', async () => {
    fixture.rows = [row('2024-01-01', 'AAPL')];
    fixture.bars.AAPL = linearBars('2024-01-01', 200, 0.5);
    const result = await populateForwardReturns('largecap', '2024-04-15');
    expect(result.rowsConsidered).toBe(1);
    expect(result.rowsUpdated).toBe(1);
    expect(fixture.patches).toHaveLength(1);
    const p = fixture.patches[0].patch;
    // 30 days later: +15 from 100 = 115 → 15% return.
    expect(p.forwardReturn30d).toBeGreaterThan(0.14);
    expect(p.forwardReturn30d).toBeLessThan(0.16);
  });

  it('records a warning when bars are missing (and no returns are written)', async () => {
    fixture.rows = [row('2024-01-01', 'GHOST')];
    fixture.bars = {};
    const result = await populateForwardReturns('largecap', '2024-04-15');
    expect(result.warnings.length).toBeGreaterThan(0);
    // Wave 3A: the failed attempt is counted (one patch write), but no
    // forward-return value lands.
    for (const p of fixture.patches) {
      expect(p.patch.forwardReturn30d).toBeUndefined();
      expect(p.patch.forwardReturn60d).toBeUndefined();
      expect(p.patch.forwardReturn90d).toBeUndefined();
    }
  });

  it('skips rows whose windows have not yet matured', async () => {
    fixture.rows = [row('2024-01-01', 'A')];
    fixture.bars.A = linearBars('2024-01-01', 5, 1);
    const result = await populateForwardReturns('largecap', '2024-01-10');
    expect(result.rowsUpdated).toBe(0);
    expect(fixture.patches).toHaveLength(0);
  });

  // --- Wave 3A / M5 — exhaustion + starvation fix ----------------------------

  it('increments fwdReturnAttempts on a failed (no-bars) matured row', async () => {
    fixture.rows = [row('2024-01-01', 'GHOST')];
    fixture.bars = {};
    const result = await populateForwardReturns('largecap', '2024-04-15');
    expect(result.rowsExhausted).toBe(0);
    expect(fixture.patches).toHaveLength(1);
    expect(fixture.patches[0].patch.fwdReturnAttempts).toBe(1);
    expect(fixture.patches[0].patch.fwdReturnsStatus).toBeUndefined();
  });

  it('marks a row exhausted (explicit nulls) after MAX_FWD_RETURN_ATTEMPTS failures', async () => {
    fixture.rows = [
      row('2024-01-01', 'DELISTED', {
        fwdReturnAttempts: MAX_FWD_RETURN_ATTEMPTS - 1,
      }),
    ];
    fixture.bars = {}; // delisted → no bars, ever
    const result = await populateForwardReturns('largecap', '2024-04-15');
    expect(result.rowsExhausted).toBe(1);
    const p = fixture.patches[0].patch as Record<string, unknown>;
    expect(p.fwdReturnsStatus).toBe('exhausted');
    expect(p.fwdReturnAttempts).toBe(MAX_FWD_RETURN_ATTEMPTS);
    // Unresolvable windows are written as EXPLICIT nulls, not left missing.
    expect(p.forwardReturn30d).toBeNull();
    expect(p.forwardReturn60d).toBeNull();
    expect(p.forwardReturn90d).toBeNull();
  });

  it('younger rows get processed once dead old rows are marked exhausted', async () => {
    // Simulate the post-fix query: the pending-only filter (state.ts)
    // excludes exhausted rows, so with the old head row written off the
    // batch window reaches the younger row — which then resolves.
    const dead = row('2023-06-01', 'DELISTED', {
      fwdReturnsStatus: 'exhausted',
      fwdReturnAttempts: MAX_FWD_RETURN_ATTEMPTS,
      forwardReturn30d: null,
      forwardReturn60d: null,
      forwardReturn90d: null,
    });
    const young = row('2024-01-01', 'AAPL');
    // Defensive in-function skip: even if a caller hands exhausted rows
    // through, they are not retried…
    fixture.rows = [dead, young];
    fixture.bars.AAPL = linearBars('2024-01-01', 200, 0.5);
    const result = await populateForwardReturns('largecap', '2024-04-15');
    expect(result.rowsUpdated).toBe(1);
    expect(fixture.patches).toHaveLength(1);
    expect(fixture.patches[0].ticker).toBe('AAPL');
    expect(fixture.patches[0].patch.forwardReturn30d).toBeGreaterThan(0);
  });

  it('marks a row complete when all three windows fill', async () => {
    fixture.rows = [row('2024-01-01', 'AAPL')];
    fixture.bars.AAPL = linearBars('2024-01-01', 200, 0.5);
    await populateForwardReturns('largecap', '2024-06-01'); // all matured
    expect(fixture.patches).toHaveLength(1);
    const p = fixture.patches[0].patch as Record<string, unknown>;
    expect(p.forwardReturn30d).not.toBeNull();
    expect(p.forwardReturn60d).not.toBeNull();
    expect(p.forwardReturn90d).not.toBeNull();
    expect(p.fwdReturnsStatus).toBe('complete');
  });

  it('closes out an already-filled row that lingers in the batch', async () => {
    fixture.rows = [
      row('2024-01-01', 'AAPL', {
        forwardReturn30d: 0.01,
        forwardReturn60d: 0.02,
        forwardReturn90d: 0.03,
      }),
    ];
    await populateForwardReturns('largecap', '2024-06-01');
    expect(fixture.patches).toHaveLength(1);
    expect(fixture.patches[0].patch.fwdReturnsStatus).toBe('complete');
  });
});
