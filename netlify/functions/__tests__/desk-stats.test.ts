// DESK-1 W1 — /api/desk-stats derived-math + batch-resilience tests.
//
// Hermetic — Polygon (getDailyBars), ticker-reference, and Firestore are
// mocked. Covers:
//   - Wilder ATR(14) against a hand-computed fixture
//   - 52w high/low distances (sign conventions: ≤0 vs high, ≥0 vs low)
//   - avgVol20 and 30-close spark
//   - one bad ticker → skipped + warned, batch still succeeds
//   - cache hit (same-day 1Y bars) skips Polygon entirely

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDailyBarsMock = vi.fn();
const getTickerInfoMock = vi.fn();
const docs: Record<string, any> = {};

vi.mock('../shared/data-provider', () => ({
  getDailyBars: (...args: unknown[]) => getDailyBarsMock(...args),
}));

vi.mock('../shared/ticker-reference', () => ({
  getTickerInfo: (...args: unknown[]) => getTickerInfoMock(...args),
}));

vi.mock('../shared/universe', () => ({
  findEntry: (t: string) => (t === 'AAPL' ? { ticker: 'AAPL', name: 'Apple Inc.', sector: 'Technology' } : null),
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
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { handler, wilderAtrPct, deriveStats } from '../desk-stats';

function evt(qs: Record<string, string>) {
  return { httpMethod: 'GET', queryStringParameters: qs } as any;
}

function mkBars(n: number, base = 100): Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> {
  // Deterministic gentle up-trend: close climbs 0.5/day, 2-point daily range.
  const out = [];
  const start = Date.parse('2025-07-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const close = base + i * 0.5;
    out.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000 + i * 10_000,
    });
  }
  return out;
}

beforeEach(() => {
  getDailyBarsMock.mockReset();
  getTickerInfoMock.mockReset();
  for (const k of Object.keys(docs)) delete docs[k];
});

describe('wilderAtrPct', () => {
  it('computes Wilder ATR(14) on a hand-checkable constant-TR fixture', () => {
    // Constant true range: high-low = 2 every day and |high-prevClose| /
    // |low-prevClose| never exceed it (0.5 daily step), so every TR = 2
    // and Wilder smoothing stays exactly 2 regardless of length.
    const bars = mkBars(40);
    const last = bars[bars.length - 1].close; // 100 + 39*0.5 = 119.5
    const expected = +((2 / last) * 100).toFixed(2);
    expect(wilderAtrPct(bars)).toBeCloseTo(expected, 2);
  });

  it('applies Wilder smoothing (not a simple mean) when TR shifts', () => {
    // 14 TRs of 2, then one spike bar with TR 10.
    const bars = mkBars(16);
    const spike = bars[15];
    spike.high = spike.close + 5;
    spike.low = spike.close - 5;
    // seed ATR = 2 over first 14 TRs; next = (2*13 + 10)/14 = 36/14
    const atr = (2 * 13 + 10) / 14;
    const expected = +((atr / spike.close) * 100).toFixed(2);
    expect(wilderAtrPct(bars)).toBeCloseTo(expected, 2);
  });

  it('returns null below the minimum bar count', () => {
    expect(wilderAtrPct(mkBars(10))).toBeNull();
    expect(wilderAtrPct([])).toBeNull();
  });
});

describe('deriveStats', () => {
  const ref = { name: 'Apple Inc.', sector: 'Technology', marketCap: 3e12 };

  it('computes 52w distances with correct signs', () => {
    const bars = mkBars(252);
    const s = deriveStats('AAPL', bars, ref);
    const last = bars[bars.length - 1].close;
    const hi = Math.max(...bars.map((b) => b.high)); // last high = last close + 1
    const lo = Math.min(...bars.map((b) => b.low));
    expect(s.dist52wHighPct).toBeCloseTo(((last - hi) / hi) * 100, 2);
    expect(s.dist52wHighPct!).toBeLessThan(0);   // below the high
    expect(s.dist52wLowPct).toBeCloseTo(((last - lo) / lo) * 100, 2);
    expect(s.dist52wLowPct!).toBeGreaterThan(0); // above the low
  });

  it('computes avgVol20 over the last 20 bars only', () => {
    const bars = mkBars(60);
    const s = deriveStats('AAPL', bars, ref);
    const last20 = bars.slice(-20).map((b) => b.volume);
    expect(s.avgVol20).toBe(Math.round(last20.reduce((a, b) => a + b, 0) / 20));
  });

  it('sparkline is the last 30 closes, oldest → newest', () => {
    const bars = mkBars(100);
    const s = deriveStats('AAPL', bars, ref);
    expect(s.spark).toHaveLength(30);
    expect(s.spark[29]).toBe(bars[99].close);
    expect(s.spark[0]).toBe(bars[70].close);
  });

  it('short history: nulls, never fabricated zeros', () => {
    const bars = mkBars(5);
    const s = deriveStats('NEWIPO', bars, ref);
    expect(s.atrPct14).toBeNull();
    expect(s.spark).toHaveLength(5);
    expect(s.avgVol20).not.toBeNull(); // mean of what exists (5 bars)
  });
});

describe('handler', () => {
  it('400s without tickers', async () => {
    const res = await handler(evt({}), {} as any);
    expect(res!.statusCode).toBe(400);
  });

  it('skips + warns a bad ticker without failing the batch', async () => {
    getTickerInfoMock.mockResolvedValue(null);
    getDailyBarsMock.mockImplementation(async (ticker: string) => {
      if (ticker === 'BAD') throw new Error('polygon 500');
      return mkBars(40).map((b) => ({
        t: Date.parse(`${b.date}T00:00:00Z`), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume,
      }));
    });
    const res = await handler(evt({ tickers: 'AAPL,BAD' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(res!.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.stats.AAPL).toBeDefined();
    expect(body.stats.BAD).toBeUndefined();
    expect(body.warnings).toEqual([{ ticker: 'BAD', error: 'polygon 500' }]);
  });

  it('serves same-day cached 1Y bars without calling Polygon', async () => {
    const today = new Date().toISOString().slice(0, 10);
    docs['priceHistory/AAPL'] = {
      ranges: { '1Y': { asOfDate: today, bars: mkBars(40) } },
    };
    getTickerInfoMock.mockResolvedValue({ name: 'Apple Inc.', marketCap: 3e12, industry: 'Tech' });
    const res = await handler(evt({ tickers: 'AAPL' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.stats.AAPL).toBeDefined();
    expect(getDailyBarsMock).not.toHaveBeenCalled();
  });
});
