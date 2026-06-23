import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLiveQuotes } from '../shared/live-quotes';

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.POLYGON_API_KEY = 'test-key';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function snapshotResponse(tickers: any[]) {
  return { ok: true, json: async () => ({ status: 'OK', tickers }) } as any;
}

describe('getLiveQuotes', () => {
  it('maps lastTrade price + todaysChangePerc', async () => {
    globalThis.fetch = vi.fn(async () =>
      snapshotResponse([
        { ticker: 'AAPL', todaysChangePerc: 1.23, lastTrade: { p: 200.456 }, min: { c: 199 }, day: { c: 198 } },
      ]),
    ) as any;
    const q = await getLiveQuotes(['AAPL']);
    expect(q.AAPL).toEqual({ price: 200.46, changePct: 1.23 });
  });

  it('falls back min.c → day.c → prevDay.c when lastTrade is absent', async () => {
    globalThis.fetch = vi.fn(async () =>
      snapshotResponse([
        { ticker: 'MSFT', todaysChangePerc: -0.5, min: { c: 410.1 }, day: { c: 0 } },
        { ticker: 'NVDA', todaysChangePerc: 2, day: { c: 120.5 } },
        { ticker: 'AMD', prevDay: { c: 99 } },
      ]),
    ) as any;
    const q = await getLiveQuotes(['MSFT', 'NVDA', 'AMD']);
    expect(q.MSFT.price).toBe(410.1);
    expect(q.NVDA.price).toBe(120.5);
    expect(q.AMD).toEqual({ price: 99, changePct: 0 }); // no change% → 0
  });

  it('uppercases + de-dupes input tickers', async () => {
    const fetchMock = vi.fn(async () =>
      snapshotResponse([{ ticker: 'AAPL', lastTrade: { p: 100 }, todaysChangePerc: 0 }]),
    );
    globalThis.fetch = fetchMock as any;
    await getLiveQuotes(['aapl', 'AAPL', ' aapl ']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = (fetchMock.mock.calls[0] as any)[0] as string;
    expect(url).toContain('tickers=AAPL');
    expect(url).not.toContain('AAPL,AAPL');
  });

  it('chunks at 100 tickers per upstream call', async () => {
    const fetchMock = vi.fn(async () => snapshotResponse([]));
    globalThis.fetch = fetchMock as any;
    const many = Array.from({ length: 250 }, (_, i) => `T${i}`);
    await getLiveQuotes(many);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 100 + 100 + 50
  });

  it('skips a failed chunk but keeps successful ones', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 500, json: async () => ({}) } as any;
      return snapshotResponse([{ ticker: 'ZZZ', lastTrade: { p: 5 }, todaysChangePerc: 1 }]);
    }) as any;
    const many = Array.from({ length: 150 }, (_, i) => `T${i}`);
    const q = await getLiveQuotes(many);
    // First chunk 500'd; second chunk returned ZZZ.
    expect(q.ZZZ.price).toBe(5);
  });

  it('omits tickers with no usable/zero price', async () => {
    globalThis.fetch = vi.fn(async () =>
      snapshotResponse([
        { ticker: 'GOOD', lastTrade: { p: 10 }, todaysChangePerc: 0 },
        { ticker: 'ZERO', day: { c: 0 }, prevDay: { c: 0 } },
        { ticker: 'NOPRICE', todaysChangePerc: 3 },
      ]),
    ) as any;
    const q = await getLiveQuotes(['GOOD', 'ZERO', 'NOPRICE']);
    expect(q.GOOD).toBeDefined();
    expect(q.ZERO).toBeUndefined();
    expect(q.NOPRICE).toBeUndefined();
  });

  it('returns empty for empty input without calling fetch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    const q = await getLiveQuotes([]);
    expect(q).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
