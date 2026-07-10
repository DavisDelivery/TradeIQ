// DESK-1 W1 — /api/earnings-radar tests.
//
// Covers:
//   - honest denominator semantics reused from earnings-intel
//     (null beats ≠ 0 beats; ≤4-quarter denominators)
//   - daysUntil math
//   - daily Firestore cache: same-day hit skips Finnhub, stale refetches
//   - one bad ticker → skipped + warned

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getEarningsHistoryMock = vi.fn();
const getUpcomingEarningsMock = vi.fn();
const acquireMock = vi.fn().mockResolvedValue(undefined);
const docs: Record<string, any> = {};

vi.mock('../shared/data-provider', () => ({
  getEarningsHistory: (...args: unknown[]) => getEarningsHistoryMock(...args),
  getUpcomingEarnings: (...args: unknown[]) => getUpcomingEarningsMock(...args),
}));

vi.mock('../shared/rate-limiter', () => ({
  getFinnhubBucket: () => ({ acquire: acquireMock }),
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

import { handler, assembleEntry, _internals } from '../earnings-radar';

function evt(qs: Record<string, string>) {
  return { httpMethod: 'GET', queryStringParameters: qs } as any;
}

const H = (surprises: Array<number | undefined>) =>
  surprises.map((s, i) => ({
    period: `2026-0${(i % 4) + 1}-01`,
    announceDate: null,
    epsActual: 1 + (s ?? 0) / 100,
    epsEstimate: 1,
    surprisePct: s,
  }));

beforeEach(() => {
  getEarningsHistoryMock.mockReset();
  getUpcomingEarningsMock.mockReset();
  acquireMock.mockClear();
  for (const k of Object.keys(docs)) delete docs[k];
});

describe('assembleEntry — honest denominator', () => {
  const NOW = Date.parse('2026-07-10T12:00:00Z');

  it('counts beats over the quarters that actually have data', () => {
    const e = assembleEntry('AAPL', H([5.2, -1.1, 3.0, 0.4]) as any, '2026-07-31', 1.5, NOW);
    expect(e.beatsLast4).toBe(3);
    expect(e.beatsLast4Quarters).toBe(4);
    expect(e.lastSurprisePct).toBe(5.2);
  });

  it('null beats when Finnhub has no usable surprise data — never 0/4', () => {
    const e = assembleEntry('NEWIPO', [] as any, null, null, NOW);
    expect(e.beatsLast4).toBeNull();
    expect(e.beatsLast4Quarters).toBe(0);
    expect(e.lastSurprisePct).toBeNull();
  });

  it('short denominator for newer tickers (2 quarters ⇒ /2, not /4)', () => {
    const e = assembleEntry('RECENT', H([2.0, -3.0]) as any, null, null, NOW);
    expect(e.beatsLast4).toBe(1);
    expect(e.beatsLast4Quarters).toBe(2);
  });

  it('daysUntil is computed from nextEarningsDate', () => {
    const e = assembleEntry('AAPL', [] as any, '2026-07-17', null, NOW);
    expect(e.daysUntil).toBe(7);
    expect(e.nextEarningsDate).toBe('2026-07-17');
  });
});

describe('handler — daily cache', () => {
  it('same-day cache hit skips Finnhub entirely', async () => {
    const today = new Date().toISOString().slice(0, 10);
    docs[`${_internals.COLLECTION}/AAPL`] = {
      asOfDate: today,
      entry: { ticker: 'AAPL', nextEarningsDate: '2026-07-30', daysUntil: 20, epsEstimateNext: null, beatsLast4: 4, beatsLast4Quarters: 4, lastSurprisePct: 2.5, surpriseHistory: [] },
    };
    const res = await handler(evt({ tickers: 'AAPL' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.radar.AAPL.beatsLast4).toBe(4);
    expect(getEarningsHistoryMock).not.toHaveBeenCalled();
    expect(getUpcomingEarningsMock).not.toHaveBeenCalled();
  });

  it('stale cache (yesterday) refetches and writes through', async () => {
    docs[`${_internals.COLLECTION}/AAPL`] = {
      asOfDate: '2020-01-01',
      entry: { ticker: 'AAPL', beatsLast4: 0, beatsLast4Quarters: 0 },
    };
    getEarningsHistoryMock.mockResolvedValue(H([1.0]));
    getUpcomingEarningsMock.mockResolvedValue({ ticker: 'AAPL', date: '2026-08-01' });
    const res = await handler(evt({ tickers: 'AAPL' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.radar.AAPL.beatsLast4).toBe(1);
    expect(getEarningsHistoryMock).toHaveBeenCalledTimes(1);
    const today = new Date().toISOString().slice(0, 10);
    expect(docs[`${_internals.COLLECTION}/AAPL`].asOfDate).toBe(today);
  });

  it('Finnhub calls acquire the shared token bucket', async () => {
    getEarningsHistoryMock.mockResolvedValue([]);
    getUpcomingEarningsMock.mockResolvedValue(null);
    await handler(evt({ tickers: 'AAPL' }), {} as any);
    expect(acquireMock).toHaveBeenCalledTimes(2); // history + calendar
  });

  it('never caches a fully-empty entry (indistinguishable from a Finnhub failure)', async () => {
    // Post-merge prod finding: a 429-storm moment returned []/null and got
    // pinned as "no data" for the day. Empty entries must be served but
    // NOT cached, so the next request retries.
    getEarningsHistoryMock.mockResolvedValue([]);
    getUpcomingEarningsMock.mockResolvedValue(null);
    const res = await handler(evt({ tickers: 'NVDA' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.radar.NVDA.beatsLast4).toBeNull(); // still served honestly
    expect(docs[`${_internals.COLLECTION}/NVDA`]).toBeUndefined(); // not cached
  });

  it('treats a same-day fully-empty cached entry as a miss (self-heal)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    docs[`${_internals.COLLECTION}/NVDA`] = {
      asOfDate: today,
      entry: { ticker: 'NVDA', nextEarningsDate: null, daysUntil: null, epsEstimateNext: null, beatsLast4: null, beatsLast4Quarters: 0, lastSurprisePct: null, surpriseHistory: [] },
    };
    getEarningsHistoryMock.mockResolvedValue(H([2.0, 1.5, 0.8, 3.1]));
    getUpcomingEarningsMock.mockResolvedValue({ ticker: 'NVDA', date: '2026-08-26' });
    const res = await handler(evt({ tickers: 'NVDA' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(getEarningsHistoryMock).toHaveBeenCalledTimes(1); // refetched despite same-day doc
    expect(body.radar.NVDA.beatsLast4).toBe(4);
    expect(docs[`${_internals.COLLECTION}/NVDA`].entry.beatsLast4).toBe(4); // healed
  });

  it('caches an entry that has a calendar hit even without surprise history', async () => {
    // A real newer ticker: no surprises yet but a known next report —
    // that IS data, cache it.
    getEarningsHistoryMock.mockResolvedValue([]);
    getUpcomingEarningsMock.mockResolvedValue({ ticker: 'NEWIPO', date: '2026-08-15' });
    await handler(evt({ tickers: 'NEWIPO' }), {} as any);
    expect(docs[`${_internals.COLLECTION}/NEWIPO`]).toBeDefined();
  });

  it('400s without tickers', async () => {
    const res = await handler(evt({}), {} as any);
    expect(res!.statusCode).toBe(400);
  });
});
