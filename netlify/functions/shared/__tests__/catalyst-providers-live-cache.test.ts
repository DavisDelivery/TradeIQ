// 2026-07-15 stale-scan incident, fix #2 — live-cache semantics for the
// catalyst-layer providers (prophet stage 3 / scan-catalyst / analyst-runner).
//
// Contract: live-mode results (including verified-empties) are cached;
// transport-failure nulls are NEVER cached (M8 — an outage must not become
// a sticky "no activity"); PIT calls (asOfDate) bypass the cache entirely;
// values with optional-absent fields survive the Firestore write (JSON
// sanitize strips `undefined`, which Firestore rejects).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const finnhubStatusMock = vi.fn();
vi.mock('../data-provider', () => ({
  getFinnhubInsiderTransactionsWithStatus: (...a: unknown[]) => finnhubStatusMock(...a),
}));
vi.mock('../edgar-roles', () => ({
  lookupInsiderRole: vi.fn(async () => null),
}));

const quiverMock = vi.fn();
vi.mock('../quiver-client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../quiver-client')>();
  return { ...orig, quiverGetTickerWithStatus: (...a: unknown[]) => quiverMock(...a) };
});

import { getInsiderActivity } from '../insider-provider';
import { getPoliticalActivity } from '../political-provider';
import {
  __setLiveCacheDbForTesting,
  __clearLiveCacheL1ForTesting,
  liveCacheSet,
  liveCacheGet,
} from '../provider-live-cache';

function makeFakeDb() {
  const store = new Map<string, any>();
  return {
    collection: (_c: string) => ({
      doc: (id: string) => ({
        async get() {
          const data = store.get(id);
          return { exists: data !== undefined, data: () => data };
        },
        async set(payload: any) {
          // Mirror Firestore's undefined rejection so the sanitize path is
          // actually exercised.
          const scan = (v: any): void => {
            if (v === undefined) throw new Error('undefined not allowed');
            if (Array.isArray(v)) v.forEach(scan);
            else if (v && typeof v === 'object') Object.values(v).forEach(scan);
          };
          scan(payload);
          store.set(id, payload);
        },
      }),
    }),
    __store: store,
  };
}

let fakeDb: ReturnType<typeof makeFakeDb>;

beforeEach(() => {
  finnhubStatusMock.mockReset();
  quiverMock.mockReset();
  fakeDb = makeFakeDb();
  __setLiveCacheDbForTesting(fakeDb as never);
  __clearLiveCacheL1ForTesting();
});

afterEach(() => {
  __setLiveCacheDbForTesting(null);
  __clearLiveCacheL1ForTesting();
});

const TX = {
  name: 'Jane Exec',
  share: 1000,
  change: 1000,
  filingDate: '2026-07-10',
  transactionDate: '2026-07-09',
  transactionPrice: 50,
  transactionCode: 'P',
};

describe('getInsiderActivity live cache', () => {
  it('caches a live result cross-container; second call costs zero provider calls', async () => {
    finnhubStatusMock.mockResolvedValue({ data: [TX], rateLimitExhausted: false });
    const first = await getInsiderActivity('NVDA', 90);
    expect(first?.totalBuys).toBe(1);
    expect(finnhubStatusMock).toHaveBeenCalledTimes(1);

    __clearLiveCacheL1ForTesting(); // simulate a different container
    const second = await getInsiderActivity('NVDA', 90);
    expect(second?.totalBuys).toBe(1);
    expect(finnhubStatusMock).toHaveBeenCalledTimes(1);
  });

  it('caches verified-empty (HTTP 200, zero transactions) — that IS data', async () => {
    finnhubStatusMock.mockResolvedValue({ data: [], rateLimitExhausted: false });
    const first = await getInsiderActivity('SPYX', 90);
    expect(first?.totalBuys).toBe(0);
    __clearLiveCacheL1ForTesting();
    await getInsiderActivity('SPYX', 90);
    expect(finnhubStatusMock).toHaveBeenCalledTimes(1);
  });

  it('NEVER caches a transport-failure null (M8)', async () => {
    finnhubStatusMock.mockResolvedValue({ data: [], rateLimitExhausted: true });
    expect(await getInsiderActivity('NVDA', 90)).toBeNull();
    expect(fakeDb.__store.size).toBe(0);

    // Provider recovers → next call refetches and gets real data.
    finnhubStatusMock.mockResolvedValue({ data: [TX], rateLimitExhausted: false });
    const second = await getInsiderActivity('NVDA', 90);
    expect(second?.totalBuys).toBe(1);
    expect(finnhubStatusMock).toHaveBeenCalledTimes(2);
  });

  it('PIT calls (asOfDate) bypass the cache in both directions', async () => {
    finnhubStatusMock.mockResolvedValue({ data: [TX], rateLimitExhausted: false });
    await getInsiderActivity('NVDA', 90, { asOfDate: '2026-07-10' });
    expect(fakeDb.__store.size).toBe(0); // nothing written
    await getInsiderActivity('NVDA', 90, { asOfDate: '2026-07-10' });
    expect(finnhubStatusMock).toHaveBeenCalledTimes(2); // nothing served
  });

  it('survives optional-absent fields (undefined) via JSON sanitize — the write must not throw-and-skip', async () => {
    // No buys → latestBuy stays undefined on the result object.
    finnhubStatusMock.mockResolvedValue({
      data: [{ ...TX, transactionCode: 'S', share: -500, change: -500 }],
      rateLimitExhausted: false,
    });
    const first = await getInsiderActivity('MSFT', 90);
    expect(first?.latestBuy).toBeUndefined();
    expect(fakeDb.__store.size).toBe(1); // cached despite undefined field

    __clearLiveCacheL1ForTesting();
    await getInsiderActivity('MSFT', 90);
    expect(finnhubStatusMock).toHaveBeenCalledTimes(1); // served from Firestore
  });
});

describe('getPoliticalActivity live cache', () => {
  it('caches success, never caches the subscription-gate null', async () => {
    // All three Quiver endpoints fail (e.g. 403 plan gate) → null, uncached.
    quiverMock.mockResolvedValue({ ok: false, rows: [] });
    expect(await getPoliticalActivity('LMT', 180)).toBeNull();
    expect(fakeDb.__store.size).toBe(0);

    // Plan upgraded / endpoints recover → verified-empty result caches.
    quiverMock.mockResolvedValue({ ok: true, rows: [] });
    const ok = await getPoliticalActivity('LMT', 180);
    expect(ok).not.toBeNull();
    expect(fakeDb.__store.size).toBe(1);

    __clearLiveCacheL1ForTesting();
    const callsBefore = quiverMock.mock.calls.length;
    await getPoliticalActivity('LMT', 180);
    expect(quiverMock.mock.calls.length).toBe(callsBefore); // cache hit, no new calls
  });
});

describe('liveCacheSet sanitize', () => {
  it('strips undefined deeply so Firestore-style writes succeed', async () => {
    const key = { provider: 'x', endpoint: 'y', ticker: 'T' };
    await liveCacheSet(key, { a: 1, b: undefined, c: [{ d: undefined, e: 2 }] });
    expect(fakeDb.__store.size).toBe(1);
    __clearLiveCacheL1ForTesting();
    const back = await liveCacheGet<any>(key, () => 60_000);
    expect(back).toEqual({ a: 1, c: [{ e: 2 }] });
  });
});
