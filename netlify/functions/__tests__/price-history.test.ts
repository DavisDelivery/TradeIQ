// Phase 4j W3 — /api/price-history endpoint tests.
//
// Hermetic — Polygon (via getDailyBars) and Firestore (via firebase-admin)
// are mocked. Covers:
//   - range → from-date math (1M, 6M, 1Y, All)
//   - cache miss → Polygon → write-through
//   - cache hit on the same day serves without re-fetching
//   - empty/sparse bars (delisted, illiquid russell2k names)
//   - invalid range / missing ticker validation

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDailyBarsMock = vi.fn();
const docs: Record<string, any> = {};
const setCalls: Array<{ path: string; payload: any; opts?: any }> = [];

vi.mock('../shared/data-provider', () => ({
  getDailyBars: (...args: unknown[]) => getDailyBarsMock(...args),
}));

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (cn: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: docs[`${cn}/${id}`] !== undefined,
          data: () => docs[`${cn}/${id}`],
        }),
        set: async (payload: any, opts?: any) => {
          const path = `${cn}/${id}`;
          setCalls.push({ path, payload, opts });
          // Mimic Firestore's merge semantics for the deep `ranges` map.
          if (opts?.merge && docs[path]) {
            docs[path] = {
              ...docs[path],
              ranges: { ...(docs[path].ranges ?? {}), ...(payload.ranges ?? {}) },
            };
          } else {
            docs[path] = payload;
          }
        },
      }),
    }),
  }),
}));

