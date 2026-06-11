// Wave 2D (CR-7/CR-8) — Prophet russell background worker tests.
//
// The worker carries the old scheduled handler's sieve + narrate body and
// adds the partial-publish discipline:
//   1. Any sieve stage's partial flag ⇒ writeSnapshot receives
//      status:'partial' (which the store refuses to promote).
//   2. A hollow "complete" result (0 picks over ~1,930 names) is demoted
//      to partial by the real assessSnapshotPublish guard.
//   3. The inline narrate step + sieve telemetry are preserved.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runProphetSieveMock: vi.fn(),
  writeSnapshotMock: vi.fn(),
  narrateAllMock: vi.fn(),
}));

vi.mock('../shared/prophet-sieve', () => ({
  runProphetSieve: mocks.runProphetSieveMock,
}));

vi.mock('../shared/universe', () => ({
  inIndex: () => [{ ticker: 'AAA' }, { ticker: 'BBB' }],
}));

// Keep the REAL assessSnapshotPublish so the guard tests exercise the
// production thresholds; only the Firestore write is stubbed.
vi.mock('../shared/snapshot-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/snapshot-store')>();
  return { ...actual, writeSnapshot: mocks.writeSnapshotMock };
});

vi.mock('../shared/narrative-generator', () => ({
  narrateAll: mocks.narrateAllMock,
}));

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

import { handler } from '../scan-prophet-russell-background';

function evt(method = 'POST') {
  return { httpMethod: method, queryStringParameters: {}, headers: {}, body: '{}' } as any;
}

function stage(partial = false) {
  return { scored: 100, survived: 50, thresholdScore: 40, budgetMs: 1000, partial, warnings: [] };
}

function fakeSieve(overrides: Record<string, unknown> = {}) {
  return {
    picks: [
      { ticker: 'NVDA', composite: 88, conviction: 'high' },
      { ticker: 'AAPL', composite: 64, conviction: 'medium' },
    ],
    meta: { stage1: stage(), stage2: stage(), stage3: stage() },
    universeChecked: 1930,
    scanDurationMs: 1000,
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.runProphetSieveMock.mockReset();
  mocks.writeSnapshotMock.mockReset();
  mocks.writeSnapshotMock.mockResolvedValue({
    snapshotId: 'russell2k-2026-06-10-1800',
    promotedToLatest: true,
  });
  mocks.narrateAllMock.mockReset();
  mocks.narrateAllMock.mockResolvedValue({ narrated: 2, failed: 0, skipped: 0, durationMs: 10 });
  process.env.ANTHROPIC_API_KEY = 'test-key';
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('scan-prophet-russell-background (worker)', () => {
  it('refuses non-POST', async () => {
    const res = (await handler(evt('GET'), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(405);
    expect(mocks.runProphetSieveMock).not.toHaveBeenCalled();
  });

  it('writes status:complete with sieve telemetry when every stage finishes in budget', async () => {
    mocks.runProphetSieveMock.mockResolvedValue(fakeSieve());
    const res = (await handler(evt(), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(200);
    expect(mocks.writeSnapshotMock).toHaveBeenCalledOnce();
    expect(mocks.writeSnapshotMock.mock.calls[0][0]).toBe('prophet');
    expect(mocks.writeSnapshotMock.mock.calls[0][1]).toBe('russell2k');
    const written = mocks.writeSnapshotMock.mock.calls[0][2];
    expect(written.status).toBe('complete');
    expect(written.sieve.stage1).toMatchObject({ scored: 100, partial: false });
    const body = JSON.parse(res.body);
    expect(body.status).toBe('complete');
    expect(body.promotedToLatest).toBe(true);
  });

  it.each(['stage1', 'stage2', 'stage3'] as const)(
    'CR-8: a partial %s ⇒ writeSnapshot receives status:partial ⇒ not promoted',
    async (partialStage) => {
      const meta = { stage1: stage(), stage2: stage(), stage3: stage() };
      meta[partialStage] = stage(true);
      mocks.runProphetSieveMock.mockResolvedValue(fakeSieve({ meta }));
      mocks.writeSnapshotMock.mockResolvedValue({
        snapshotId: 'russell2k-2026-06-10-1800',
        promotedToLatest: false,
      });
      const res = (await handler(evt(), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      expect(mocks.writeSnapshotMock.mock.calls[0][2]).toMatchObject({ status: 'partial' });
      const body = JSON.parse(res.body);
      expect(body.status).toBe('partial');
      expect(body.promotedToLatest).toBe(false);
    },
  );

  it('CR-8: a hollow complete result (0 picks / 1930 names) is demoted to partial by the publish guard', async () => {
    mocks.runProphetSieveMock.mockResolvedValue(fakeSieve({ picks: [] }));
    mocks.writeSnapshotMock.mockResolvedValue({
      snapshotId: 'russell2k-2026-06-10-1800',
      promotedToLatest: false,
    });
    await handler(evt(), {} as any, () => {});
    const written = mocks.writeSnapshotMock.mock.calls[0][2];
    expect(written.status).toBe('partial');
    expect(written.warnings).toContainEqual(expect.stringContaining('publish guard'));
  });

  it('preserves the inline narrate step in the background worker', async () => {
    const sieve = fakeSieve();
    mocks.runProphetSieveMock.mockResolvedValue(sieve);
    await handler(evt(), {} as any, () => {});
    expect(mocks.narrateAllMock).toHaveBeenCalledOnce();
    expect(mocks.narrateAllMock).toHaveBeenCalledWith(sieve.picks, expect.objectContaining({ concurrency: 4 }));
  });

  it('returns 500 without writing when the sieve throws', async () => {
    mocks.runProphetSieveMock.mockRejectedValue(new Error('boom'));
    const res = (await handler(evt(), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(500);
    expect(mocks.writeSnapshotMock).not.toHaveBeenCalled();
  });
});
