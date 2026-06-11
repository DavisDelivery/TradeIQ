import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  hashKey,
  pitCacheGet,
  pitCacheSet,
  pitCacheWrap,
  pitCacheGetMany,
  __setDbForTesting,
  type PitCacheKey,
} from '../pit-cache';

// In-memory Firestore fake — minimal surface for what pit-cache touches:
//   db().collection('pitCache').doc(id).get()/.set(...)
//   db().getAll(...refs)
function makeFakeDb() {
  const store = new Map<string, { key: PitCacheKey; value: unknown; createdAt: string }>();

  const makeDocRef = (id: string) => ({
    id,
    async get() {
      const data = store.get(id);
      return {
        exists: data !== undefined,
        data: () => data,
      };
    },
    async set(payload: { key: PitCacheKey; value: unknown; createdAt: string }) {
      store.set(id, payload);
    },
  });

  const fake = {
    collection: (_name: string) => ({
      doc: (id: string) => makeDocRef(id),
    }),
    async getAll(...refs: ReturnType<typeof makeDocRef>[]) {
      return refs.map((r) => {
        const data = store.get(r.id);
        return { exists: data !== undefined, data: () => data };
      });
    },
    // exposed for assertions
    __store: store,
  };
  return fake as unknown as Parameters<typeof __setDbForTesting>[0] & {
    __store: typeof store;
  };
}

