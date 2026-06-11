// Wave 2D (M1) — prophet-picks must mirror target-board's #72 serve-stale
// architecture for ALL Prophet universes (largecap, russell, all):
//   - fresh snapshot → served (`source: 'snapshot'`);
//   - stale snapshot → served flagged `stale: true`
//     (`source: 'snapshot-stale'`) — NEVER an inline live scan;
//   - missing snapshot → empty `source: 'snapshot-missing'` response —
//     no more `snapshotNotBuilt` sentinel with the factually false
//     "does not yet have a scheduled after-close scan" reason;
//   - ?force=1 → re-reads the snapshot, never live-scans.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  latestReturn: { value: null as any },
  liveScanSpy: vi.fn(),
  narrateTopNSpy: vi.fn(),
}));

vi.mock('../shared/snapshot-store', () => ({
  latestSnapshot: vi.fn(async () => mocks.latestReturn.value),
  isSnapshotFresh: vi.fn((snap: any, now: number = Date.now()) =>
    now - new Date(snap.generatedAt).getTime() < snap.freshnessBudgetMs,
  ),
  snapshotAgeMs: vi.fn((snap: any, now: number = Date.now()) =>
    now - new Date(snap.generatedAt).getTime(),
  ),
}));

vi.mock('../shared/scan-prophet', () => {
  const order: Record<string, number> = { low: 0, medium: 1, high: 2 };
  return {
    runProphetScan: mocks.liveScanSpy,
    filterProphetByConviction: (picks: any[], min: string) =>
      picks.filter((p) => (order[p.conviction] ?? 0) >= (order[min] ?? 0)),
  };
});

vi.mock('../shared/narrative-generator', () => ({
  narrateTopN: mocks.narrateTopNSpy,
}));

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

vi.mock('../shared/model-version', () => ({ MODEL_VERSION: 'test-model' }));

import { handler } from '../prophet-picks';

function evt(qs: Record<string, string>) {
  return {
    httpMethod: 'GET',
    queryStringParameters: qs,
    headers: {},
    body: null,
  } as any;
}

beforeEach(() => {
  mocks.latestReturn.value = null;
  mocks.liveScanSpy.mockReset();
  mocks.narrateTopNSpy.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
});

function snapshot(opts: { ageMs: number; picks?: any[]; budgetMs?: number; sieve?: any }) {
  return {
    modelVersion: 'test-model',
    generatedAt: new Date(Date.now() - opts.ageMs).toISOString(),
    scanDurationMs: 0,
    universeChecked: 508,
    results:
      opts.picks ??
      [
        { ticker: 'NVDA', composite: 88, conviction: 'high', narrative: 'x' },
        { ticker: 'AAPL', composite: 64, conviction: 'medium', narrative: 'y' },
      ],
    freshnessBudgetMs: opts.budgetMs ?? 26 * 60 * 60_000,
    warnings: [],
    sieve: opts.sieve,
  };
}

