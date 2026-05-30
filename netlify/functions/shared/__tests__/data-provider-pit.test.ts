import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock must be at module-top; the mock factory is used by all tests.
vi.mock('../snapshot-store', async (orig) => {
  const actual = await orig<typeof import('../snapshot-store')>();
  return {
    ...actual,
    snapshotBeforeDate: vi.fn(),
  };
});

import {
  getFundamentals,
  getNews,
  getFinnhubInsiderTransactions,
  getRecommendations,
  getFredSeries,
  _clearLiveFundamentalsCache,
} from '../data-provider';
import * as snapshotStore from '../snapshot-store';
import { __setDbForTesting } from '../pit-cache';

// Minimal in-memory Firestore fake — mirrors the pattern in
// pit-cache.test.ts. Keeps PIT cache writes off real Firestore.
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

beforeEach(() => {
  process.env.POLYGON_API_KEY = 'test-poly';
  process.env.FINNHUB_API_KEY = 'test-finn';
  process.env.FRED_API_KEY = 'test-fred';
  process.env.MASSIVE_FUNDAMENTALS_API_KEY = 'test-massive';
  delete process.env.PIT_CACHE_BYPASS;
  vi.mocked(snapshotStore.snapshotBeforeDate).mockReset();
  _clearLiveFundamentalsCache();
  __setDbForTesting(makeFakeDb() as never);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function mockFetch(handler: (url: string) => unknown): void {
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = handler(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  });
}

// ===========================================================================
// W3 — Massive fundamentals PIT (Phase 4w W2 migration; replaces VX)
// ===========================================================================

describe('getFundamentals PIT semantics (Massive Financials)', () => {
  // Massive statement rows use bare numeric fields (no {value,unit} wrapping)
  // and number/string fiscal_quarter instead of VX's fiscal_period string.
  const incomeRows = [
    { tickers: ['NVDA'], period_end: '2024-09-30', filing_date: '2024-10-30', fiscal_quarter: 3, fiscal_year: 2024, timeframe: 'quarterly', revenue: 35_000_000_000, basic_earnings_per_share: 0.78, gross_profit: 26_000_000_000, operating_income: 19_000_000_000, consolidated_net_income_loss: 19_300_000_000, ebitda: 21_000_000_000 },
    { tickers: ['NVDA'], period_end: '2024-06-30', filing_date: '2024-07-31', fiscal_quarter: 2, fiscal_year: 2024, timeframe: 'quarterly', revenue: 30_000_000_000, basic_earnings_per_share: 0.67, gross_profit: 22_000_000_000, operating_income: 18_600_000_000, consolidated_net_income_loss: 16_600_000_000, ebitda: 19_000_000_000 },
    { tickers: ['NVDA'], period_end: '2024-03-31', filing_date: '2024-04-30', fiscal_quarter: 1, fiscal_year: 2024, timeframe: 'quarterly', revenue: 26_000_000_000, basic_earnings_per_share: 0.61, gross_profit: 20_400_000_000, operating_income: 16_900_000_000, consolidated_net_income_loss: 14_900_000_000, ebitda: 17_500_000_000 },
    { tickers: ['NVDA'], period_end: '2023-12-31', filing_date: null, fiscal_quarter: 4, fiscal_year: 2023, timeframe: 'quarterly', revenue: 22_100_000_000, basic_earnings_per_share: 0.50, gross_profit: 16_800_000_000, operating_income: 13_600_000_000, consolidated_net_income_loss: 12_300_000_000, ebitda: 14_000_000_000 },
  ];
  const balanceRows = [
    { tickers: ['NVDA'], period_end: '2024-09-30', filing_date: '2024-10-30', fiscal_quarter: 3, fiscal_year: 2024, timeframe: 'quarterly', total_assets: 80_000_000_000, total_current_assets: 50_000_000_000, total_current_liabilities: 12_000_000_000, cash_and_equivalents: 35_000_000_000, inventories: 6_500_000_000, long_term_debt_and_capital_lease_obligations: 9_000_000_000, debt_current: 1_000_000_000, total_equity_attributable_to_parent: 60_000_000_000, total_equity: 60_500_000_000 },
    { tickers: ['NVDA'], period_end: '2024-03-31', filing_date: '2024-04-30', fiscal_quarter: 1, fiscal_year: 2024, timeframe: 'quarterly', total_assets: 65_000_000_000, total_current_assets: 38_000_000_000, total_current_liabilities: 10_000_000_000, cash_and_equivalents: 28_000_000_000, inventories: 5_500_000_000, long_term_debt_and_capital_lease_obligations: 8_500_000_000, debt_current: 1_200_000_000, total_equity_attributable_to_parent: 45_000_000_000, total_equity: 45_300_000_000 },
  ];
  const cashflowRows = [
    { tickers: ['NVDA'], period_end: '2024-09-30', filing_date: '2024-10-30', fiscal_quarter: 3, fiscal_year: 2024, timeframe: 'quarterly', net_income: 19_300_000_000, net_cash_from_operating_activities: 17_600_000_000, purchase_of_property_plant_and_equipment: -1_100_000_000, dividends: -100_000_000 },
  ];

  /** Route fetches by URL to per-endpoint payloads (captures URLs for assertion). */
  function multiMockFetch(handlers: { ratios?: unknown; income?: unknown; balance?: unknown; cashflow?: unknown }, observed?: { urls: string[] }) {
    mockFetch((url) => {
      observed?.urls.push(url);
      if (url.includes('/ratios')) return handlers.ratios ?? { status: 'OK', results: [] };
      if (url.includes('/income-statements')) return handlers.income ?? { status: 'OK', results: [] };
      if (url.includes('/balance-sheets')) return handlers.balance ?? { status: 'OK', results: [] };
      if (url.includes('/cash-flow-statements')) return handlers.cashflow ?? { status: 'OK', results: [] };
      return { status: 'OK', results: [] };
    });
  }

  it('passes filing_date.lte to each statement endpoint when asOfDate is set', async () => {
    const observed = { urls: [] as string[] };
    multiMockFetch({ income: { status: 'OK', results: [] } }, observed);
    await getFundamentals('NVDA', { asOfDate: '2024-06-15' });
    const statementUrls = observed.urls.filter((u) =>
      u.includes('/income-statements') || u.includes('/balance-sheets') || u.includes('/cash-flow-statements'),
    );
    expect(statementUrls.length).toBeGreaterThan(0);
    for (const u of statementUrls) {
      expect(u).toContain('filing_date.lte=2024-06-15');
    }
  });

  it('does NOT pass filing_date.lte and DOES hit ratios in live mode', async () => {
    const observed = { urls: [] as string[] };
    multiMockFetch({}, observed);
    await getFundamentals('NVDA');
    expect(observed.urls.some((u) => u.includes('/ratios'))).toBe(true);
    for (const u of observed.urls) expect(u).not.toContain('filing_date.lte');
  });

  it('skips the ratios endpoint in PIT mode', async () => {
    const observed = { urls: [] as string[] };
    multiMockFetch({}, observed);
    await getFundamentals('NVDA', { asOfDate: '2024-06-15' });
    expect(observed.urls.some((u) => u.includes('/ratios'))).toBe(false);
  });

  it('filters out filings dated after asOfDate (in-memory belt+suspenders)', async () => {
    // Server-side filter is the API filing_date.lte param; the in-memory
    // filter is the second layer. Both lean on the same `filing_date <=
    // asOfDate` predicate (with estimateFilingDate fallback for null).
    multiMockFetch({ income: { status: 'OK', results: incomeRows }, balance: { status: 'OK', results: balanceRows } });
    const snap = await getFundamentals('NVDA', { asOfDate: '2024-06-15' });
    expect(snap).not.toBeNull();
    // Only Q1 2024 (filed 2024-04-30) and Q4 2023 (null filing_date,
    // estimated 2023-12-31+75d ≈ 2024-03-15) are public on 2024-06-15.
    // Q2 (filed 2024-07-31) and Q3 (filed 2024-10-30) are dropped.
    expect(snap!.asOf).toBe('2024-03-31');
  });

  it('uses estimateFilingDate fallback for null filing_date (10-K-style case)', async () => {
    const onlyQ4 = [incomeRows[3]];
    multiMockFetch({ income: { status: 'OK', results: onlyQ4 } });
    // Q4 2023 has filing_date=null but period_end=2023-12-31.
    // Estimated filing ≈ 2024-03-15. So asOfDate=2024-04-01 admits it.
    const snap = await getFundamentals('FOO', { asOfDate: '2024-04-01' });
    expect(snap).not.toBeNull();
    expect(snap!.asOf).toBe('2023-12-31');
  });

  it('drops filings with null filing_date when estimate exceeds asOfDate', async () => {
    const onlyQ4 = [incomeRows[3]];
    multiMockFetch({ income: { status: 'OK', results: onlyQ4 } });
    // 2024-02-01 < estimated filing 2024-03-15 → dropped.
    const snap = await getFundamentals('FOO', { asOfDate: '2024-02-01' });
    expect(snap).toBeNull();
  });

  it('preserves the scoring-facing field contract (Phase 4w regression guard)', async () => {
    // The fundamental analyst reads revenueGrowthYoY, epsGrowthYoY,
    // operatingMargin, priorOperatingMargin, debtToEquity. The migration
    // must produce these names with the same decimal-fraction semantics.
    multiMockFetch({
      income: { status: 'OK', results: incomeRows },
      balance: { status: 'OK', results: balanceRows },
      cashflow: { status: 'OK', results: cashflowRows },
    });
    const snap = await getFundamentals('NVDA');
    expect(snap).not.toBeNull();
    // revenue 35B / priorRevenue 22.1B (year-ago) → ~0.583
    expect(snap!.revenueGrowthYoY).toBeCloseTo((35_000_000_000 - 22_100_000_000) / 22_100_000_000, 4);
    // operatingMargin 19B / 35B → 0.5428...
    expect(snap!.operatingMargin).toBeCloseTo(19_000_000_000 / 35_000_000_000, 4);
    // debtToEquity uses long_term_debt_and_capital_lease_obligations
    // and total_equity_attributable_to_parent: 9B / 60B = 0.15
    expect(snap!.debtToEquity).toBeCloseTo(9_000_000_000 / 60_000_000_000, 4);
  });

  it('populates the comprehensive block from the ratios endpoint in live mode', async () => {
    multiMockFetch({
      ratios: { status: 'OK', results: [{ ticker: 'NVDA', date: '2024-09-30', price_to_earnings: 29.4, price_to_sales: 8.1, ev_to_ebitda: 22.8, market_cap: 3.2e12, return_on_equity: 1.47, return_on_assets: 0.45, current: 4.2, quick: 3.6, cash: 2.9, debt_to_equity: 0.15, dividend_yield: 0.005, free_cash_flow: 16_500_000_000, enterprise_value: 3.1e12, ev_to_sales: 22.0, price_to_book: 35.0, price_to_cash_flow: 25.0, price_to_free_cash_flow: 27.0 }] },
      income: { status: 'OK', results: incomeRows },
      balance: { status: 'OK', results: balanceRows },
      cashflow: { status: 'OK', results: cashflowRows },
    });
    const snap = await getFundamentals('NVDA');
    expect(snap).not.toBeNull();
    expect(snap!.valuation?.pe).toBe(29.4);
    expect(snap!.valuation?.ps).toBe(8.1);
    expect(snap!.profitability?.roe).toBe(1.47);
    expect(snap!.liquidity?.currentRatio).toBe(4.2);
    expect(snap!.leverage?.debtToEquity).toBe(0.15);
    expect(snap!.cashflow?.dividendYield).toBe(0.005);
    expect(snap!.meta?.source).toBe('massive-ratios+statements');
    expect(snap!.statements?.length ?? 0).toBeGreaterThan(0);
  });

  it('marks valuation null with _reasons in PIT mode (no historical price)', async () => {
    multiMockFetch({
      income: { status: 'OK', results: incomeRows },
      balance: { status: 'OK', results: balanceRows },
      cashflow: { status: 'OK', results: cashflowRows },
    });
    const snap = await getFundamentals('NVDA', { asOfDate: '2024-06-15' });
    expect(snap).not.toBeNull();
    expect(snap!.valuation?.pe).toBeNull();
    expect(snap!.valuation?._reasons?.pe).toBe('requires_historical_price');
    // Profitability margins are derivable from statements alone, so they
    // populate even in PIT mode.
    expect(snap!.profitability?.grossMargin).not.toBeNull();
    expect(snap!.meta?.source).toBe('massive-statements-pit');
  });

  it('returns null and does NOT throw when a statement endpoint hard-errors', async () => {
    // Simulate income-statements returning a 500 — getFundamentals must
    // surface as null so the caller's `.catch(() => null)` keeps the
    // scoring path silent (and pit-cache is never written, since the
    // helper throws before the cache write).
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/income-statements')) {
        return { ok: false, status: 500, headers: { get: () => '' }, json: async () => ({}), text: async () => 'server error' } as any;
      }
      return { ok: true, status: 200, headers: { get: () => '' }, json: async () => ({ status: 'OK', results: [] }), text: async () => '{}' } as any;
    });
    const snap = await getFundamentals('NVDA');
    expect(snap).toBeNull();
  });
});

