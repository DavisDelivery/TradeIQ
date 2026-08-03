// Durable Massive fundamentals cache (staleness audit 2026-08-03).
//
// The failure this pins: makeLiveCache is an in-memory Map, so every fresh
// background container refetched 4 Massive HTTP calls per name. The Prophet
// russell/all sieve paid ~1,800 network round-trips per 30-minute run; when
// Massive latency rose (~2026-07-25) stage 2 exhausted its budget at ~220 of
// ~450 names on EVERY run, every snapshot stamped `partial`, partials never
// promote, and both boards froze for ten days while the scanner looked busy.
//
// The contract: live results persist in the Firestore cache across
// containers; failure-shaped results are NEVER persisted (an error-shaped
// empty served for 26h is a lie — 4t-W1c); PIT reads bypass entirely.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock('../provider-live-cache', () => ({
  liveCacheGet: h.cacheGet,
  liveCacheSet: h.cacheSet,
}));

import {
  fetchRatiosWithStatus,
  fetchIncomeStatementsWithStatus,
} from '../massive-fundamentals';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const INCOME_OK = {
  results: [{ tickers: ['AAPL'], period_end: '2026-03-31', revenue: 1 }],
};
const RATIOS_OK = { results: [{ ticker: 'AAPL', pe: 30 }] };

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => '' });
const status = (code: number) =>
  Promise.resolve({ ok: false, status: code, json: async () => ({}), text: async () => 'x' });

const incomeWrites = () =>
  h.cacheSet.mock.calls.filter((c: any[]) => c[0]?.endpoint === 'income-statements');
const ratiosWrites = () =>
  h.cacheSet.mock.calls.filter((c: any[]) => c[0]?.endpoint === 'ratios');

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MASSIVE_FUNDAMENTALS_API_KEY = 'test';
  h.cacheGet.mockResolvedValue(null); // cold
  h.cacheSet.mockResolvedValue(undefined);
});

describe('massive durable live cache', () => {
  it('persists a successful live fetch to the durable cache', async () => {
    fetchMock.mockImplementation(() => ok(INCOME_OK));
    const res = await fetchIncomeStatementsWithStatus('AAPL');
    expect(res.data).toHaveLength(1);
    expect(incomeWrites()).toHaveLength(1);
    // Key carries the request variant so a different limit is a different entry.
    expect(incomeWrites()[0][0].extra).toBe('limit=8:v1');
  });

  it('serves a warm entry without touching the network — the cross-container save', async () => {
    h.cacheGet.mockResolvedValue([{ tickers: ['AAPL'], period_end: '2026-03-31', revenue: 1 }]);
    const res = await fetchIncomeStatementsWithStatus('AAPL');
    expect(res.data).toHaveLength(1);
    expect(res.rateLimited).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('NEVER persists a rate-limited result', async () => {
    fetchMock.mockImplementation(() => status(429));
    const res = await fetchIncomeStatementsWithStatus('AAPL');
    expect(res.rateLimited).toBe(true);
    expect(incomeWrites()).toHaveLength(0);
  });

  it('NEVER persists an errored result', async () => {
    fetchMock.mockImplementation(() => status(500));
    const res = await fetchIncomeStatementsWithStatus('AAPL');
    expect(res.errorMessage).toBeTruthy();
    expect(incomeWrites()).toHaveLength(0);
  });

  it('NEVER persists the identity-mismatch guard result (wrong-company data)', async () => {
    // Non-empty response matching NOTHING = tickers filter ignored upstream.
    fetchMock.mockImplementation(() => ok({ results: [{ tickers: ['DE'], period_end: '2026-03-31' }] }));
    const res = await fetchIncomeStatementsWithStatus('AAPL');
    expect(res.errorMessage).toMatch(/none match/);
    expect(incomeWrites()).toHaveLength(0);
  });

  it('PIT reads (asOfDate) bypass the durable cache in both directions', async () => {
    fetchMock.mockImplementation(() => ok(INCOME_OK));
    await fetchIncomeStatementsWithStatus('AAPL', { asOfDate: '2025-06-30' });
    expect(h.cacheGet).not.toHaveBeenCalled();
    expect(incomeWrites()).toHaveLength(0);
  });

  it('ratios path caches too, keyed by its own endpoint', async () => {
    fetchMock.mockImplementation(() => ok(RATIOS_OK));
    await fetchRatiosWithStatus('AAPL');
    expect(ratiosWrites()).toHaveLength(1);
    expect(ratiosWrites()[0][0].extra).toBe('limit=1:v1');
  });

  it('a cache-layer failure degrades to a plain fetch instead of erroring', async () => {
    h.cacheGet.mockRejectedValue(new Error('firestore down'));
    fetchMock.mockImplementation(() => ok(INCOME_OK));
    const res = await fetchIncomeStatementsWithStatus('AAPL');
    expect(res.data).toHaveLength(1);
  });
});