describe('pit-cache', () => {
  let fakeDb: ReturnType<typeof makeFakeDb>;

  beforeEach(() => {
    delete process.env.PIT_CACHE_BYPASS;
    fakeDb = makeFakeDb();
    __setDbForTesting(fakeDb as never);
  });

  describe('hashKey', () => {
    it('is deterministic over key field ordering', () => {
      const a: PitCacheKey = {
        provider: 'polygon',
        dataClass: 'fundamentals',
        ticker: 'AAPL',
        asOfDate: '2024-01-15',
      };
      const b: PitCacheKey = {
        asOfDate: '2024-01-15',
        ticker: 'AAPL',
        dataClass: 'fundamentals',
        provider: 'polygon',
      };
      expect(hashKey(a)).toBe(hashKey(b));
    });

    it('differs when any field differs', () => {
      const base: PitCacheKey = {
        provider: 'polygon',
        dataClass: 'fundamentals',
        ticker: 'AAPL',
        asOfDate: '2024-01-15',
      };
      const diff: PitCacheKey = { ...base, asOfDate: '2024-01-16' };
      expect(hashKey(base)).not.toBe(hashKey(diff));
    });

    it('omits undefined fields from canonical form', () => {
      const a: PitCacheKey = {
        provider: 'polygon',
        dataClass: 'bars',
        ticker: 'AAPL',
        asOfDate: '2024-01-15',
      };
      const b: PitCacheKey = { ...a, extra: undefined };
      expect(hashKey(a)).toBe(hashKey(b));
    });
  });

  describe('get/set', () => {
    it('round-trips a value', async () => {
      const key: PitCacheKey = {
        provider: 'finnhub',
        dataClass: 'recommendations',
        ticker: 'MSFT',
        asOfDate: '2023-06-15',
      };
      await pitCacheSet(key, { score: 7, buys: 12 });
      const got = await pitCacheGet<{ score: number; buys: number }>(key);
      expect(got).toEqual({ score: 7, buys: 12 });
    });

    it('returns null on miss', async () => {
      const key: PitCacheKey = {
        provider: 'quiver',
        dataClass: 'political',
        ticker: 'TSLA',
        asOfDate: '2023-10-01',
      };
      expect(await pitCacheGet(key)).toBeNull();
    });
  });

  describe('pitCacheWrap', () => {
    const key: PitCacheKey = {
      provider: 'polygon',
      dataClass: 'fundamentals',
      ticker: 'NVDA',
      asOfDate: '2024-03-01',
    };

    it('calls fetcher on miss, caches result', async () => {
      const fetcher = vi.fn(async () => ({ pe: 28.5 }));
      const got = await pitCacheWrap(key, fetcher);
      expect(got).toEqual({ pe: 28.5 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('skips fetcher on hit', async () => {
      const fetcher = vi.fn(async () => ({ pe: 28.5 }));
      await pitCacheWrap(key, fetcher);
      await pitCacheWrap(key, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('caches different keys independently', async () => {
      const f1 = vi.fn(async () => 'A');
      const f2 = vi.fn(async () => 'B');
      const otherKey: PitCacheKey = { ...key, asOfDate: '2024-03-02' };
      await pitCacheWrap(key, f1);
      await pitCacheWrap(otherKey, f2);
      expect(f1).toHaveBeenCalledTimes(1);
      expect(f2).toHaveBeenCalledTimes(1);
    });

    it('caches null fetcher results too', async () => {
      const fetcher = vi.fn(async () => null);
      const a = await pitCacheWrap(key, fetcher);
      const b = await pitCacheWrap(key, fetcher);
      expect(a).toBeNull();
      expect(b).toBeNull();
      // The wrap should still only call the fetcher once even though it
      // returned null — null is itself a PIT-stable answer.
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('PIT_CACHE_BYPASS=1 forces fetcher every call', async () => {
      process.env.PIT_CACHE_BYPASS = '1';
      const fetcher = vi.fn(async () => 'fresh');
      await pitCacheWrap(key, fetcher);
      await pitCacheWrap(key, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('maturity (M1 — future-window truncation guard)', () => {
    // M1 (2026-06 review): engines cache bars for forward windows (e.g.
    // asOfDate+400d for ML forward returns) under the window's END date.
    // A fetch made before that date returns a TRUNCATED bar array; if
    // the cache honors it forever, forward 60d/252d returns stay null
    // permanently. An entry is mature only when the day it was WRITTEN
    // is strictly after the key's asOfDate; immature entries read as
    // misses so the fetcher re-runs until the window has fully elapsed.
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-fetches when the cached entry was written before its asOfDate elapsed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T14:00:00Z'));
      // ML-row shape: window ends ~400 calendar days in the future.
      const key: PitCacheKey = {
        provider: 'polygon',
        dataClass: 'bars',
        ticker: 'AAPL',
        asOfDate: '2027-07-16',
        extra: 'from=2026-05-12',
      };
      // The provider can only return bars through "today" — truncated.
      const fetcher = vi.fn(async () => [{ t: 1, c: 100 }]);
      await pitCacheWrap(key, fetcher);
      const again = await pitCacheWrap(key, fetcher);
      expect(again).toEqual([{ t: 1, c: 100 }]);
      // Pre-fix behavior: 1 call (truncated array cached forever).
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('treats an entry written ON its asOfDate as immature (intraday fetch may be partial)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T14:00:00Z'));
      const key: PitCacheKey = {
        provider: 'polygon',
        dataClass: 'bars',
        ticker: 'SPY',
        asOfDate: '2026-06-11',
        extra: 'from=2026-01-01:engine-benchmark',
      };
      const fetcher = vi.fn(async () => [{ t: 1, c: 500 }]);
      await pitCacheWrap(key, fetcher);
      await pitCacheWrap(key, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('becomes a durable hit once re-written after the window has elapsed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T14:00:00Z'));
      const key: PitCacheKey = {
        provider: 'polygon',
        dataClass: 'bars',
        ticker: 'MSFT',
        asOfDate: '2026-06-20',
        extra: 'from=2026-05-12',
      };
      const fetcher = vi.fn(async () => [{ t: 1, c: 400 }]);
      // Immature write today...
      await pitCacheWrap(key, fetcher);
      // ...the window elapses...
      vi.setSystemTime(new Date('2026-06-21T14:00:00Z'));
      // ...next read misses, re-fetches, and persists a mature entry...
      await pitCacheWrap(key, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
      // ...which is a hit from then on.
      await pitCacheWrap(key, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('past-window entries hit exactly as before', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T14:00:00Z'));
      const key: PitCacheKey = {
        provider: 'polygon',
        dataClass: 'bars',
        ticker: 'NVDA',
        asOfDate: '2024-03-01',
        extra: 'from=2023-05-06',
      };
      const fetcher = vi.fn(async () => [{ t: 1, c: 90 }]);
      await pitCacheWrap(key, fetcher);
      await pitCacheWrap(key, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('pitCacheGetMany reports immature entries as misses', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T14:00:00Z'));
      const mature: PitCacheKey = {
        provider: 'polygon',
        dataClass: 'bars',
        ticker: 'A',
        asOfDate: '2024-01-01',
      };
      const immature: PitCacheKey = {
        provider: 'polygon',
        dataClass: 'bars',
        ticker: 'B',
        asOfDate: '2027-01-01',
      };
      await pitCacheSet(mature, 'complete');
      await pitCacheSet(immature, 'truncated');
      const got = await pitCacheGetMany<string>([mature, immature]);
      expect(got.get(hashKey(mature))).toEqual({ hit: true, value: 'complete' });
      expect(got.get(hashKey(immature))).toEqual({ hit: false, value: null });
    });
  });

  describe('pitCacheGetMany', () => {
    it('returns map keyed by hashKey, hit flag distinguishes miss from cached-null', async () => {
      const k1: PitCacheKey = {
        provider: 'polygon',
        dataClass: 'fundamentals',
        ticker: 'A',
        asOfDate: '2024-01-01',
      };
      const k2: PitCacheKey = { ...k1, ticker: 'B' };
      const k3: PitCacheKey = { ...k1, ticker: 'C' };
      await pitCacheSet(k1, 'one');
      await pitCacheSet(k3, null);
      const got = await pitCacheGetMany<string>([k1, k2, k3]);
      expect(got.get(hashKey(k1))).toEqual({ hit: true, value: 'one' });
      expect(got.get(hashKey(k2))).toEqual({ hit: false, value: null });
      expect(got.get(hashKey(k3))).toEqual({ hit: true, value: null });
    });

    it('returns empty map for empty input', async () => {
      const got = await pitCacheGetMany([]);
      expect(got.size).toBe(0);
    });
  });
});