// ===========================================================================
// W4 — Polygon news PIT
// ===========================================================================

describe('getNews PIT semantics', () => {
  it('passes published_utc.lte=<asOfDate>T23:59:59Z when asOfDate is set', async () => {
    let observedUrl = '';
    mockFetch((url) => {
      observedUrl = url;
      return { status: 'OK', results: [] };
    });
    await getNews('AAPL', { asOfDate: '2024-01-01' });
    expect(observedUrl).toContain('published_utc.lte=');
    // URL-encoded: T23%3A59%3A59Z (encoded ':')
    expect(decodeURIComponent(observedUrl)).toContain('published_utc.lte=2024-01-01T23:59:59Z');
  });

  it('does NOT pass published_utc.lte when asOfDate omitted', async () => {
    let observedUrl = '';
    mockFetch((url) => {
      observedUrl = url;
      return { status: 'OK', results: [] };
    });
    await getNews('AAPL', { limit: 5 });
    expect(observedUrl).not.toContain('published_utc.lte');
  });

  it('preserves backwards-compatible bare-number signature', async () => {
    let observedUrl = '';
    mockFetch((url) => {
      observedUrl = url;
      return { status: 'OK', results: [] };
    });
    await getNews('AAPL', 7); // legacy signature
    expect(observedUrl).toContain('limit=7');
    expect(observedUrl).not.toContain('published_utc.lte');
  });
});

