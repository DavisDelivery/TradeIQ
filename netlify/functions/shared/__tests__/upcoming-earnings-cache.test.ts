// Upcoming-earnings durable cache (staleness audit 2026-08-03, part 2).
//
// The chain this pins: #160 added Finnhub bucket pacing to
// getUpcomingEarnings (correct — the bare fetch caused 429 storms) but left
// it UNCACHED. Prophet stage-2 calls it per name via getEarningsIntel, so
// every 30-minute sieve run paid one 55-rpm token per name: 245s budget ÷
// ~1.1s per token ≈ 224 names — exactly the observed stage-2 ceiling,
// starting exactly the day #160 merged. Pacing without caching just moves a
// burst problem into a throughput problem.
//
// Contract: live answers (including a genuine "no upcoming report") persist
// across containers; a FAILED call is returned as null but NEVER persisted
// ("Finnhub throttled" and "no report scheduled" mean opposite things);
// PIT reads bypass in both directions; a cache hit consumes no bucket token.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  acquire: vi.fn(),
}));

vi.mock('../provider-live-cache', () => ({
  liveCacheGet: h.cacheGet,
  liveCacheSet: h.cacheSet,
}));
vi.mock('../rate-limiter', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return {
    ...orig,
    getFinnhubBucket: () => ({ acquire: h.acquire }),
    fetchWithRateLimit: async (url: string) => ({ res: await fetch(url), rateLimitHits: 0, rateLimitExhausted: false }),
  };
});

import { getUpcomingEarnings } from '../data-provider';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const CAL = { earningsCalendar: [{ date: '2026-08-12', symbol: 'MSFT', hour: 'amc', epsEstimate: 4.3 }] };
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });

const upcomingWrites = () =>
  h.cacheSet.mock.calls.filter((c: any[]) => c[0]?.endpoint === 'calendar/upcoming');

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FINNHUB_API_KEY = 'test';
  h.cacheGet.mockResolvedValue(null);
  h.cacheSet.mockResolvedValue(undefined);
  h.acquire.mockResolvedValue(undefined);
  // Freeze "today" inside the request window so the fixture date qualifies.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));
});

describe('getUpcomingEarnings durable cache', () => {
  it('persists a successful answer', async () => {
    fetchMock.mockImplementation(() => ok(CAL));
    const r = await getUpcomingEarnings('MSFT', 60);
    expect(r?.date).toBe('2026-08-12');
    expect(upcomingWrites()).toHaveLength(1);
    expect(upcomingWrites()[0][1]).toEqual({ v: expect.objectContaining({ date: '2026-08-12' }) });
  });

  it('a cache hit consumes NO bucket token and touches no network — the throughput fix', async () => {
    h.cacheGet.mockResolvedValue({ v: { ticker: 'MSFT', date: '2026-08-12' } });
    const r = await getUpcomingEarnings('MSFT', 60);
    expect(r?.date).toBe('2026-08-12');
    expect(h.acquire).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('persists a genuine "no upcoming report" (null wrapped, distinguishable from a miss)', async () => {
    fetchMock.mockImplementation(() => ok({ earningsCalendar: [] }));
    const r = await getUpcomingEarnings('MSFT', 60);
    expect(r).toBeNull();
    expect(upcomingWrites()).toHaveLength(1);
    expect(upcomingWrites()[0][1]).toEqual({ v: null });
  });

  it('serves a cached null answer without refetching', async () => {
    h.cacheGet.mockResolvedValue({ v: null });
    const r = await getUpcomingEarnings('MSFT', 60);
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('NEVER persists a failed call — throttled is not "no report scheduled"', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 429, json: async () => ({}) }));
    const r = await getUpcomingEarnings('MSFT', 60);
    expect(r).toBeNull();
    expect(upcomingWrites()).toHaveLength(0);
  });

  it('PIT reads (asOfDate) bypass the cache in both directions', async () => {
    fetchMock.mockImplementation(() => ok(CAL));
    await getUpcomingEarnings('MSFT', 60, { asOfDate: '2026-08-03' });
    expect(h.cacheGet).not.toHaveBeenCalled();
    expect(upcomingWrites()).toHaveLength(0);
  });

  it('keys by lookahead window so d45 and d90 are distinct entries', async () => {
    fetchMock.mockImplementation(() => ok(CAL));
    await getUpcomingEarnings('MSFT', 45);
    await getUpcomingEarnings('MSFT', 90);
    const extras = upcomingWrites().map((c: any[]) => c[0].extra);
    expect(extras).toEqual(['d45:v1', 'd90:v1']);
  });
});
