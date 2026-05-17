// Phase 4h W3 — ticker-reference cache + Polygon-fetch contract tests.
//
// Hermetic — Firestore and global.fetch are mocked. Covers:
//   - cache hit avoids the Polygon call
//   - cache miss → Polygon → write-through
//   - bulk enrichment only calls Polygon on misses
//   - Polygon failure falls back to the in-repo universe table

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const docs: Record<string, any> = {};
const setCalls: Array<{ ticker: string; payload: any }> = [];
const getCalls: string[] = [];

vi.mock('../firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: (cn: string) => ({
      doc: (id: string) => ({
        get: async () => {
          getCalls.push(`${cn}/${id}`);
          return {
            exists: docs[`${cn}/${id}`] !== undefined,
            data: () => docs[`${cn}/${id}`],
          };
        },
        set: async (payload: any) => {
          setCalls.push({ ticker: id, payload });
          docs[`${cn}/${id}`] = payload;
        },
      }),
    }),
  })),
}));

// findEntry is used as the local fallback. We mock it minimally so tests
// don't depend on the literal contents of universe.ts.
vi.mock('../universe', () => ({
  findEntry: (ticker: string) => {
    if (ticker === 'AAPL') return { ticker, name: 'Apple', sector: 'Technology', indices: ['sp500'] };
    if (ticker === 'NEW') return { ticker, name: 'NewCo (local)', sector: 'Industrials', indices: [] };
    return undefined;
  },
  // Re-export anything else ticker-reference might transitively pull in.
}));

import { getTickerName, enrichTickerNames, localFallbackName } from '../ticker-reference';

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of Object.keys(docs)) delete docs[k];
  setCalls.length = 0;
  getCalls.length = 0;
  fetchSpy.mockReset();
  (globalThis as any).fetch = fetchSpy;
  process.env.POLYGON_API_KEY = 'test-key';
});

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  delete process.env.POLYGON_API_KEY;
});

function mockPolygonOk(name: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results: { name } }),
  };
}

function mockPolygonFail(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

describe('getTickerName', () => {
  it('returns the cached name without calling Polygon on a hit', async () => {
    docs['tickerReference/AAPL'] = { name: 'Apple Inc.', fetchedAt: '2026-05-17T00:00:00Z' };
    const name = await getTickerName('AAPL');
    expect(name).toBe('Apple Inc.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches from Polygon on a miss and writes back', async () => {
    fetchSpy.mockResolvedValue(mockPolygonOk('Apple Inc.'));
    const name = await getTickerName('AAPL');
    expect(name).toBe('Apple Inc.');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].payload.name).toBe('Apple Inc.');
    expect(setCalls[0].payload.fetchedAt).toBeTypeOf('string');
  });

  it('falls back to the in-repo name when Polygon returns non-ok', async () => {
    fetchSpy.mockResolvedValue(mockPolygonFail(500));
    const name = await getTickerName('AAPL');
    expect(name).toBe('Apple');
    expect(setCalls).toHaveLength(0); // no cache write on Polygon failure
  });

  it('falls back to the ticker symbol when neither cache, Polygon, nor universe has it', async () => {
    fetchSpy.mockResolvedValue(mockPolygonFail(404));
    const name = await getTickerName('UNKNOWN');
    expect(name).toBe('UNKNOWN');
  });
});

describe('enrichTickerNames', () => {
  it('returns an empty map for an empty input', async () => {
    const map = await enrichTickerNames([]);
    expect(map).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves all-cache-hits without calling Polygon', async () => {
    docs['tickerReference/AAPL'] = { name: 'Apple Inc.', fetchedAt: 'x' };
    docs['tickerReference/NEW'] = { name: 'NewCo Corp.', fetchedAt: 'x' };
    const map = await enrichTickerNames(['AAPL', 'NEW']);
    expect(map).toEqual({ AAPL: 'Apple Inc.', NEW: 'NewCo Corp.' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('only calls Polygon for misses; writes them back', async () => {
    docs['tickerReference/AAPL'] = { name: 'Apple Inc.', fetchedAt: 'x' };
    fetchSpy.mockResolvedValue(mockPolygonOk('NewCo from Polygon'));
    const map = await enrichTickerNames(['AAPL', 'NEW']);
    expect(map.AAPL).toBe('Apple Inc.');
    expect(map.NEW).toBe('NewCo from Polygon');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(setCalls.map((c) => c.ticker)).toEqual(['NEW']);
  });

  it('falls back to the in-repo name when Polygon fails on a miss', async () => {
    fetchSpy.mockResolvedValue(mockPolygonFail(429));
    const map = await enrichTickerNames(['NEW']);
    expect(map.NEW).toBe('NewCo (local)');
    expect(setCalls).toHaveLength(0);
  });

  it('dedupes the input list', async () => {
    docs['tickerReference/AAPL'] = { name: 'Apple', fetchedAt: 'x' };
    const map = await enrichTickerNames(['AAPL', 'AAPL', 'AAPL']);
    expect(map).toEqual({ AAPL: 'Apple' });
    expect(getCalls.filter((p) => p === 'tickerReference/AAPL')).toHaveLength(1);
  });
});

describe('localFallbackName', () => {
  it('returns universe entry name when known', () => {
    expect(localFallbackName('AAPL')).toBe('Apple');
  });
  it('returns the ticker itself when unknown', () => {
    expect(localFallbackName('NOPE')).toBe('NOPE');
  });
});
