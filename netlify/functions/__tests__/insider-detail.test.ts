// DESK-1 W3 — /api/insider-detail tests.
//
// Covers:
//   - net/buy/sell dollars + last-10 filings assembly (newest first)
//   - transport failure → dataUnavailable: true (honest no-data, M8)
//   - daily cache: same-day hit skips the provider; unavailable results
//     are never cached (transient blips must not stick for a day)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getInsiderActivityMock = vi.fn();
const docs: Record<string, any> = {};

vi.mock('../shared/insider-provider', () => ({
  getInsiderActivity: (...args: unknown[]) => getInsiderActivityMock(...args),
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
  name: 'Jane Exec', share: 1000, change: 1000,
  filingDate: '2026-07-01', transactionDate: '2026-06-28',
  transactionPrice: 50, transactionCode: 'P', position: 'CFO',
  ...over,
});

const activity = (over: Record<string, unknown> = {}) => ({
  ticker: 'AAPL', lookbackDays: 90,
  totalBuys: 2, totalSells: 1,
  netDollars: 75_000, buyDollars: 100_000, sellDollars: 25_000,
  uniqueBuyers: 2, clusters: [], firstBuyInAYear: false,
  transactions: [
    tx({ filingDate: '2026-06-01', name: 'Old Filing' }),
    tx({ filingDate: '2026-07-05', name: 'New Filing' }),
  ],
  fetchedAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  getInsiderActivityMock.mockReset();
  for (const k of Object.keys(docs)) delete docs[k];
});

describe('buildDetail', () => {
  it('assembles net dollars + filings, newest filing first', () => {
    const d = buildDetail('AAPL', activity() as any, '2026-07-10');
    expect(d.netDollars).toBe(75_000);
    expect(d.filings![0].name).toBe('New Filing');
    expect(d.filings![1].name).toBe('Old Filing');
    expect(d.filings![0].dollarValue).toBe(50_000); // 1000 * 50
    expect(d.dataUnavailable).toBeUndefined();
  });

  it('caps the filings table at 10', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      tx({ filingDate: `2026-06-${String((i % 28) + 1).padStart(2, '0')}` }));
    const d = buildDetail('AAPL', activity({ transactions: many }) as any, '2026-07-10');
    expect(d.filings).toHaveLength(_internals.MAX_FILINGS);
  });

  it('null activity (transport failure) → dataUnavailable, no fabricated zeros', () => {
    const d = buildDetail('AAPL', null, '2026-07-10');
    expect(d.dataUnavailable).toBe(true);
    expect(d.netDollars).toBeUndefined();
  });
});

describe('handler — daily cache', () => {
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
    expect(getInsiderActivityMock).not.toHaveBeenCalled();
  });

  it('does not cache a transport-failure result', async () => {
    getInsiderActivityMock.mockResolvedValue(null);
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.ok).toBe(true);
    expect(body.dataUnavailable).toBe(true);
    expect(docs[`${_internals.COLLECTION}/AAPL`]).toBeUndefined();
  });

  it('400s without a ticker', async () => {
    const res = await handler(evt({}), {} as any);
    expect(res!.statusCode).toBe(400);
  });
});
