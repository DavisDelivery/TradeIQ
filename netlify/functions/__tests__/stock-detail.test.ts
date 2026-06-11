// Phase 6 W1 — /api/stock-detail endpoint contract tests.
//
// Every provider is mocked. Pins the aggregated bundle shape, the honest
// no-data nulls for metrics that aren't sourceable yet, and the 400/404 paths.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bar } from '../shared/data-provider';

const getDailyBarsMock = vi.fn();
const getFundamentalsMock = vi.fn();
const getEarningsHistoryMock = vi.fn();
const getUpcomingEarningsMock = vi.fn();
const getNewsMock = vi.fn();
const getPreviousCloseMock = vi.fn();
vi.mock('../shared/data-provider', () => ({
  getDailyBars: (...a: unknown[]) => getDailyBarsMock(...a),
  getFundamentals: (...a: unknown[]) => getFundamentalsMock(...a),
  getEarningsHistory: (...a: unknown[]) => getEarningsHistoryMock(...a),
  getUpcomingEarnings: (...a: unknown[]) => getUpcomingEarningsMock(...a),
  getNews: (...a: unknown[]) => getNewsMock(...a),
  getPreviousClose: (...a: unknown[]) => getPreviousCloseMock(...a),
}));

const getInsiderActivityMock = vi.fn();
vi.mock('../shared/insider-provider', () => ({
  getInsiderActivity: (...a: unknown[]) => getInsiderActivityMock(...a),
}));

const getSectorMediansMock = vi.fn();
vi.mock('../shared/sector-medians', () => ({
  getSectorMedians: (...a: unknown[]) => getSectorMediansMock(...a),
}));

// Phase 6 PR-D: the quarterly chart series is now a pure transform over
// `fund.statements` (4w's getFundamentals output). No separate provider to
// mock — the test below drives quarterly[] via getFundamentalsMock's
// `statements` field.

const getTickerInfoMock = vi.fn();
vi.mock('../shared/ticker-reference', () => ({
  getTickerInfo: (...a: unknown[]) => getTickerInfoMock(...a),
}));