// ===========================================================================
// W5 — Insider transactions PIT
// ===========================================================================

describe('getFinnhubInsiderTransactions PIT semantics', () => {
  const fakeInsiderRows = [
    { name: 'Foo CEO', share: 100, change: 100, filingDate: '2024-05-15', transactionDate: '2024-05-13', transactionPrice: 50, transactionCode: 'P', isDerivative: false, source: 'F4', currency: 'USD' },
    { name: 'Bar CFO', share: 50, change: 50, filingDate: '2024-08-15', transactionDate: '2024-08-13', transactionPrice: 60, transactionCode: 'P', isDerivative: false, source: 'F4', currency: 'USD' },
    { name: 'Baz Dir', share: 25, change: 25, filingDate: '2024-11-10', transactionDate: '2024-11-08', transactionPrice: 70, transactionCode: 'P', isDerivative: false, source: 'F4', currency: 'USD' },
  ];

  it('returns all rows when asOfDate omitted', async () => {
    mockFetch(() => ({ data: fakeInsiderRows }));
    const out = await getFinnhubInsiderTransactions('NVDA', 365);
    expect(out).toHaveLength(3);
  });

  it('filters by filingDate <= asOfDate (drops post-cutoff filings)', async () => {
    mockFetch(() => ({ data: fakeInsiderRows }));
    const out = await getFinnhubInsiderTransactions('NVDA', 365, { asOfDate: '2024-07-01' });
    expect(out).toHaveLength(1);
    expect(out[0].filingDate).toBe('2024-05-15');
  });

  it('uses asOfDate as the lookback anchor in the from/to query', async () => {
    let observedUrl = '';
    mockFetch((url) => {
      observedUrl = url;
      return { data: [] };
    });
    await getFinnhubInsiderTransactions('NVDA', 30, { asOfDate: '2024-06-15' });
    // to should be 2024-06-15, from should be 2024-05-16 (30 days before)
    expect(observedUrl).toContain('to=2024-06-15');
    expect(observedUrl).toContain('from=2024-05-16');
  });
});

