import { describe, it, expect, vi, beforeEach } from 'vitest';

const latestSnapshotMock = vi.fn();
vi.mock('../shared/snapshot-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../shared/snapshot-store')>();
  return {
    ...real,
    latestSnapshot: (...a: unknown[]) => latestSnapshotMock(...a),
  };
});

import { handler } from '../crosses-board';

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

function evt(params: Record<string, string> = {}) {
  return { queryStringParameters: params, httpMethod: 'GET' } as any;
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    modelVersion: 'test',
    generatedAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 1h old → fresh (26h budget)
    freshnessBudgetMs: 26 * 60 * 60_000,
    scanDurationMs: 1000,
    universeChecked: 500,
    results: [
      { ticker: 'AAPL', type: 'golden', date: iso(2 * DAY), closeAtCross: 200, sma50: 201, sma200: 199, barsAgo: 1, lastClose: 210, pctSinceCross: 5, name: 'Apple', sector: 'Tech' },
      { ticker: 'XOM', type: 'death', date: iso(40 * DAY), closeAtCross: 100, sma50: 99, sma200: 101, barsAgo: 27, lastClose: 90, pctSinceCross: -10, name: 'Exxon', sector: 'Energy' },
      { ticker: 'MSFT', type: 'golden', date: iso(300 * DAY), closeAtCross: 300, sma50: 301, sma200: 299, barsAgo: 205, lastClose: 400, pctSinceCross: 33.3, name: 'Microsoft', sector: 'Tech' },
    ],
    ...overrides,
  };
}

beforeEach(() => latestSnapshotMock.mockReset());

describe('crosses-board endpoint', () => {
  it('serves all rows in the default 365d window', async () => {
    latestSnapshotMock.mockResolvedValue(snapshot());
    const res: any = await handler(evt(), {} as any, () => {});
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.rows).toHaveLength(3);
    expect(body.stale).toBeUndefined();
  });

  it('filters by type=golden and by days window', async () => {
    latestSnapshotMock.mockResolvedValue(snapshot());
    const golden: any = await handler(evt({ type: 'golden' }), {} as any, () => {});
    expect(JSON.parse(golden.body).rows.map((r: any) => r.ticker)).toEqual(['AAPL', 'MSFT']);

    const recent: any = await handler(evt({ days: '30' }), {} as any, () => {});
    expect(JSON.parse(recent.body).rows.map((r: any) => r.ticker)).toEqual(['AAPL']);
  });

  it('flags stale snapshots but still serves them', async () => {
    latestSnapshotMock.mockResolvedValue(snapshot({
      generatedAt: new Date(Date.now() - 72 * 60 * 60_000).toISOString(), // 3 days old
    }));
    const res: any = await handler(evt(), {} as any, () => {});
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.stale).toBe(true);
  });

  it('returns an empty-but-ok payload before the first scan exists', async () => {
    latestSnapshotMock.mockResolvedValue(null);
    const res: any = await handler(evt(), {} as any, () => {});
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.rows).toEqual([]);
    expect(body.stale).toBe(true);
  });
});