describe('prophet-picks — fresh snapshot', () => {
  it('serves a fresh snapshot without scanning', async () => {
    mocks.latestReturn.value = snapshot({ ageMs: 60 * 60_000 });
    const res = (await handler(evt({ universe: 'largecap' }), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('snapshot');
    expect(body.stale).toBeFalsy();
    expect(body.picks).toHaveLength(2);
    expect(body.qualified).toBe(2);
    expect(mocks.liveScanSpy).not.toHaveBeenCalled();
  });

  it('applies minConviction filtering from the snapshot', async () => {
    mocks.latestReturn.value = snapshot({ ageMs: 60 * 60_000 });
    const res = (await handler(
      evt({ universe: 'largecap', minConviction: 'high' }),
      {} as any,
      () => {},
    )) as any;
    const body = JSON.parse(res.body);
    expect(body.picks).toHaveLength(1);
    expect(body.picks[0].ticker).toBe('NVDA');
  });
});

describe.each(['largecap', 'russell', 'all'] as const)(
  'prophet-picks — %s serve-stale path (M1)',
  (universe) => {
    it('serves a stale snapshot flagged stale:true and NEVER inline-scans', async () => {
      mocks.latestReturn.value = snapshot({ ageMs: 48 * 60 * 60_000 }); // 48h > 26h budget
      const res = (await handler(evt({ universe }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.source).toBe('snapshot-stale');
      expect(body.stale).toBe(true);
      expect(body.picks).toHaveLength(2);
      expect(body.warning).toMatch(/older than the freshness budget/);
      // The pre-fix snapshotNotBuilt sentinel (with its factually false
      // "does not yet have a scheduled after-close scan" reason) is gone.
      expect(body.snapshotNotBuilt).toBeUndefined();
      expect(body.reason).toBeUndefined();
      expect(mocks.liveScanSpy).not.toHaveBeenCalled();
    });

    it('returns snapshot-missing (not a live scan) when no snapshot exists', async () => {
      mocks.latestReturn.value = null;
      const res = (await handler(evt({ universe }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.source).toBe('snapshot-missing');
      expect(body.stale).toBe(true);
      expect(body.picks).toEqual([]);
      expect(body.snapshotNotBuilt).toBeUndefined();
      expect(mocks.liveScanSpy).not.toHaveBeenCalled();
    });

    it('?force=1 re-reads the snapshot instead of live-scanning', async () => {
      mocks.latestReturn.value = snapshot({ ageMs: 60 * 60_000 });
      const res = (await handler(evt({ universe, force: '1' }), {} as any, () => {})) as any;
      const body = JSON.parse(res.body);
      expect(['snapshot', 'snapshot-stale']).toContain(body.source);
      expect(mocks.liveScanSpy).not.toHaveBeenCalled();
    });
  },
);

describe('prophet-picks — honest coverage (Wave 4A M8)', () => {
  it('serves universeSize (full universe) and universeChecked (actually scored) separately', async () => {
    mocks.latestReturn.value = {
      ...snapshot({ ageMs: 60 * 60_000 }),
      universeSize: 1930,
      universeChecked: 1200, // Stage 1 hit its budget
    };
    const res = (await handler(evt({ universe: 'russell' }), {} as any, () => {})) as any;
    const body = JSON.parse(res.body);
    expect(body.universeSize).toBe(1930);
    expect(body.universeChecked).toBe(1200);
  });

  it('pre-Wave-4A snapshots (no universeSize) fall back to universeChecked for both fields', async () => {
    mocks.latestReturn.value = snapshot({ ageMs: 60 * 60_000 }); // universeChecked: 508, no universeSize
    const res = (await handler(evt({ universe: 'largecap' }), {} as any, () => {})) as any;
    const body = JSON.parse(res.body);
    expect(body.universeSize).toBe(508);
    expect(body.universeChecked).toBe(508);
  });
});

describe('prophet-picks — sieve telemetry + narration backfill', () => {
  it('passes sieve telemetry through for russell snapshots', async () => {
    mocks.latestReturn.value = snapshot({
      ageMs: 60 * 60_000,
      sieve: { stage1: { scored: 1930 } },
    });
    const res = (await handler(evt({ universe: 'russell' }), {} as any, () => {})) as any;
    const body = JSON.parse(res.body);
    expect(body.sieve).toMatchObject({ stage1: { scored: 1930 } });
  });

  it('narrates top-N inline only when served picks lack narratives', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mocks.latestReturn.value = snapshot({
      ageMs: 60 * 60_000,
      picks: [{ ticker: 'NVDA', composite: 88, conviction: 'high' }], // no narrative
    });
    await handler(evt({ universe: 'largecap' }), {} as any, () => {});
    expect(mocks.narrateTopNSpy).toHaveBeenCalledOnce();
  });

  it('skips narration when every served pick is pre-narrated', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mocks.latestReturn.value = snapshot({ ageMs: 60 * 60_000 });
    await handler(evt({ universe: 'largecap' }), {} as any, () => {});
    expect(mocks.narrateTopNSpy).not.toHaveBeenCalled();
  });
});
