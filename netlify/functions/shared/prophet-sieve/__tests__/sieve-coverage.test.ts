// Wave 4A (M8) — the sieve result must report TRUE coverage.
//
// Pre-fix, runProphetSieve returned universeChecked = entries.length
// unconditionally: a Stage 1 that hit its 2-min budget and scored only
// ~1,200 of 1,928 names still claimed full-universe coverage in the
// snapshot, the prophet-picks response, and the UI coverage strip.
// Post-fix the result carries BOTH:
//   universeSize    = entries.length (universe at scan start)
//   universeChecked = stage1.scored  (what was actually scored)
//
// Hermetic: stages + scan + data provider are stubbed; the orchestrator's
// wiring is the unit under test.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runStage1Mock: vi.fn(),
  runStage2Mock: vi.fn(),
  runProphetScanMock: vi.fn(),
  getDailyBarsMock: vi.fn(),
}));

vi.mock('../stage1', () => ({ runStage1: mocks.runStage1Mock }));
vi.mock('../stage2', () => ({ runStage2: mocks.runStage2Mock }));
vi.mock('../../scan-prophet', () => ({ runProphetScan: mocks.runProphetScanMock }));
vi.mock('../../data-provider', () => ({ getDailyBars: mocks.getDailyBarsMock }));
vi.mock('../../universe', () => ({ SPY: 'SPY' }));

import { runProphetSieve } from '../index';

function stageMeta(overrides: Record<string, unknown> = {}) {
  return {
    scored: 0,
    survived: 0,
    thresholdScore: null,
    budgetMs: 1,
    partial: false,
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.runStage1Mock.mockReset();
  mocks.runStage2Mock.mockReset();
  mocks.runProphetScanMock.mockReset();
  mocks.getDailyBarsMock.mockReset();
  mocks.getDailyBarsMock.mockResolvedValue([]);
  mocks.runStage2Mock.mockResolvedValue({
    survivors: [{ ticker: 'AAA' }],
    meta: stageMeta({ scored: 5, survived: 1 }),
  });
  mocks.runProphetScanMock.mockResolvedValue({
    picks: [{ ticker: 'AAA', composite: 80, conviction: 'high' }],
    scanDurationMs: 1,
    universeChecked: 1,
    warnings: [],
    budgetExceeded: false,
  });
});

const entries = Array.from({ length: 1928 }, (_, i) => ({ ticker: `T${i}` })) as any;

describe('runProphetSieve — coverage honesty (M8)', () => {
  it('a budget-truncated Stage 1 reports universeChecked = scored, universeSize = entries.length', async () => {
    mocks.runStage1Mock.mockResolvedValue({
      survivors: [{ ticker: 'AAA' }],
      meta: stageMeta({ scored: 1200, survived: 5, partial: true }),
    });

    const result = await runProphetSieve({ entries, universe: 'russell' });

    expect(result.universeSize).toBe(1928);
    expect(result.universeChecked).toBe(1200); // NOT 1928
    expect(result.meta.stage1.partial).toBe(true);
  });

  it('a full Stage 1 pass reports universeChecked = universeSize', async () => {
    mocks.runStage1Mock.mockResolvedValue({
      survivors: [{ ticker: 'AAA' }],
      meta: stageMeta({ scored: 1928, survived: 5 }),
    });

    const result = await runProphetSieve({ entries, universe: 'russell' });

    expect(result.universeSize).toBe(1928);
    expect(result.universeChecked).toBe(1928);
  });
});