vi.mock('../shared/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { handler, computeFrom, _internals } from '../price-history';

function evt(qs: Record<string, string>) {
  return {
    httpMethod: 'GET',
    queryStringParameters: qs,
    headers: {},
    body: null,
  } as any;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Helper - synthesize a Polygon Bar at a given trading day's UTC midnight.
function bar(date: string, close: number) {
  return {
    t: Date.parse(`${date}T00:00:00Z`),
    o: close - 1,
    h: close + 1,
    l: close - 2,
    c: close,
    v: 1_000_000,
  };
}

beforeEach(() => {
  for (const k of Object.keys(docs)) delete docs[k];
  setCalls.length = 0;
  getDailyBarsMock.mockReset();
});

// ---------------------------------------------------------------------------
// Range math (pure function, no I/O)
// ---------------------------------------------------------------------------

describe('computeFrom', () => {
  it('1M → 30 days back from today', () => {
    expect(computeFrom('1M', '2026-05-17')).toBe('2026-04-17');
  });

  it('6M → 182 days back from today', () => {
    expect(computeFrom('6M', '2026-05-17')).toBe('2025-11-16');
  });

  it('1Y → 365 days back from today', () => {
    expect(computeFrom('1Y', '2026-05-17')).toBe('2025-05-17');
  });

  it('All → fixed far-back date (2000-01-01)', () => {
    expect(computeFrom('All', '2026-05-17')).toBe(_internals.ALL_RANGE_FROM);
  });

  it('handles year-rollover when subtracting days', () => {
    expect(computeFrom('1M', '2026-01-15')).toBe('2025-12-16');
  });
});

// ---------------------------------------------------------------------------
// Endpoint behavior
// ---------------------------------------------------------------------------

describe('GET /api/price-history', () => {
  it('returns 400 when ticker is missing', async () => {
    const res = await handler(evt({}), {} as any, () => {});
    expect((res as any).statusCode).toBe(400);
    expect(getDailyBarsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid range', async () => {
    const res = await handler(evt({ ticker: 'AAPL', range: '5Y' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(400);
    const body = JSON.parse((res as any).body);
    expect(body.error).toMatch(/invalid range/i);
    expect(getDailyBarsMock).not.toHaveBeenCalled();
  });

  it('defaults to 6M when range is omitted (Chad-default)', async () => {
    getDailyBarsMock.mockResolvedValue([bar('2026-05-15', 100), bar('2026-05-16', 101)]);
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body.range).toBe('6M');
    expect(body.bars).toHaveLength(2);
    // Verify the from-date math used was ~182 days back from today.
    const callArgs = getDailyBarsMock.mock.calls[0];
    expect(callArgs[0]).toBe('AAPL');
    const expectedFrom = computeFrom('6M', todayUtc());
    expect(callArgs[1]).toBe(expectedFrom);
  });

  it('on a cache miss fetches from Polygon and writes through', async () => {
    getDailyBarsMock.mockResolvedValue([bar('2026-05-15', 100)]);
    const res = await handler(evt({ ticker: 'AAPL', range: '1M' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body.cached).toBe(false);
    expect(body.bars).toHaveLength(1);
    expect(body.bars[0]).toEqual({
      date: '2026-05-15',
      open: 99,
      high: 101,
      low: 98,
      close: 100,
      volume: 1_000_000,
    });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].path).toBe('priceHistory/AAPL');
    expect(setCalls[0].opts?.merge).toBe(true); // merge so ranges accumulate
  });

  it('serves from cache when the doc is stamped today', async () => {
    const today = todayUtc();
    docs['priceHistory/AAPL'] = {
      ranges: {
        '6M': {
          asOfDate: today,
          bars: [{ date: '2026-05-15', open: 99, high: 101, low: 98, close: 100, volume: 1 }],
        },
      },
    };
    const res = await handler(evt({ ticker: 'AAPL', range: '6M' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body.cached).toBe(true);
    expect(body.bars).toHaveLength(1);
    expect(getDailyBarsMock).not.toHaveBeenCalled(); // crucial - no Polygon call on hit
  });

  it('refetches when the cached stamp is older than today', async () => {
    docs['priceHistory/AAPL'] = {
      ranges: {
        '6M': {
          asOfDate: '2025-01-01', // stale
          bars: [{ date: '2025-01-01', open: 1, high: 1, low: 1, close: 1, volume: 1 }],
        },
      },
    };
    getDailyBarsMock.mockResolvedValue([bar('2026-05-15', 100)]);
    const res = await handler(evt({ ticker: 'AAPL', range: '6M' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    expect(getDailyBarsMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((res as any).body);
    expect(body.cached).toBe(false);
    expect(body.bars[0].date).toBe('2026-05-15');
  });

  it('caches independently per range - 1M and 6M coexist on the same doc', async () => {
    getDailyBarsMock.mockResolvedValue([bar('2026-05-15', 100)]);
    await handler(evt({ ticker: 'AAPL', range: '1M' }), {} as any, () => {});
    await handler(evt({ ticker: 'AAPL', range: '6M' }), {} as any, () => {});
    // Both writes target the same doc with merge:true; both ranges land.
    expect(setCalls).toHaveLength(2);
    expect(docs['priceHistory/AAPL'].ranges['1M']).toBeDefined();
    expect(docs['priceHistory/AAPL'].ranges['6M']).toBeDefined();
  });

  it('returns an empty bars array for an illiquid / delisted ticker without crashing', async () => {
    getDailyBarsMock.mockResolvedValue([]);
    const res = await handler(evt({ ticker: 'DELISTED', range: '1Y' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body.bars).toEqual([]);
  });

  it('returns 500 when Polygon throws', async () => {
    getDailyBarsMock.mockRejectedValue(new Error('Polygon bars AAPL: 500'));
    const res = await handler(evt({ ticker: 'AAPL', range: '1M' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(500);
    const body = JSON.parse((res as any).body);
    expect(body.error).toContain('Polygon');
  });

  it('uppercases the ticker before lookup and caching', async () => {
    getDailyBarsMock.mockResolvedValue([bar('2026-05-15', 100)]);
    await handler(evt({ ticker: 'aapl', range: '1M' }), {} as any, () => {});
    expect(getDailyBarsMock).toHaveBeenCalledWith('AAPL', expect.any(String), expect.any(String));
    expect(setCalls[0].path).toBe('priceHistory/AAPL');
  });

  it('uses ALL_RANGE_FROM for range=All', async () => {
    getDailyBarsMock.mockResolvedValue([bar('2003-01-02', 50)]);
    await handler(evt({ ticker: 'AAPL', range: 'All' }), {} as any, () => {});
    const callArgs = getDailyBarsMock.mock.calls[0];
    expect(callArgs[1]).toBe(_internals.ALL_RANGE_FROM);
  });
});
