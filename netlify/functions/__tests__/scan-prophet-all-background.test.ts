// Wave 2D (CR-7/CR-8) — Prophet 'all' background worker tests.
//
// The worker carries the old scheduled handler's scan body (runProphetScan
// + narrateAll) and adds the partial-publish discipline the russell/all
// paths were missing:
//   1. budgetExceeded ⇒ writeSnapshot receives status:'partial' (which
//      the store refuses to promote) — the CR-8 pin.
//   2. A hollow "complete" result (0 picks over a large universe) is
//      demoted to partial by the real assessSnapshotPublish guard.
//   3. The inline narrate step is preserved in the background worker.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runProphetScanMock: vi.fn(),
  writeSnapshotMock: vi.fn(),
  pruneOldSnapshotsMock: vi.fn(),
  narrateAllMock: vi.fn(),
}));

vi.mock('../shared/scan-prophet', () => ({
  runProphetScan: mocks.runProphetScanMock,
}));

// Keep the REAL assessSnapshotPublish so the guard tests exercise the
// production thresholds; only the Firestore write is stubbed.
vi.mock('../shared/snapshot-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/snapshot-store')>();
  return {
    ...actual,
    writeSnapshot: mocks.writeSnapshotMock,
    pruneOldSnapshots: mocks.pruneOldSnapshotsMock,
  };
});

vi.mock('../shared/narrative-generator', () => ({
  narrateAll: mocks.narrateAllMock,
}));

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

import { handler } from '../scan-prophet-all-background';

function evt(method = 'POST') {
  return { httpMethod: method, queryStringParameters: {}, headers: {}, body: '{}' } as any;
}

function fakeScan(overrides: Record<string, unknown> = {}) {
  return {
    picks: [
      { ticker: 'NVDA', composite: 88, conviction: 'high' },
      { ticker: 'AAPL', composite: 64, conviction: 'medium' },
    ],
    scanDurationMs: 120,
    universeChecked: 2200,
    tickersScanned: 2200,
    warnings: [],
    budgetExceeded: false,
    regime: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.runProphetScanMock.mockReset();
  mocks.writeSnapshotMock.mockReset();
  mocks.writeSnapshotMock.mockResolvedValue({ snapshotId: 'all-2026-06-10-1800', promotedToLatest: true });
  mocks.pruneOldSnapshotsMock.mockReset();
  mocks.pruneOldSnapshotsMock.mockResolvedValue({ deleted: 0, kept: 0 });
  mocks.narrateAllMock.mockReset();
  mocks.narrateAllMock.mockResolvedValue({ narrated: 2, failed: 0, skipped: 0, durationMs: 10 });
  process.env.ANTHROPIC_API_KEY = 'test-key';
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('scan-prophet-all-background (worker)', () => {
  it('refuses non-POST', async () => {
    const res = (await handler(evt('GET'), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(405);
    expect(mocks.runProphetScanMock).not.toHaveBeenCalled();
  });

  it('writes status:complete and promotes on an in-budget scan', async () => {
    mocks.runProphetScanMock.mockResolvedValue(fakeScan());
    const res = (await handler(evt(), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(200);
    expect(mocks.writeSnapshotMock).toHaveBeenCalledOnce();
    expect(mocks.writeSnapshotMock.mock.calls[0][0]).toBe('prophet');
    expect(mocks.writeSnapshotMock.mock.calls[0][1]).toBe('all');
    expect(mocks.writeSnapshotMock.mock.calls[0][2]).toMatchObject({ status: 'complete' });
    const body = JSON.parse(res.body);
    expect(body.status).toBe('complete');
    expect(body.promotedToLatest).toBe(true);
  });

  it('CR-8: budgetExceeded ⇒ writeSnapshot receives status:partial ⇒ not promoted', async () => {
    mocks.runProphetScanMock.mockResolvedValue(fakeScan({ budgetExceeded: true }));
    mocks.writeSnapshotMock.mockResolvedValue({ snapshotId: 'all-2026-06-10-1800', promotedToLatest: false });
    const res = (await handler(evt(), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(200);
    expect(mocks.writeSnapshotMock.mock.calls[0][2]).toMatchObject({ status: 'partial' });
    const body = JSON.parse(res.body);
    expect(body.status).toBe('partial');
    expect(body.promotedToLatest).toBe(false);
  });

  it('CR-8: a hollow complete result (0 picks / 2200 names) is demoted to partial by the publish guard', async () => {
    mocks.runProphetScanMock.mockResolvedValue(fakeScan({ picks: [], budgetExceeded: false }));
    mocks.writeSnapshotMock.mockResolvedValue({ snapshotId: 'all-2026-06-10-1800', promotedToLatest: false });
    const res = (await handler(evt(), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(200);
    const written = mocks.writeSnapshotMock.mock.calls[0][2];
    expect(written.status).toBe('partial');
    expect(written.warnings).toContainEqual(expect.stringContaining('publish guard'));
  });

  it('preserves the inline narrate step in the background worker', async () => {
    const scan = fakeScan();
    mocks.runProphetScanMock.mockResolvedValue(scan);
    await handler(evt(), {} as any, () => {});
    expect(mocks.narrateAllMock).toHaveBeenCalledOnce();
    expect(mocks.narrateAllMock).toHaveBeenCalledWith(scan.picks, expect.objectContaining({ concurrency: 4 }));
  });

  it('skips narration when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mocks.runProphetScanMock.mockResolvedValue(fakeScan());
    await handler(evt(), {} as any, () => {});
    expect(mocks.narrateAllMock).not.toHaveBeenCalled();
  });

  it('returns 500 without writing when the scan throws', async () => {
    mocks.runProphetScanMock.mockRejectedValue(new Error('boom'));
    const res = (await handler(evt(), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(500);
    expect(mocks.writeSnapshotMock).not.toHaveBeenCalled();
    expect(mocks.pruneOldSnapshotsMock).not.toHaveBeenCalled();
  });

  it('Wave 4A: prunes the runs/ history in keep-daily-close mode after the write', async () => {
    mocks.runProphetScanMock.mockResolvedValue(fakeScan());
    await handler(evt(), {} as any, () => {});
    expect(mocks.pruneOldSnapshotsMock).toHaveBeenCalledWith('prophet', 'all', {
      mode: 'keep-daily-close',
    });
  });

  it('Wave 4A: a prune failure is best-effort — the worker still returns 200', async () => {
    mocks.runProphetScanMock.mockResolvedValue(fakeScan());
    mocks.pruneOldSnapshotsMock.mockRejectedValue(new Error('firestore down'));
    const res = (await handler(evt(), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});
