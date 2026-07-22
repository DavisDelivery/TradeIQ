// Locks the searchTickers relevance ranking: Polygon returns matches sorted
// alphabetically by ticker, which buries the intended company under ETFs
// (the "morgan" → JPMorgan BetaBuilders wall). Re-ranking must float the
// common-stock / ticker-prefix match to the top.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchTickers } from '../shared/vector-data';

const origFetch = global.fetch;
afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

function mockPolygon(results: any[]) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results }),
  })) as any;
}

describe('searchTickers ranking', () => {
  it('floats the common-stock name match above the ETF wall ("morgan")', async () => {
    process.env.POLYGON_API_KEY = 'test';
    mockPolygon([
      { ticker: 'BBAG', name: 'JPMorgan BetaBuilders U.S. Aggregate Bond ETF', type: 'ETF' },
      { ticker: 'BBAX', name: 'JPMorgan BetaBuilders Developed Asia ETF', type: 'ETF' },
      { ticker: 'BBCA', name: 'JPMorgan BetaBuilders Canada ETF', type: 'ETF' },
      { ticker: 'MS', name: 'Morgan Stanley', type: 'CS' },
      { ticker: 'MSD', name: 'Morgan Stanley Emerging Markets Debt Fund', type: 'CS' },
    ]);
    const out = await searchTickers('morgan', 12);
    expect(out[0].ticker).toBe('MS');
    expect(out[0].name).toBe('Morgan Stanley');
  });

  it('ranks an exact ticker match first ("MS")', async () => {
    process.env.POLYGON_API_KEY = 'test';
    mockPolygon([
      { ticker: 'MSFT', name: 'Microsoft Corp', type: 'CS' },
      { ticker: 'MSD', name: 'Morgan Stanley Emerging Markets Debt Fund', type: 'CS' },
      { ticker: 'MS', name: 'Morgan Stanley', type: 'CS' },
    ]);
    const out = await searchTickers('MS', 12);
    expect(out[0].ticker).toBe('MS');
  });

  it('returns [] for an empty query without calling Polygon', async () => {
    const spy = vi.fn();
    global.fetch = spy as any;
    const out = await searchTickers('   ', 12);
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
