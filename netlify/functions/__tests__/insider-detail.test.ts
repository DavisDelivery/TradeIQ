// DESK-1 W3 — /api/insider-detail tests.
//
// Covers:
//   - aggregates from the RAW throttled feed: buys='P'>0 (awards 'A'
//     excluded), sells='S'<0; net/buy/sell dollars
//   - filings table includes BOTH buys and sells (the preview-smoke
//     regression: sell-heavy names must not render an empty table),
//     newest filing first, capped at 10
//   - transport failure → dataUnavailable: true (honest no-data, M8)
//   - daily cache: same-day hit skips the provider; unavailable results
//     are never cached (transient blips must not stick for a day)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTxWithStatusMock = vi.fn();
const docs: Record<string, any> = {};

vi.mock('../shared/data-provider', () => ({
  getFinnhubInsiderTransactionsWithStatus: (...args: unknown[]) => getTxWithStatusMock(...args),
}));

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (cn: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: docs[`${cn}/${id}`] !== undefined,
          data: () => docs[`${cn}/${id}`],
        }),
        set: async (payload: any) => { docs[`${cn}/${id}`] = payload; },
      }),
    }),
  }),
}));

vi.mock('../shared/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { handler, buildDetail, _internals } from '../insider-detail';

function evt(qs: Record<string, string>) {
  return { httpMethod: 'GET', queryStringParameters: qs } as any;
}

const tx = (over: Record<string, unknown> = {}) => ({
  name: 'Jane Exec',
  share: 10_000,           // post-transaction holding (unused for direction)
  change: 1000,            // signed delta — the real count
  filingDate: '2026-07-01',
  transactionDate: '2026-06-28',
  transactionPrice: 50,
  transactionCode: 'P',
  isDerivative: false,
  source: 'finnhub',
  currency: 'USD',
  ...over,
});

beforeEach(() => {
  getTxWithStatusMock.mockReset();
  for (const k of Object.keys(docs)) delete docs[k];
});

describe('buildDetail', () => {
  it('computes buy/sell/net dollars from signed deltas; awards excluded from buys', () => {
    const raw = [
      tx({ change: 1000, transactionCode: 'P', transactionPrice: 50 }),   // +$50k buy
      tx({ change: -2000, transactionCode: 'S', transactionPrice: 60, name: 'Sam Seller' }), // -$120k sell
      tx({ change: 5000, transactionCode: 'A', transactionPrice: 0, name: 'Grant Recipient' }), // award — excluded
    ];
    const d = buildDetail('AAPL', raw as any, '2026-07-10');
    expect(d.buyDollars).toBe(50_000);
    expect(d.sellDollars).toBe(120_000);
    expect(d.netDollars).toBe(-70_000);
    expect(d.totalBuys).toBe(1);
    expect(d.totalSells).toBe(1);
    expect(d.uniqueBuyers).toBe(1);
    expect(d.dataUnavailable).toBeUndefined();
  });

  it('filings table includes buys AND sells and awards, newest filing first', () => {
    // The preview regression: sell-only names had netDollars but zero rows.
    const raw = [
      tx({ filingDate: '2026-06-01', transactionCode: 'S', change: -500, name: 'Old Sell' }),
      tx({ filingDate: '2026-07-05', transactionCode: 'S', change: -100, name: 'New Sell' }),
      tx({ filingDate: '2026-06-20', transactionCode: 'A', change: 300, name: 'Award Row' }),
    ];
    const d = buildDetail('AAPL', raw as any, '2026-07-10');
    expect(d.filings).toHaveLength(3);
    expect(d.filings![0].name).toBe('New Sell');
    expect(d.filings![0].share).toBe(-100);
    expect(d.filings![0].dollarValue).toBe(5_000); // |−100| * 50
    expect(d.filings!.map((f) => f.transactionCode)).toEqual(['S', 'A', 'S']);
  });

  it('caps the filings table at 10', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      tx({ filingDate: `2026-06-${String((i % 28) + 1).padStart(2, '0')}` }));
    const d = buildDetail('AAPL', many as any, '2026-07-10');
    expect(d.filings).toHaveLength(_internals.MAX_FILINGS);
  });

  it('null raw (transport failure) → dataUnavailable, no fabricated zeros', () => {
    const d = buildDetail('AAPL', null, '2026-07-10');
    expect(d.dataUnavailable).toBe(true);
    expect(d.netDollars).toBeUndefined();
  });

  it('verified-empty (200, zero transactions) returns real zeros, not dataUnavailable', () => {
    const d = buildDetail('AAPL', [], '2026-07-10');
    expect(d.dataUnavailable).toBeUndefined();
    expect(d.netDollars).toBe(0);
    expect(d.filings).toHaveLength(0);
  });
});

describe('handler', () => {
  it('same-day cache hit skips the provider', async () => {
    const today = new Date().toISOString().slice(0, 10);
    docs[`${_internals.COLLECTION}/AAPL`] = {
      asOfDate: today,
      detail: { ticker: 'AAPL', lookbackDays: 90, netDollars: 1234, filings: [] },
    };
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.netDollars).toBe(1234);
    expect(body.cached).toBe(true);
    expect(getTxWithStatusMock).not.toHaveBeenCalled();
  });

  it('rate-limit exhaustion → dataUnavailable, NOT cached', async () => {
    getTxWithStatusMock.mockResolvedValue({ data: [], rateLimited: true, rateLimitExhausted: true });
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.ok).toBe(true);
    expect(body.dataUnavailable).toBe(true);
    expect(docs[`${_internals.COLLECTION}/AAPL`]).toBeUndefined();
  });

  it('successful fetch writes the daily cache', async () => {
    getTxWithStatusMock.mockResolvedValue({
      data: [tx()], rateLimited: false, rateLimitExhausted: false,
    });
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.totalBuys).toBe(1);
    const today = new Date().toISOString().slice(0, 10);
    expect(docs[`${_internals.COLLECTION}/AAPL`].asOfDate).toBe(today);
  });

  it('400s without a ticker', async () => {
    const res = await handler(evt({}), {} as any);
    expect(res!.statusCode).toBe(400);
  });
});