// ===========================================================================
// W6 — Recommendations PIT (live filter + snapshot fallback)
// ===========================================================================

describe('getRecommendations PIT semantics', () => {
  const liveRecs = [
    { symbol: 'MSFT', period: '2026-04-01', strongBuy: 14, buy: 22, hold: 12, sell: 1, strongSell: 0 },
    { symbol: 'MSFT', period: '2026-03-01', strongBuy: 13, buy: 21, hold: 13, sell: 1, strongSell: 0 },
    { symbol: 'MSFT', period: '2026-02-01', strongBuy: 12, buy: 20, hold: 14, sell: 1, strongSell: 0 },
  ];

  it('returns live recs unfiltered when asOfDate omitted', async () => {
    mockFetch(() => liveRecs);
    const out = await getRecommendations('MSFT');
    expect(out).toHaveLength(3);
    expect(out[0].period).toBe('2026-04-01');
  });

  it('filters live recs by period <= asOfDate when in window', async () => {
    mockFetch(() => liveRecs);
    const out = await getRecommendations('MSFT', { asOfDate: '2026-03-15' });
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.period <= '2026-03-15')).toBe(true);
  });

  it('falls back to snapshot store when asOfDate beyond live window', async () => {
    mockFetch(() => liveRecs); // live response covers 2026-02-01..2026-04-01
    vi.mocked(snapshotStore.snapshotBeforeDate).mockResolvedValueOnce({
      modelVersion: 'test',
      generatedAt: '2023-06-01T12:00:00.000Z',
      scanDurationMs: 1,
      universeChecked: 1,
      results: [
        { ticker: 'MSFT', recommendation: { strongBuy: 9, buy: 15, hold: 8, sell: 0, strongSell: 0, period: '2023-06-01' } },
      ],
      freshnessBudgetMs: 1,
    });

    const out = await getRecommendations('MSFT', { asOfDate: '2023-06-15' });
    expect(snapshotStore.snapshotBeforeDate).toHaveBeenCalledWith('catalyst', 'sp500', '2023-06-15');
    expect(out).toHaveLength(1);
    expect(out[0].buy).toBe(15);
    expect(out[0].period).toBe('2023-06-01');
  });

  it('returns [] when neither live nor snapshot has data', async () => {
    mockFetch(() => liveRecs);
    vi.mocked(snapshotStore.snapshotBeforeDate).mockResolvedValueOnce(null);
    const out = await getRecommendations('UNKNOWN', { asOfDate: '2020-01-01' });
    expect(out).toEqual([]);
  });
});

