// Phase 4w W2 — field-overlap contract test.
//
// Orchestrator pre-merge condition: separate from the "score happened to
// match" check, prove that **where VX and Massive serve the same underlying
// numbers (same period_end, same line items), getFundamentals produces an
// identical scoring-facing FundamentalsSnapshot to what the VX path used to
// produce.** This pins the field-mapping contract independent of any
// data-quality drift between the two vendors (which is the *intended*
// improvement, not a regression).
//
// Strategy: pick a known set of underlying numbers, build both a VX-shape
// response and a Massive-shape response from the SAME numbers, run the
// migrated getFundamentals over the Massive side, and replicate the legacy
// VX-side field extraction inline. Assert the scoring-facing fields match
// within 1e-9 tolerance (floating-point noise only).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __setDbForTesting } from '../pit-cache';
import { getFundamentals, _clearLiveFundamentalsCache, type FundamentalsSnapshot } from '../data-provider';

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

// -------- Synthetic numbers (7 quarters newest-first) --------
// Same period_end on both vendors; the underlying line items overlap
// cleanly. This is the apples-to-apples slice — JNJ's continuing-vs-total
// operating-income split or WMT's missing long_term_debt are NOT what this
// test pins; they're real vendor data differences and the migration's
// intended improvements.
interface Q { period_end: string; filing_date: string; fiscal_quarter: number; fiscal_year: number; revenue: number; basic_eps: number; gross_profit: number; operating_income: number; long_term_debt: number; equity: number; }
const QS: Q[] = [
  { period_end: '2024-12-31', filing_date: '2025-01-30', fiscal_quarter: 4, fiscal_year: 2024, revenue: 100_000_000_000, basic_eps: 2.10, gross_profit: 48_000_000_000, operating_income: 32_000_000_000, long_term_debt: 50_000_000_000, equity: 80_000_000_000 },
  { period_end: '2024-09-30', filing_date: '2024-10-30', fiscal_quarter: 3, fiscal_year: 2024, revenue:  95_000_000_000, basic_eps: 1.90, gross_profit: 44_000_000_000, operating_income: 29_000_000_000, long_term_debt: 51_000_000_000, equity: 78_000_000_000 },
  { period_end: '2024-06-30', filing_date: '2024-07-30', fiscal_quarter: 2, fiscal_year: 2024, revenue:  90_000_000_000, basic_eps: 1.70, gross_profit: 41_000_000_000, operating_income: 27_000_000_000, long_term_debt: 52_000_000_000, equity: 76_000_000_000 },
  { period_end: '2024-03-31', filing_date: '2024-04-30', fiscal_quarter: 1, fiscal_year: 2024, revenue:  88_000_000_000, basic_eps: 1.60, gross_profit: 40_000_000_000, operating_income: 26_000_000_000, long_term_debt: 53_000_000_000, equity: 74_000_000_000 },
  { period_end: '2023-12-31', filing_date: '2024-01-30', fiscal_quarter: 4, fiscal_year: 2023, revenue:  85_000_000_000, basic_eps: 1.50, gross_profit: 39_000_000_000, operating_income: 25_000_000_000, long_term_debt: 54_000_000_000, equity: 72_000_000_000 },
  { period_end: '2023-09-30', filing_date: '2023-10-30', fiscal_quarter: 3, fiscal_year: 2023, revenue:  82_000_000_000, basic_eps: 1.40, gross_profit: 37_000_000_000, operating_income: 24_000_000_000, long_term_debt: 55_000_000_000, equity: 70_000_000_000 },
  { period_end: '2023-06-30', filing_date: '2023-07-30', fiscal_quarter: 2, fiscal_year: 2023, revenue:  80_000_000_000, basic_eps: 1.30, gross_profit: 36_000_000_000, operating_income: 23_000_000_000, long_term_debt: 56_000_000_000, equity: 68_000_000_000 },
];

// Massive-shape rows (bare numeric fields).
function massiveIncome(q: Q) {
  return { tickers: ['CONTRACT'], period_end: q.period_end, filing_date: q.filing_date, fiscal_quarter: q.fiscal_quarter, fiscal_year: q.fiscal_year, timeframe: 'quarterly', revenue: q.revenue, basic_earnings_per_share: q.basic_eps, gross_profit: q.gross_profit, operating_income: q.operating_income };
}
function massiveBalance(q: Q) {
  return { tickers: ['CONTRACT'], period_end: q.period_end, filing_date: q.filing_date, fiscal_quarter: q.fiscal_quarter, fiscal_year: q.fiscal_year, timeframe: 'quarterly', long_term_debt_and_capital_lease_obligations: q.long_term_debt, total_equity_attributable_to_parent: q.equity, total_equity: q.equity };
}

