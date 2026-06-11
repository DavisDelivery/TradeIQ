// Wave 4C (code-review-2026-06 track-1, M5 prerequisite) — TTM EPS window
// discipline + the new epsGrowthTTM field.
//
// Pre-fix, `ttmEps` mapped missing quarters to 0 (a name with 2 reported
// quarters got a half-year "TTM" EPS) while `priorTtmEps` tracked an ok
// flag. Both windows now use the ok-flag discipline, and the snapshot
// carries `epsGrowthTTM` = (ttmEps − priorTtmEps) / |priorTtmEps| for the
// Lynch PEG input.
//
// Harness mirrors phase4w-overlap-contract.test.ts: fake Firestore for the
// pit-cache, fetch mock serving Massive-shape statement rows.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __setDbForTesting } from '../pit-cache';
import { getFundamentals, _clearLiveFundamentalsCache } from '../data-provider';

function makeFakeDb() {
  const store = new Map<string, unknown>();
  const docRef = (id: string) => ({
    id,
    async get() { const v = store.get(id); return { exists: v !== undefined, data: () => v }; },
    async set(payload: unknown) { store.set(id, payload); },
  });
  return {
    collection: () => ({ doc: docRef }),
    async getAll(...refs: ReturnType<typeof docRef>[]) {
      return refs.map((r) => {
        const v = store.get(r.id);
        return { exists: v !== undefined, data: () => v };
      });
    },
    __store: store,
  };
}

const ORIGINAL_FETCH = globalThis.fetch;

interface QRow { period_end: string; eps: number | null }

function incomeRow(q: QRow) {
  return {
    tickers: ['TTMTEST'],
    period_end: q.period_end,
    filing_date: q.period_end,
    fiscal_quarter: 1,
    fiscal_year: 2024,
    timeframe: 'quarterly',
    revenue: 1_000_000_000,
    ...(q.eps !== null ? { basic_earnings_per_share: q.eps } : {}),
    gross_profit: 400_000_000,
    operating_income: 200_000_000,
  };
}

let incomeRows: ReturnType<typeof incomeRow>[] = [];

beforeEach(() => {
  process.env.MASSIVE_FUNDAMENTALS_API_KEY = 'test-key';
  delete process.env.PIT_CACHE_BYPASS;
  _clearLiveFundamentalsCache();
  __setDbForTesting(makeFakeDb() as never);

  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const body = url.includes('/income-statements')
      ? { status: 'OK', results: incomeRows }
      : { status: 'OK', results: [] };
    return {
      ok: true, status: 200, headers: { get: () => '' },
      json: async () => body, text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
});
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

const PERIODS = [
  '2024-12-31', '2024-09-30', '2024-06-30', '2024-03-31',
  '2023-12-31', '2023-09-30', '2023-06-30', '2023-03-31',
];

describe('Wave 4C — TTM EPS ok-flag discipline + epsGrowthTTM', () => {
  it('computes epsGrowthTTM from complete 8-quarter history', async () => {
    // Current TTM: 1.4+1.4+1.4+1.4 = 5.6; prior TTM (q3-q6): 1.4+1.25+1.25+1.25 = 5.15.
    const eps = [1.4, 1.4, 1.4, 1.4, 1.25, 1.25, 1.25, 1.25];
    incomeRows = PERIODS.map((p, i) => incomeRow({ period_end: p, eps: eps[i] }));
    const snap = await getFundamentals('TTMTEST');
    expect(snap).not.toBeNull();
    expect(snap!.ttmEps).toBeCloseTo(5.6, 6);
    expect(snap!.priorTtmEps).toBeCloseTo(5.15, 6);
    expect(snap!.epsGrowthTTM).toBeCloseTo((5.6 - 5.15) / 5.15, 9);
  });

  it('smooths a base-effect quarterly rebound: quarterly YoY +300% but TTM growth ~12%', async () => {
    // The provider's quarterly-YoY baseline is income[3] (VX semantics,
    // pinned by phase4w-overlap-contract). Latest quarter 2.0 vs a
    // depressed 0.5 baseline → epsGrowthYoY = +300%. The TTM windows:
    // current 2.0+1.0+1.0+0.5 = 4.5 vs prior 0.5+1.173×3 ≈ 4.02
    // → epsGrowthTTM ≈ +12%.
    const eps = [2.0, 1.0, 1.0, 0.5, 1.173, 1.173, 1.173, 1.0];
    incomeRows = PERIODS.map((p, i) => incomeRow({ period_end: p, eps: eps[i] }));
    const snap = await getFundamentals('TTMTEST');
    expect(snap).not.toBeNull();
    expect(snap!.epsGrowthYoY).toBeCloseTo(3.0, 6); // the misleading single-quarter rate
    expect(snap!.epsGrowthTTM!).toBeGreaterThan(0.10);
    expect(snap!.epsGrowthTTM!).toBeLessThan(0.14); // the honest TTM rate
  });

  it('returns ttmEps undefined when a quarter in the current window is missing EPS (no 0-mapping)', async () => {
    const eps: Array<number | null> = [1.4, null, 1.4, 1.4, 1.25, 1.25, 1.25, 1.25];
    incomeRows = PERIODS.map((p, i) => incomeRow({ period_end: p, eps: eps[i] }));
    const snap = await getFundamentals('TTMTEST');
    expect(snap).not.toBeNull();
    // Pre-fix this summed the missing quarter as 0 → ttmEps 4.2.
    expect(snap!.ttmEps).toBeUndefined();
    expect(snap!.epsGrowthTTM).toBeUndefined();
    // Prior window is complete and keeps its value.
    expect(snap!.priorTtmEps).toBeCloseTo(5.15, 6);
  });

  it('returns ttmEps/epsGrowthTTM undefined with fewer than 4 quarters of history', async () => {
    const eps = [1.4, 1.3];
    incomeRows = PERIODS.slice(0, 2).map((p, i) => incomeRow({ period_end: p, eps: eps[i] }));
    const snap = await getFundamentals('TTMTEST');
    expect(snap).not.toBeNull();
    expect(snap!.ttmEps).toBeUndefined();
    expect(snap!.priorTtmEps).toBeUndefined();
    expect(snap!.epsGrowthTTM).toBeUndefined();
  });
});