// ===========================================================================
// W8 — FRED vintage_dates PIT
// ===========================================================================

describe('getFredSeries PIT semantics (vintage_dates)', () => {
  it('passes vintage_dates=<asOfDate> to FRED when asOfDate is set', async () => {
    let observedUrl = '';
    mockFetch((url) => {
      observedUrl = url;
      return { observations: [] };
    });
    await getFredSeries('GDPC1', { asOfDate: '2023-06-01' });
    expect(observedUrl).toContain('vintage_dates=2023-06-01');
  });

  it('does NOT pass vintage_dates when asOfDate omitted', async () => {
    let observedUrl = '';
    mockFetch((url) => {
      observedUrl = url;
      return { observations: [] };
    });
    await getFredSeries('GDPC1');
    expect(observedUrl).not.toContain('vintage_dates');
  });

  it('returns the unrevised value when vintage_dates is supplied', async () => {
    // Simulate FRED returning 2022-Q4 GDP at the 2023-06-01 vintage:
    // value differs from today's restated figure.
    mockFetch(() => ({
      observations: [
        { date: '2022-10-01', value: '20182.491', realtime_start: '2023-06-01', realtime_end: '2023-06-01' },
      ],
    }));
    const out = await getFredSeries('GDPC1', { asOfDate: '2023-06-01' });
    expect(out).toHaveLength(1);
    expect(out[0].value).toBeCloseTo(20182.491, 2);
    expect(out[0].realtimeStart).toBe('2023-06-01');
  });

  it('handles "." (FRED missing-observation sentinel) by returning null value', async () => {
    mockFetch(() => ({
      observations: [
        { date: '2024-01-01', value: '.', realtime_start: '2024-01-01', realtime_end: '2024-01-01' },
        { date: '2024-04-01', value: '22000.0', realtime_start: '2024-04-01', realtime_end: '2024-04-01' },
      ],
    }));
    const out = await getFredSeries('GDPC1');
    expect(out).toHaveLength(2);
    expect(out[0].value).toBeNull();
    expect(out[1].value).toBe(22000.0);
  });
});
