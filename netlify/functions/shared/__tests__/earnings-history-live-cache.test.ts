// 2026-07-15 stale-board fix — LIVE cache semantics for getEarningsHistory.
//
// Contract under test (the fix for prophet's chronic stage-2 partial /
// lynch-sp500's container death after #105's bucket pacing):
//   - live calls (no asOfDate) hit Firestore first; a warm entry costs
//     ZERO Finnhub calls;
//   - success-shaped results are written through (including legit empties,
//     which get a shorter TTL);
//   - failure-shaped results (HTTP !ok) are NEVER cached (M8);
//   - join-degraded results (announce join requested but calendar failed)
//     are served fresh but not persisted;
//   - PIT calls (asOfDate) bypass the live cache entirely;
//   - expired entries refetch (empty TTL 6h < non-empty TTL 26h).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getEarningsHistory } from '../data-provider';
import { _resetFinnhubBucketForTests } from '../rate-limiter';
import {
  __setLiveCacheDbForTesting,
  __clearLiveCacheL1ForTesting,
  liveCacheId,
  type LiveCacheKey,
} from '../provider-live-cache';

const ORIGINAL_FETCH = globalThis.fetch;

interface FakeDoc {
  key: LiveCacheKey;
  value: unknown;
  createdAt: string;
}

function makeFakeDb() {
  const store = new Map<string, FakeDoc>();
  const failures = { read: false, write: false };
  const makeDocRef = (id: string) => ({
    id,
    async get() {
      if (failures.read) throw new Error('firestore read down');
      const data = store.get(id);
      return { exists: data !== undefined, data: () => data };
    },
    async set(payload: FakeDoc) {
      if (failures.write) throw new Error('firestore write down');
      store.set(id, payload);
    },
  });
  return {
    collection: (_name: string) => ({ doc: (id: string) => makeDocRef(id) }),
    __store: store,
    __failures: failures,
  };
}

const SURPRISES = [
  { period: '2026-03-31', year: 2026, quarter: 1, actual: 2.1, estimate: 1.9, surprisePercent: 10.5 },
  { period: '2025-12-31', year: 2025, quarter: 4, actual: 1.8, estimate: 1.8, surprisePercent: 0 },
];

function mockFinnhub(handlers: { surprises?: unknown; surprisesStatus?: number; calendar?: unknown }) {
  const calls = { stock: 0, calendar: 0 };
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/stock/earnings')) {
      calls.stock += 1;
      const status = handlers.surprisesStatus ?? 200;
      return {
        ok: status === 200,
        status,
        headers: { get: () => 'application/json' },
        json: async () => handlers.surprises ?? [],
        text: async () => JSON.stringify(handlers.surprises ?? []),
      } as any;
    }
    calls.calendar += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => handlers.calendar ?? { earningsCalendar: [] },
      text: async () => JSON.stringify(handlers.calendar ?? { earningsCalendar: [] }),
    } as any;
  }) as any;
  return calls;
}

let fakeDb: ReturnType<typeof makeFakeDb>;

beforeEach(() => {
  process.env.FINNHUB_API_KEY = 'test-finn';
  _resetFinnhubBucketForTests();
  fakeDb = makeFakeDb();
  __setLiveCacheDbForTesting(fakeDb as never);
  __clearLiveCacheL1ForTesting();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  __setLiveCacheDbForTesting(null);
  __clearLiveCacheL1ForTesting();
  vi.useRealTimers();
});

const KEY: LiveCacheKey = {
  provider: 'finnhub',
  endpoint: 'stock/earnings',
  ticker: 'NVDA',
  extra: 'limit=8:join=0',
};

describe('getEarningsHistory live cache', () => {
  it('caches a non-empty live result; second call costs zero Finnhub calls (Firestore-only, across L1 clear)', async () => {
    const calls = mockFinnhub({ surprises: SURPRISES });

    const first = await getEarningsHistory('NVDA', 8);
    expect(first).toHaveLength(2);
    expect(calls.stock).toBe(1);
    expect(fakeDb.__store.has(liveCacheId(KEY))).toBe(true);

    // Clear L1 to prove the FIRESTORE layer serves cross-container reads.
    __clearLiveCacheL1ForTesting();
    const second = await getEarningsHistory('NVDA', 8);
    expect(second).toEqual(first);
    expect(calls.stock).toBe(1); // no new provider call
  });

  it('serves cached legit-empty within its short TTL, refetches after 6h', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T01:00:00Z'));
    const calls = mockFinnhub({ surprises: [] });

    expect(await getEarningsHistory('SPYETF', 8)).toEqual([]);
    expect(calls.stock).toBe(1);

    // Within 6h → served from cache.
    vi.setSystemTime(new Date('2026-07-15T05:00:00Z'));
    expect(await getEarningsHistory('SPYETF', 8)).toEqual([]);
    expect(calls.stock).toBe(1);

    // Past the 6h empty TTL → refetch.
    vi.setSystemTime(new Date('2026-07-15T07:30:00Z'));
    expect(await getEarningsHistory('SPYETF', 8)).toEqual([]);
    expect(calls.stock).toBe(2);
  });

  it('never caches a failure-shaped result (HTTP !ok) and never serves one', async () => {
    const calls = mockFinnhub({ surprisesStatus: 500 });
    expect(await getEarningsHistory('NVDA', 8)).toEqual([]);
    expect(calls.stock).toBe(1);
    expect(fakeDb.__store.size).toBe(0);

    // A later call retries the provider rather than serving a poisoned entry.
    expect(await getEarningsHistory('NVDA', 8)).toEqual([]);
    expect(calls.stock).toBe(2);
  });

  it('PIT calls (asOfDate) bypass the live cache in both directions', async () => {
    const calls = mockFinnhub({
      surprises: SURPRISES,
      calendar: { earningsCalendar: [{ date: '2026-04-24', symbol: 'NVDA' }] },
    });
    // Seed the live cache first via a live call.
    await getEarningsHistory('NVDA', 8);
    expect(calls.stock).toBe(1);

    // PIT read: must hit the provider (not the live entry) and must not
    // add live-cache entries beyond the seeded one.
    const before = fakeDb.__store.size;
    await getEarningsHistory('NVDA', 8, { asOfDate: '2026-05-01' });
    expect(calls.stock).toBe(2);
    expect(fakeDb.__store.size).toBe(before);
  });

  it('join-degraded results (announce join asked, calendar empty) are served but not persisted', async () => {
    const calls = mockFinnhub({ surprises: SURPRISES, calendar: { earningsCalendar: [] } });
    const rows = await getEarningsHistory('NVDA', 8, { withAnnounceDates: true });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.announceDate === null)).toBe(true);
    expect(calls.stock).toBe(1);
    expect(fakeDb.__store.size).toBe(0); // not cached

    __clearLiveCacheL1ForTesting();
    await getEarningsHistory('NVDA', 8, { withAnnounceDates: true });
    expect(calls.stock).toBe(2); // refetched, no poisoned join-less entry
  });

  it('degrades to a plain fetch when Firestore is down (read AND write failures)', async () => {
    const calls = mockFinnhub({ surprises: SURPRISES });
    fakeDb.__failures.read = true;
    fakeDb.__failures.write = true;

    const rows = await getEarningsHistory('NVDA', 8);
    expect(rows).toHaveLength(2);
    expect(calls.stock).toBe(1);
    // Note: the L1 memo still serves within-process repeats even with
    // Firestore down — that's intended (best-effort caching).
  });
});
