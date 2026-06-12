// Track-3 M1 (Wave 2) — bar windows that end today or in the future must
// NOT be persisted to the (TTL-less) PIT cache: the provider only returns
// bars through today, so a frozen window stays truncated forever and forward
// returns / IC samples are permanently lossy on re-runs.
//
// Platform-faithful: the PIT cache is an in-memory store with REAL
// read-through/write semantics (Wave 5 policy — not a mock that pins
// behavior). The assertions exercise the actual getCachedBars caching
// decision end-to-end.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Faithful in-memory PIT cache (read-through, write-on-miss), so we can
// observe whether a given window was persisted and re-served.
const cacheStore = new Map<string, unknown>();
const sets: string[] = [];
function keyId(k: any): string {
  return [k.provider, k.dataClass, k.ticker, k.asOfDate, k.extra].join('|');
}
vi.mock('../../pit-cache', () => ({
  pitCacheWrap: async (key: any, fetcher: () => Promise<unknown>) => {
    const id = keyId(key);
    if (cacheStore.has(id)) return cacheStore.get(id);
    const fresh = await fetcher();
    cacheStore.set(id, fresh);
    sets.push(id);
    return fresh;
  },
}));

const getDailyBars = vi.fn(async (_t: string, from: string, to: string) => [
  { o: 1, h: 1, l: 1, c: 1, v: 1, t: Date.parse(from) },
  { o: 1, h: 1, l: 1, c: 1, v: 1, t: Date.parse(to) },
]);
vi.mock('../../data-provider', () => ({
  getDailyBars: (...a: any[]) => (getDailyBars as any)(...a),
}));

import { barWindowIsImmutable, getCachedBars } from '../engine';

beforeEach(() => {
  cacheStore.clear();
  sets.length = 0;
  getDailyBars.mockClear();
});

describe('barWindowIsImmutable (Track-3 M1)', () => {
  const today = '2026-06-12';
  it('is immutable only when the window ends strictly before the injected fetch date', () => {
    expect(barWindowIsImmutable('2026-06-11', today)).toBe(true); // yesterday → cacheable
    expect(barWindowIsImmutable('2026-06-12', today)).toBe(false); // today → still growing
    expect(barWindowIsImmutable('2026-09-15', today)).toBe(false); // future (asOf+400) → not cacheable
  });

  it('treats the window as immutable when no fetch date is injected (engine stays wall-clock-free)', () => {
    // walk-forward integrity: the module must not read wall-clock. Historical
    // callers omit todayIso → conservative cache (pre-M1 behavior); live entry
    // points inject it so real runs get the guard.
    expect(barWindowIsImmutable('2026-09-15')).toBe(true);
  });
});

describe('getCachedBars — never persists a future/today window (todayIso injected)', () => {
  const TODAY = '2026-06-12';
  it('caches a fully-historical window (fetch once, re-served from cache)', async () => {
    await getCachedBars('AAPL', '2018-01-01', '2019-03-31', TODAY);
    await getCachedBars('AAPL', '2018-01-01', '2019-03-31', TODAY);
    expect(getDailyBars).toHaveBeenCalledTimes(1); // second call hit the cache
    expect(sets).toHaveLength(1);
  });

  it('does NOT cache a window whose `to` is in the future — refetches every time', async () => {
    await getCachedBars('AAPL', '2026-01-01', '2026-09-15', TODAY);
    await getCachedBars('AAPL', '2026-01-01', '2026-09-15', TODAY);
    // Fresh fetch each time; the truncated future window is never frozen.
    expect(getDailyBars).toHaveBeenCalledTimes(2);
    expect(sets).toHaveLength(0);
  });

  it('does NOT cache a window ending today (today’s bar still grows)', async () => {
    await getCachedBars('AAPL', '2025-01-01', TODAY, TODAY);
    await getCachedBars('AAPL', '2025-01-01', TODAY, TODAY);
    expect(getDailyBars).toHaveBeenCalledTimes(2);
    expect(sets).toHaveLength(0);
  });
});
