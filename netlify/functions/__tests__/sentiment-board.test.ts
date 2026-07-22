// sentiment-board endpoint: snapshot-only serve, stale-flag, bullish/bearish
// re-sort, and force→dispatchRescan.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  latestSnapshot: vi.fn(),
  isSnapshotFresh: vi.fn(),
  snapshotAgeMs: vi.fn(() => 1000),
  dispatchRescan: vi.fn(async () => true),
}));

vi.mock('../shared/snapshot-store', () => ({
  latestSnapshot: h.latestSnapshot,
  isSnapshotFresh: h.isSnapshotFresh,
  snapshotAgeMs: h.snapshotAgeMs,
}));
vi.mock('../shared/rescan-dispatch', () => ({ dispatchRescan: h.dispatchRescan }));
vi.mock('../shared/model-version', () => ({ MODEL_VERSION: 'test-mv' }));

import { handler } from '../sentiment-board';

const rows = [
  { ticker: 'AAA', score: 40, label: 'bullish', articleCount: 5 },
  { ticker: 'BBB', score: -30, label: 'bearish', articleCount: 3 },
  { ticker: 'CCC', score: 10, label: 'neutral', articleCount: 2 },
];
const snap = { results: rows, universeChecked: 3, generatedAt: '2026-07-22T12:20:00Z', modelVersion: 'mv1' };

const ev = (qs: Record<string, string> = {}) => ({ queryStringParameters: qs } as any);
const call = async (qs?: Record<string, string>) => {
  const r: any = await handler(ev(qs), {} as any, () => {});
  return JSON.parse(r.body);
};

beforeEach(() => vi.clearAllMocks());

describe('sentiment-board', () => {
  it('serves a fresh snapshot, most-bullish first', async () => {
    h.latestSnapshot.mockResolvedValue(snap);
    h.isSnapshotFresh.mockReturnValue(true);
    const body = await call({ index: 'sp500', sort: 'bullish' });
    expect(body.source).toBe('snapshot');
    expect(body.rows.map((x: any) => x.ticker)).toEqual(['AAA', 'CCC', 'BBB']);
    expect(h.dispatchRescan).not.toHaveBeenCalled();
  });

  it('sort=bearish reverses the order (most bearish first)', async () => {
    h.latestSnapshot.mockResolvedValue(snap);
    h.isSnapshotFresh.mockReturnValue(true);
    const body = await call({ sort: 'bearish' });
    expect(body.rows.map((x: any) => x.ticker)).toEqual(['BBB', 'CCC', 'AAA']);
  });

  it('stale snapshot is served flagged; force dispatches a rescan', async () => {
    h.latestSnapshot.mockResolvedValue(snap);
    h.isSnapshotFresh.mockReturnValue(false);
    const body = await call({ force: '1' });
    expect(body.source).toBe('snapshot-stale');
    expect(body.stale).toBe(true);
    expect(body.rescanDispatched).toBe(true);
    expect(h.dispatchRescan).toHaveBeenCalledWith('sentiment', 'sp500', expect.anything());
  });

  it('missing snapshot returns an empty snapshot-missing payload', async () => {
    h.latestSnapshot.mockResolvedValue(null);
    h.isSnapshotFresh.mockReturnValue(false);
    const body = await call();
    expect(body.source).toBe('snapshot-missing');
    expect(body.rows).toEqual([]);
  });
});
