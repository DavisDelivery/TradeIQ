// DESK-1 W1 — /api/price-history 1D/5D intraday extension tests.
//
// Covers:
//   - 1D fetches minute bars and slices to the last session
//   - 5D fetches 5-minute bars across the last 5 sessions
//   - plan rejection (unauthorized) degrades to daily bars +
//     intradayUnavailable: true — the chart NEVER errors
//   - 5-minute cache TTL: fresh hit serves cache, stale refetches
//   - daily ranges are untouched (regression guard on computeFrom)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDailyBarsMock = vi.fn();
const getIntradayMock = vi.fn();
const docs: Record<string, any> = {};

vi.mock('../shared/data-provider', () => ({
  getDailyBars: (...args: unknown[]) => getDailyBarsMock(...args),
  getIntradayBarsWithStatus: (...args: unknown[]) => getIntradayMock(...args),
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

import { handler, computeFrom, sliceToLastSessions } from '../price-history';
import { INTRADAY_TTL_MS } from '../shared/price-history-cache';

function evt(qs: Record<string, string>) {
  return { httpMethod: 'GET', queryStringParameters: qs } as any;
}

/** Minute bars across N sessions, `perSession` bars each. */
function mkMinuteBars(sessions: string[], perSession = 3) {
  const out: any[] = [];
  for (const day of sessions) {
    const base = Date.parse(`${day}T14:30:00Z`);
    for (let i = 0; i < perSession; i++) {
      out.push({ t: base + i * 60_000, o: 100, h: 101, l: 99, c: 100.5, v: 1000 });
    }
  }
  return out;
}

beforeEach(() => {
  getDailyBarsMock.mockReset();
  getIntradayMock.mockReset();
  for (const k of Object.keys(docs)) delete docs[k];
});

describe('sliceToLastSessions', () => {
  it('keeps only bars from the last N distinct dates', () => {
    const bars = mkMinuteBars(['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10']);
    expect(sliceToLastSessions(bars, 1)).toHaveLength(3);
    expect(sliceToLastSessions(bars, 5)).toHaveLength(15);
    expect(new Set(sliceToLastSessions(bars, 2).map((b) => new Date(b.t).toISOString().slice(0, 10))))
      .toEqual(new Set(['2026-07-09', '2026-07-10']));
  });
});

describe('1D / 5D ranges', () => {
  it('1D returns minute bars for the most recent session only', async () => {
    getIntradayMock.mockResolvedValue({
      bars: mkMinuteBars(['2026-07-09', '2026-07-10'], 4),
      unauthorized: false,
    });
    const res = await handler(evt({ ticker: 'AAPL', range: '1D' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.ok).toBe(true);
    expect(body.intradayUnavailable).toBeUndefined();
    expect(body.bars).toHaveLength(4);
    // Intraday bars carry a time component in `date`.
    expect(body.bars[0].date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(getIntradayMock).toHaveBeenCalledWith('AAPL', 1, 'minute', expect.any(String), expect.any(String));
  });

  it('5D requests 5-minute aggregates', async () => {
    getIntradayMock.mockResolvedValue({ bars: mkMinuteBars(['2026-07-10']), unauthorized: false });
    await handler(evt({ ticker: 'AAPL', range: '5D' }), {} as any);
    expect(getIntradayMock).toHaveBeenCalledWith('AAPL', 5, 'minute', expect.any(String), expect.any(String));
  });

  it('degrades to daily bars + intradayUnavailable when the plan rejects intraday', async () => {
    getIntradayMock.mockResolvedValue({ bars: [], unauthorized: true });
    getDailyBarsMock.mockResolvedValue([
      { t: Date.parse('2026-07-09T00:00:00Z'), o: 100, h: 101, l: 99, c: 100.5, v: 5_000_000 },
    ]);
    const res = await handler(evt({ ticker: 'AAPL', range: '1D' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(res!.statusCode).toBe(200);          // never errors the chart
    expect(body.ok).toBe(true);
    expect(body.intradayUnavailable).toBe(true);
    expect(body.bars).toHaveLength(1);
    expect(body.bars[0].date).toBe('2026-07-09'); // daily-shaped
  });

  it('serves a fresh (<5 min) intraday cache without refetching', async () => {
    const today = new Date().toISOString().slice(0, 10);
    docs['priceHistory/AAPL'] = {
      ranges: {
        '1D': {
          asOfDate: today,
          asOfMs: Date.now() - 60_000, // 1 minute old
          bars: [{ date: `${today} 14:30`, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
        },
      },
    };
    const res = await handler(evt({ ticker: 'AAPL', range: '1D' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.cached).toBe(true);
    expect(getIntradayMock).not.toHaveBeenCalled();
  });

  it('refetches when the intraday cache is past its 5-minute TTL', async () => {
    const today = new Date().toISOString().slice(0, 10);
    docs['priceHistory/AAPL'] = {
      ranges: {
        '1D': {
          asOfDate: today,
          asOfMs: Date.now() - INTRADAY_TTL_MS - 1_000,
          bars: [],
        },
      },
    };
    getIntradayMock.mockResolvedValue({ bars: mkMinuteBars([today]), unauthorized: false });
    const res = await handler(evt({ ticker: 'AAPL', range: '1D' }), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.cached).toBe(false);
    expect(getIntradayMock).toHaveBeenCalledTimes(1);
  });
});

describe('daily-range regression guard', () => {
  it('computeFrom math is unchanged for existing ranges', () => {
    expect(computeFrom('1M', '2026-07-10')).toBe('2026-06-10');
    expect(computeFrom('6M', '2026-07-10')).toBe('2026-01-09');
    expect(computeFrom('1Y', '2026-07-10')).toBe('2025-07-10');
    expect(computeFrom('All', '2026-07-10')).toBe('2000-01-01');
  });

  it('still rejects an unknown range', async () => {
    const res = await handler(evt({ ticker: 'AAPL', range: '2W' }), {} as any);
    expect(res!.statusCode).toBe(400);
  });
});