// Legacy VX field extraction — the arithmetic the previous getFundamentals
// implementation ran. Replicated inline here so the test pins the *result*
// of the old path even after the path itself is removed from the codebase.
function legacyVxExpected(qs: Q[]): Pick<FundamentalsSnapshot, 'revenue' | 'priorRevenue' | 'revenueGrowthYoY' | 'eps' | 'priorEps' | 'epsGrowthYoY' | 'ttmEps' | 'priorTtmEps' | 'grossMargin' | 'priorGrossMargin' | 'priorGrossMarginYoY' | 'operatingMargin' | 'priorOperatingMargin' | 'priorOperatingMarginYoY' | 'debtToEquity' | 'asOf'> {
  const latest = qs[0], prior = qs[1], yearAgo = qs[3];
  const ttmEps = qs.slice(0, 4).reduce((a, r) => a + r.basic_eps, 0);
  const priorTtmEps = qs.length >= 7
    ? qs.slice(3, 7).reduce((a, r) => a + r.basic_eps, 0)
    : undefined;
  return {
    revenue: latest.revenue,
    priorRevenue: yearAgo.revenue,
    revenueGrowthYoY: (latest.revenue - yearAgo.revenue) / yearAgo.revenue,
    eps: latest.basic_eps,
    priorEps: yearAgo.basic_eps,
    epsGrowthYoY: (latest.basic_eps - yearAgo.basic_eps) / Math.abs(yearAgo.basic_eps),
    ttmEps,
    priorTtmEps,
    grossMargin: latest.gross_profit / latest.revenue,
    priorGrossMargin: prior.gross_profit / prior.revenue,
    priorGrossMarginYoY: yearAgo.gross_profit / yearAgo.revenue,
    operatingMargin: latest.operating_income / latest.revenue,
    priorOperatingMargin: prior.operating_income / prior.revenue,
    priorOperatingMarginYoY: yearAgo.operating_income / yearAgo.revenue,
    debtToEquity: latest.long_term_debt / latest.equity,
    asOf: latest.period_end,
  };
}

beforeEach(() => {
  process.env.MASSIVE_FUNDAMENTALS_API_KEY = 'test-key';
  delete process.env.PIT_CACHE_BYPASS;
  _clearLiveFundamentalsCache();
  __setDbForTesting(makeFakeDb() as never);

  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const body = url.includes('/income-statements') ? { status: 'OK', results: QS.map(massiveIncome) }
      : url.includes('/balance-sheets')             ? { status: 'OK', results: QS.map(massiveBalance) }
      : url.includes('/cash-flow-statements')       ? { status: 'OK', results: [] }
      : url.includes('/ratios')                     ? { status: 'OK', results: [] }
      : { status: 'OK', results: [] };
    return { ok: true, status: 200, headers: { get: () => '' }, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof globalThis.fetch;
});
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

describe('Phase 4w W2 — VX↔Massive field-overlap contract', () => {
  it('reproduces every legacy-VX scoring-facing field within float-noise tolerance', async () => {
    const snap = await getFundamentals('CONTRACT');
    expect(snap).not.toBeNull();
    const expected = legacyVxExpected(QS);

    // Tight tolerance — these are arithmetic identities over identical
    // underlying numbers, so any nonzero delta is a bug.
    const T = 1e-9;
    expect(snap!.revenue).toBeCloseTo(expected.revenue!, 0);
    expect(snap!.priorRevenue).toBeCloseTo(expected.priorRevenue!, 0);
    expect(snap!.revenueGrowthYoY!).toBeCloseTo(expected.revenueGrowthYoY!, 9);
    expect(snap!.eps).toBeCloseTo(expected.eps!, 6);
    expect(snap!.priorEps).toBeCloseTo(expected.priorEps!, 6);
    expect(snap!.epsGrowthYoY!).toBeCloseTo(expected.epsGrowthYoY!, 9);
    expect(snap!.ttmEps).toBeCloseTo(expected.ttmEps!, 6);
    expect(snap!.priorTtmEps).toBeCloseTo(expected.priorTtmEps!, 6);
    expect(snap!.grossMargin!).toBeCloseTo(expected.grossMargin!, 9);
    expect(snap!.priorGrossMargin!).toBeCloseTo(expected.priorGrossMargin!, 9);
    expect(snap!.priorGrossMarginYoY!).toBeCloseTo(expected.priorGrossMarginYoY!, 9);
    expect(snap!.operatingMargin!).toBeCloseTo(expected.operatingMargin!, 9);
    expect(snap!.priorOperatingMargin!).toBeCloseTo(expected.priorOperatingMargin!, 9);
    expect(snap!.priorOperatingMarginYoY!).toBeCloseTo(expected.priorOperatingMarginYoY!, 9);
    expect(snap!.debtToEquity!).toBeCloseTo(expected.debtToEquity!, 9);
    expect(snap!.asOf).toBe(expected.asOf);
    void T; // silence unused-const lint
  });

  it('preserves field equivalence in PIT mode (filing_date.lte filter applied)', async () => {
    // Same overlap contract under PIT — the filter operates BEFORE the
    // assembler, so when no row is excluded the assembled output must be
    // identical to live mode (modulo the comprehensive block deferring
    // valuation to null with _reasons).
    const snap = await getFundamentals('CONTRACT', { asOfDate: '2025-12-31' });
    expect(snap).not.toBeNull();
    const expected = legacyVxExpected(QS);
    expect(snap!.revenueGrowthYoY!).toBeCloseTo(expected.revenueGrowthYoY!, 9);
    expect(snap!.operatingMargin!).toBeCloseTo(expected.operatingMargin!, 9);
    expect(snap!.debtToEquity!).toBeCloseTo(expected.debtToEquity!, 9);
    expect(snap!.meta?.source).toBe('massive-statements-pit');
  });
});