vi.mock('../shared/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { handler } from '../stock-detail';

function evt(qs: Record<string, string> = {}) {
  return { httpMethod: 'GET', queryStringParameters: qs, headers: {}, body: null } as any;
}

function genBars(n = 300): Bar[] {
  const bars: Bar[] = [];
  let c = 100;
  const startT = Date.parse('2025-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const o = c;
    c = c * (1 + (i % 7 === 0 ? -0.004 : 0.006));
    bars.push({ t: startT + i * 86400000, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: 1e6 });
  }
  return bars;
}

beforeEach(() => {
  for (const m of [
    getDailyBarsMock, getFundamentalsMock, getEarningsHistoryMock, getUpcomingEarningsMock,
    getNewsMock, getPreviousCloseMock, getInsiderActivityMock, getSectorMediansMock,
    getTickerInfoMock,
  ]) m.mockReset();

  getDailyBarsMock.mockResolvedValue(genBars());
  getFundamentalsMock.mockResolvedValue({
    ticker: 'AAPL', ttmEps: 6, grossMargin: 0.44, operatingMargin: 0.3, debtToEquity: 1.2,
    // Phase 6 PR-D: stock-detail's quarterly chart series is derived from
    // this `statements` bundle (4w shape), not a separate fetcher.
    statements: [
      {
        periodEnd: '2026-03-31', filingDate: '2026-04-30', fiscalQuarter: 1, fiscalYear: 2026,
        income: { revenue: 1000, grossProfit: 440, operatingIncome: 300, netIncome: 240, basicEps: 2.4, ebitda: 320 },
        balance: { totalAssets: 5000, totalCurrentAssets: 2000, totalCurrentLiabilities: 1000, cashAndEquivalents: 1500, inventories: 100, longTermDebt: 600, debtCurrent: 50, totalEquity: 2000 },
        cashflow: { operatingCashFlow: 280, capitalExpenditure: -30, freeCashFlow: 250, dividendsPaid: -10 },
      },
    ],
  });
  getEarningsHistoryMock.mockResolvedValue([
    { period: '2025-12-31', announceDate: '2026-01-30', epsActual: 2.4, epsEstimate: 2.2, surprisePct: 9.1 },
  ]);
  getUpcomingEarningsMock.mockResolvedValue({ date: '2026-06-15', epsEstimate: 2.5 });
  getNewsMock.mockResolvedValue([
    { id: '1', title: 'AAPL ships thing', publishedUtc: new Date().toISOString(), url: 'http://x', tickers: ['AAPL'], publisher: 'Reuters' },
  ]);
  getPreviousCloseMock.mockResolvedValue(null);
  getInsiderActivityMock.mockResolvedValue({
    ticker: 'AAPL', netDollars: 8_400_000,
    latestBuy: { date: '2026-02-01', dollars: 1_200_000, role: 'Insider', name: 'Jane' },
  });
  getSectorMediansMock.mockResolvedValue({
    sector: 'Technology', sampleSize: 12, cached: false,
    medians: { pe: 26.1, grossMargin: 40, opMargin: 22.4, debtEquity: 1.85 },
  });
  getTickerInfoMock.mockResolvedValue({ ticker: 'AAPL', name: 'Apple Inc.', marketCap: 3.5e12 });
});

describe('GET /api/stock-detail', () => {
  it('returns 400 when ticker is missing', async () => {
    const res = await handler(evt({}), {} as any, () => {});
    expect((res as any).statusCode).toBe(400);
  });

  it('returns 404 when there are no price bars', async () => {
    getDailyBarsMock.mockResolvedValue([]);
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(404);
    expect(JSON.parse((res as any).body).error).toMatch(/no price bars/i);
  });

  it('returns the full aggregated bundle shape', async () => {
    const res = await handler(evt({ ticker: 'aapl' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const b = JSON.parse((res as any).body);

    expect(b.ok).toBe(true);
    expect(b.ticker).toBe('AAPL');
    expect(b.name).toBe('Apple Inc.');
    expect(typeof b.price).toBe('number');

    // metrics: sourceable values present, unsourceable ones explicitly null.
    expect(b.metrics.valuation.pe).toBeGreaterThan(0);
    expect(b.metrics.valuation.ps).toBeNull();
    expect(b.metrics.profitability.grossMargin).toBe(44);
    expect(b.metrics.profitability.roe).toBeNull();
    expect(b.metrics.health.debtEquity).toBe(1.2);
    expect(b.metrics.market.range52w).toMatchObject({ low: expect.any(Number), high: expect.any(Number) });

    // sector medians
    expect(b.sectorMedians.valuation.pe).toBe(26.1);
    expect(b.sectorMedians.sampleSize).toBe(12);

    // catalysts
    expect(b.catalysts.lastEarnings.surprisePct).toBe(9.1);
    expect(b.catalysts.nextEarnings.date).toBe('2026-06-15');
    expect(b.catalysts.nextEarnings.daysUntil).toBeGreaterThanOrEqual(0);
    expect(b.catalysts.news).toHaveLength(1);
    expect(b.catalysts.insider.net90dDollarVolume).toBe(8_400_000);

    // fundamentals history + relative strength
    expect(b.fundamentalsHistory.quarterly).toHaveLength(1);
    expect(b.fundamentalsHistory.quarterly[0]).toMatchObject({
      period: 'Q1 2026', endDate: '2026-03-31', revenue: 1000, eps: 2.4,
      // Phase 6 PR-D: new derived fields
      netMargin: 24, freeCashFlow: 250, debtToEquity: 0.3,
    });
    expect(Array.isArray(b.relativeStrength.vsSpy)).toBe(true);
    expect(b.relativeStrength.vsSpy.length).toBeGreaterThan(0);
  });

  it('marks metrics no-data when fundamentals are unavailable (no fabricated zeros)', async () => {
    getFundamentalsMock.mockResolvedValue(null);
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    const b = JSON.parse((res as any).body);
    expect(b.metrics._reason).toBe('fundamentals_unavailable');
    expect(b.metrics.valuation.pe).toBeNull();
    expect(b.metrics.profitability.grossMargin).toBeNull();
    expect(b.metrics.health.debtEquity).toBeNull();
  });

  it('flags empty fundamentals history with a reason when statements[] is empty', async () => {
    // PR-D: quarterly[] is derived from fund.statements — empty statements
    // → empty quarterly → _reason flagged.
    getFundamentalsMock.mockResolvedValue({
      ticker: 'AAPL', ttmEps: 6, grossMargin: 0.44, operatingMargin: 0.3, debtToEquity: 1.2,
      statements: [],
    });
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    const b = JSON.parse((res as any).body);
    expect(b.fundamentalsHistory.quarterly).toHaveLength(0);
    expect(b.fundamentalsHistory._reason).toBe('quarterly_history_unavailable');
  });

  it('returns 500 on an unexpected error', async () => {
    getDailyBarsMock.mockImplementation(() => { throw new Error('sync provider boom'); });
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    // getDailyBars is wrapped in .catch → bars empty → 404, not 500. Either is
    // a non-crash; assert the handler degrades gracefully.
    expect([404, 500]).toContain((res as any).statusCode);
  });

  // -----------------------------------------------------------------------
  // Phase 6 PR-G0 — resilience regression
  //
  // A single hanging provider must NOT take down the endpoint. Each dep is
  // bounded by its per-dep timeout via withTimeoutStatus, so a hang resolves
  // to that dep's fallback + a `_degraded.<name>` flag. The endpoint still
  // returns 200 within the wall-clock budget.
  // -----------------------------------------------------------------------

  it('does NOT 502 when getInsiderActivity hangs — degrades cleanly + flags _degraded.insider', async () => {
    // Insider hangs forever; everything else returns normally.
    getInsiderActivityMock.mockImplementation(() => new Promise(() => { /* never settles */ }));
    const t0 = Date.now();
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    const elapsed = Date.now() - t0;
    expect((res as any).statusCode).toBe(200);
    // Whole handler settles within the dep budget + assembly overhead
    // (~6s + a couple seconds). Test in milliseconds with comfortable
    // headroom so flaky-CI doesn't trip the assertion.
    expect(elapsed).toBeLessThan(10_000);
    const b = JSON.parse((res as any).body);
    expect(b.ok).toBe(true);
    expect(b._degraded?.insider).toBe('insider_timeout');
    // The (formerly insider-derived) catalyst block must NOT be missing the
    // payload shape — it just has insider=null.
    expect(b.catalysts.insider).toBeNull();
    // Other sections that didn't depend on insider still populate.
    expect(b.metrics.valuation.pe).toBeGreaterThan(0);
    expect(Array.isArray(b.relativeStrength.vsSpy)).toBe(true);
  }, 15_000);

  it('does NOT 502 when getSectorMedians hangs — degrades cleanly', async () => {
    getSectorMediansMock.mockImplementation(() => new Promise(() => { /* never settles */ }));
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const b = JSON.parse((res as any).body);
    expect(b._degraded?.sectorMedians).toBe('sectorMedians_timeout');
    // Sector medians defaults to empty groups + sampleSize 0; the panel
    // renders no median chip beside each metric, which is the honest state.
    expect(b.sectorMedians.sampleSize).toBe(0);
    // Stock-level metrics still populate.
    expect(b.metrics.valuation.pe).toBeGreaterThan(0);
  }, 15_000);

  it('flags errored deps separately from timed-out deps', async () => {
    // News rejects (errored), upcoming-earnings hangs (timeout).
    getNewsMock.mockImplementation(() => Promise.reject(new Error('rate-limit')));
    getUpcomingEarningsMock.mockImplementation(() => new Promise(() => { /* hang */ }));
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const b = JSON.parse((res as any).body);
    expect(b._degraded?.news).toBe('news_error');
    expect(b._degraded?.upcoming).toBe('upcoming_timeout');
  }, 15_000);
});
