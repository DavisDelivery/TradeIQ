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
} from '../data-provider';
import * as snapshotStore from '../snapshot-store';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.POLYGON_API_KEY = 'test-poly';
  process.env.FINNHUB_API_KEY = 'test-finn';
  process.env.FRED_API_KEY = 'test-fred';
  vi.mocked(snapshotStore.snapshotBeforeDate).mockReset();
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
// W3 — Polygon fundamentals PIT
// ===========================================================================

describe('getFundamentals PIT semantics', () => {
  const fakeFilings = [
    { fiscal_period: 'Q3', fiscal_year: '2024', filing_date: '2024-10-30', end_date: '2024-09-30', financials: {} },
    { fiscal_period: 'Q2', fiscal_year: '2024', filing_date: '2024-07-31', end_date: '2024-06-30', financials: {} },
    { fiscal_period: 'Q1', fiscal_year: '2024', filing_date: '2024-04-30', end_date: '2024-03-31', financials: {} },
    { fiscal_period: 'Q4', fiscal_year: '2023', filing_date: null, end_date: '2023-12-31', financials: {} },
  ];

  it('passes filing_date.lte to Polygon when asOfDate is set', async () => {
    let observedUrl = '';
    mockFetch((url) => {
      observedUrl = url;
      return { status: 'OK', results: [] };
    });
    await getFundamentals('NVDA', { asOfDate: '2024-06-15' });
    expect(observedUrl).toContain('filing_date.lte=2024-06-15');
  });

  it('does NOT pass filing_date.lte when asOfDate omitted', async () => {
    let observedUrl = '';
    mockFetch((url) => {
      observedUrl = url;
      return { status: 'OK', results: [] };
    });
    await getFundamentals('NVDA');
    expect(observedUrl).not.toContain('filing_date.lte');
  });

  it('filters out filings dated after asOfDate (in-memory belt+suspenders)', async () => {
    mockFetch(() => ({ status: 'OK', results: fakeFilings }));
    const snap = await getFundamentals('NVDA', { asOfDate: '2024-06-15' });
    expect(snap).not.toBeNull();
    // Only the Q1 2024 filing (2024-04-30) and Q4 2023 (estimated end_date+75d ≈ 2024-03-15)
    // are public on 2024-06-15. Q2 2024 (2024-07-31) and Q3 2024 (2024-10-30) are not.
    // The function returns the LATEST as `asOf` end_date.
    expect(snap!.asOf).toBe('2024-03-31'); // Q1 2024 end_date
  });

  it('uses estimateFilingDate fallback for null filing_date (10-K case)', async () => {
    // Q4 2023 has filing_date=null but end_date=2023-12-31. With +75d estimate
    // filing was approx 2024-03-15. So with asOfDate=2024-04-01 it should be public.
    const onlyQ4 = [fakeFilings[3]]; // Q4 2023 only
    mockFetch(() => ({ status: 'OK', results: onlyQ4 }));
    const snap = await getFundamentals('FOO', { asOfDate: '2024-04-01' });
    expect(snap).not.toBeNull();
    expect(snap!.asOf).toBe('2023-12-31');
  });

  it('drops filings with null filing_date when estimate exceeds asOfDate', async () => {
    const onlyQ4 = [fakeFilings[3]];
    mockFetch(() => ({ status: 'OK', results: onlyQ4 }));
    // 2024-02-01 < estimated filing date (2023-12-31 + 75d = 2024-03-15)
    const snap = await getFundamentals('FOO', { asOfDate: '2024-02-01' });
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
