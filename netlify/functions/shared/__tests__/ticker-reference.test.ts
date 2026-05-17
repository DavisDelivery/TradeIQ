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

import {
  getTickerName,
  enrichTickerNames,
  localFallbackName,
  getTickerInfo,
  _internals,
} from '../ticker-reference';

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

// Phase 4j — full-info Polygon response. The endpoint is the same as 4h's
// (/v3/reference/tickers/{ticker}); 4j just extracts more fields from it.
function mockPolygonInfo(overrides: Record<string, any> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: {
        name: 'Apple Inc.',
        description: 'Apple designs, manufactures, and markets consumer electronics.',
        homepage_url: 'https://www.apple.com',
        total_employees: 164000,
        market_cap: 3000000000000,
        list_date: '1980-12-12',
        sic_description: 'ELECTRONIC COMPUTERS',
        branding: {
          logo_url: 'https://api.polygon.io/branding/apple-logo.svg',
          icon_url: 'https://api.polygon.io/branding/apple-icon.png',
        },
        ...overrides,
      },
    }),
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

// ---------------------------------------------------------------------------
// Phase 4j W1 — getTickerInfo: full company info + 4h-doc migration.
// ---------------------------------------------------------------------------

describe('getTickerInfo', () => {
  it('returns the cached full info when schemaV is current', async () => {
    docs['tickerReference/AAPL'] = {
      name: 'Apple Inc.',
      description: 'Apple makes things.',
      homepageUrl: 'https://www.apple.com',
      employees: 164000,
      marketCap: 3000000000000,
      listDate: '1980-12-12',
      industry: 'ELECTRONIC COMPUTERS',
      logoUrl: 'https://api.polygon.io/logo?apiKey=k',
      schemaV: _internals.SCHEMA_V,
      fetchedAt: '2026-05-17T00:00:00Z',
    };
    const info = await getTickerInfo('AAPL');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(info).not.toBeNull();
    expect(info!.name).toBe('Apple Inc.');
    expect(info!.description).toBe('Apple makes things.');
    expect(info!.industry).toBe('ELECTRONIC COMPUTERS');
    expect(info!.employees).toBe(164000);
    expect(info!.marketCap).toBe(3000000000000);
    expect(info!.listDate).toBe('1980-12-12');
    expect(info!.homepageUrl).toBe('https://www.apple.com');
    expect(info!.logoUrl).toBe('https://api.polygon.io/logo?apiKey=k');
  });

  it('on a true cache miss fetches from Polygon and writes back with current schemaV', async () => {
    fetchSpy.mockResolvedValue(mockPolygonInfo());
    const info = await getTickerInfo('AAPL');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(info!.name).toBe('Apple Inc.');
    expect(info!.description).toContain('Apple');
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].payload.schemaV).toBe(_internals.SCHEMA_V);
    expect(setCalls[0].payload.description).toBeTypeOf('string');
    // Polygon key is appended to logo URL so the browser can load it
    // without a 401 from Polygon's branding endpoint.
    expect(setCalls[0].payload.logoUrl).toContain('apiKey=');
  });

  it('treats a 4h-era doc (no schemaV, no description) as a miss → refetches', async () => {
    // This is THE migration guarantee. Without it, every russell2k ticker
    // already cached by Phase 4h would show a permanently blank
    // description in the detail panel.
    docs['tickerReference/AAPL'] = {
      name: 'Apple Inc.',
      fetchedAt: '2026-05-10T00:00:00Z',
    };
    fetchSpy.mockResolvedValue(mockPolygonInfo());
    const info = await getTickerInfo('AAPL');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(info!.description).toContain('Apple');
    // Write-through replaces the old doc with the v2 shape.
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].payload.schemaV).toBe(_internals.SCHEMA_V);
    expect(setCalls[0].payload.description).toBeTypeOf('string');
  });

  it('serves cached info on a repeat call without re-fetching', async () => {
    fetchSpy.mockResolvedValue(mockPolygonInfo());
    await getTickerInfo('AAPL');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await getTickerInfo('AAPL');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no second call
  });

  it('falls back to a name-only info when Polygon returns non-ok on a miss', async () => {
    fetchSpy.mockResolvedValue(mockPolygonFail(500));
    const info = await getTickerInfo('AAPL');
    expect(info!.name).toBe('Apple'); // from local universe fallback
    expect(info!.description).toBeNull();
    expect(info!.industry).toBeNull();
    expect(setCalls).toHaveLength(0); // no cache write on Polygon failure
  });

  it('keeps the stale 4h name when Polygon fails on migration', async () => {
    // If a 4h doc exists with a name and Polygon fails on the migration
    // refetch, return the stale name rather than wiping it back to the
    // bare ticker symbol — the detail-panel header still reads sensibly.
    docs['tickerReference/AAPL'] = {
      name: 'Apple Inc.',
      fetchedAt: '2026-05-10T00:00:00Z',
    };
    fetchSpy.mockResolvedValue(mockPolygonFail(503));
    const info = await getTickerInfo('AAPL');
    expect(info!.name).toBe('Apple Inc.');
    expect(info!.description).toBeNull();
    expect(setCalls).toHaveLength(0);
  });

  it('returns a name-only info for an unknown ticker Polygon cannot resolve', async () => {
    fetchSpy.mockResolvedValue(mockPolygonFail(404));
    const info = await getTickerInfo('UNKNOWN');
    expect(info).not.toBeNull();
    expect(info!.name).toBe('UNKNOWN');
    expect(info!.description).toBeNull();
  });

  it('handles Polygon responses with missing branding gracefully', async () => {
    fetchSpy.mockResolvedValue(
      mockPolygonInfo({ branding: undefined, total_employees: undefined }),
    );
    const info = await getTickerInfo('AAPL');
    expect(info!.logoUrl).toBeNull();
    expect(info!.employees).toBeNull();
    // Required field still present
    expect(info!.name).toBe('Apple Inc.');
  });
});

describe('getTickerName + 4h doc compatibility', () => {
  it('still serves the cached name from a 4h doc without refetching', async () => {
    // getTickerName is on the scan hot path — we don't want to schema-
    // migrate thousands of cached docs every scan just because 4j added
    // new fields. Migration is lazy and only triggered through
    // getTickerInfo on detail-panel opens.
    docs['tickerReference/AAPL'] = {
      name: 'Apple Inc.',
      fetchedAt: '2026-05-10T00:00:00Z',
    };
    const name = await getTickerName('AAPL');
    expect(name).toBe('Apple Inc.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
