// Wave 3 (track-3 critical #7 follow-up) — Prophet 'all' background worker.
//
// The worker now runs the 3-stage SIEVE (not a single-pass scan) so the
// ~2,200-name 'all' universe completes a promotable `complete` snapshot
// instead of perpetually truncating to status:'partial' (the cause of the
// stale _latest/all). These tests pin:
//   1. an all-stages-in-budget sieve ⇒ status:complete, promoted;
//   2. any stage partial ⇒ status:partial ⇒ store refuses to promote;
//   3. a hollow "complete" result (0 picks over the large universe) is
//      demoted to partial by the real assessSnapshotPublish guard;
//   4. inline narration + keep-daily-close prune discipline preserved.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runProphetSieveMock: vi.fn(),
  resolveUniverseMock: vi.fn(),
  writeSnapshotMock: vi.fn(),
  pruneOldSnapshotsMock: vi.fn(),
  narrateAllMock: vi.fn(),
}));

vi.mock('../shared/scan-prophet', () => ({
  resolveProphetUniverse: mocks.resolveUniverseMock,
}));

vi.mock('../shared/prophet-sieve', () => ({
  runProphetSieve: mocks.runProphetSieveMock,
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

function stage(partial = false) {
  return { scored: 100, survived: 20, thresholdScore: 60, budgetMs: 100, partial };
}

function fakeSieve(overrides: Record<string, unknown> = {}) {
  return {
    picks: [
      { ticker: 'NVDA', composite: 88, conviction: 'high' },
      { ticker: 'AAPL', composite: 64, conviction: 'medium' },
    ],
    scanDurationMs: 120,
    universeChecked: 1900, // Stage-1 actually-scored
    universeSize: 2200, // full universe
    warnings: [],
    meta: { stage1: stage(), stage2: stage(), stage3: stage() },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.runProphetSieveMock.mockReset();
  mocks.resolveUniverseMock.mockReset();
  mocks.resolveUniverseMock.mockReturnValue([{ ticker: 'NVDA' }, { ticker: 'AAPL' }]);
  mocks.writeSnapshotMock.mockReset();
  mocks.writeSnapshotMock.mockResolvedValue({ snapshotId: 'all-2026-06-12-1800', promotedToLatest: true });
  mocks.pruneOldSnapshotsMock.mockReset();
  mocks.pruneOldSnapshotsMock.mockResolvedValue({ deleted: 0, kept: 0 });
  mocks.narrateAllMock.mockReset();
  mocks.narrateAllMock.mockResolvedValue({ narrated: 2, failed: 0, skipped: 0, durationMs: 10 });
  process.env.ANTHROPIC_API_KEY = 'test-key';
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('scan-prophet-all-background (worker, sieve)', () => {
  it('refuses non-POST', async () => {
    const res = (await handler(evt('GET'), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(405);
    expect(mocks.runProphetSieveMock).not.toHaveBeenCalled();
  });

  it('drives the full universe through the sieve (universe: all)', async () => {
    mocks.runProphetSieveMock.mockResolvedValue(fakeSieve());
    await handler(evt(), {} as any, () => {});
    expect(mocks.runProphetSieveMock).toHaveBeenCalledOnce();
    expect(mocks.runProphetSieveMock.mock.calls[0][0]).toMatchObject({ universe: 'all' });
    expect(mocks.resolveUniverseMock).toHaveBeenCalledWith('all');
  });

  it('writes status:complete and promotes when all stages stay in budget', async () => {
    mocks.runProphetSieveMock.mockResolvedValue(fakeSieve());
    const res = (await handler(evt(), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(200);
    expect(mocks.writeSnapshotMock.mock.calls[0][0]).toBe('prophet');
    expect(mocks.writeSnapshotMock.mock.calls[0][1]).toBe('all');
    const written = mocks.writeSnapshotMock.mock.calls[0][2];
    expect(written).toMatchObject({ status: 'complete', universeChecked: 1900, universeSize: 2200 });
    expect(written.sieve.stage1.scored).toBe(100);
    expect(JSON.parse(res.body).status).toBe('complete');
  });

  it('CR-8: any stage partial ⇒ status:partial ⇒ not promoted', async () => {
    mocks.runProphetSieveMock.mockResolvedValue(
      fakeSieve({ meta: { stage1: stage(true), stage2: stage(), stage3: stage() } }),
    );
    mocks.writeSnapshotMock.mockResolvedValue({ snapshotId: 'all-x', promotedToLatest: false });
    const res = (await handler(evt(), {} as any, () => {})) as any;
    expect(mocks.writeSnapshotMock.mock.calls[0][2]).toMatchObject({ status: 'partial' });
    expect(JSON.parse(res.body).promotedToLatest).toBe(false);
  });

  it('CR-8: a hollow complete result (0 picks / 2200 names) is demoted to partial by the publish guard', async () => {
    mocks.runProphetSieveMock.mockResolvedValue(fakeSieve({ picks: [] }));
    mocks.writeSnapshotMock.mockResolvedValue({ snapshotId: 'all-x', promotedToLatest: false });
    await handler(evt(), {} as any, () => {});
    const written = mocks.writeSnapshotMock.mock.calls[0][2];
    expect(written.status).toBe('partial');
    expect(written.warnings).toContainEqual(expect.stringContaining('publish guard'));
  });

  it('preserves the inline narrate step', async () => {
    const sieve = fakeSieve();
    mocks.runProphetSieveMock.mockResolvedValue(sieve);
    await handler(evt(), {} as any, () => {});
    expect(mocks.narrateAllMock).toHaveBeenCalledOnce();
    expect(mocks.narrateAllMock).toHaveBeenCalledWith(sieve.picks, expect.objectContaining({ concurrency: 4 }));
  });

  it('skips narration when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mocks.runProphetSieveMock.mockResolvedValue(fakeSieve());
    await handler(evt(), {} as any, () => {});
    expect(mocks.narrateAllMock).not.toHaveBeenCalled();
  });

  it('returns 500 without writing when the sieve throws', async () => {
    mocks.runProphetSieveMock.mockRejectedValue(new Error('boom'));
    const res = (await handler(evt(), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(500);
    expect(mocks.writeSnapshotMock).not.toHaveBeenCalled();
    expect(mocks.pruneOldSnapshotsMock).not.toHaveBeenCalled();
  });

  it('Wave 4A: prunes the runs/ history in keep-daily-close mode after the write', async () => {
    mocks.runProphetSieveMock.mockResolvedValue(fakeSieve());
    await handler(evt(), {} as any, () => {});
    expect(mocks.pruneOldSnapshotsMock).toHaveBeenCalledWith('prophet', 'all', { mode: 'keep-daily-close' });
  });

  it('Wave 4A: a prune failure is best-effort — the worker still returns 200', async () => {
    mocks.runProphetSieveMock.mockResolvedValue(fakeSieve());
    mocks.pruneOldSnapshotsMock.mockRejectedValue(new Error('firestore down'));
    const res = (await handler(evt(), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});
