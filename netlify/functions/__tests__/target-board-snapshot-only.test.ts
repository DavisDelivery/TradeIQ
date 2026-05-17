// Phase 4h W2 — target-board read endpoint must NEVER inline-live-scan
// for russell2k / sp500. Stale snapshot → serve stale-flagged.
// Missing snapshot → serve empty with `source: 'snapshot-missing'`.
// Forced rescan on a large universe → redirect to snapshot serve, not
// a live scan.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  latestReturn: { value: null as any },
  liveScanSpy: vi.fn(),
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

vi.mock('../shared/scan-target', () => ({
  runTargetScan: mocks.liveScanSpy,
}));

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

vi.mock('../shared/model-version', () => ({ MODEL_VERSION: 'test-model' }));

import { handler } from '../target-board';

function evt(qs: Record<string, string>) {
  return {
    httpMethod: 'GET',
    queryStringParameters: qs,
    headers: {},
    body: null,
  } as any;
}

beforeEach(() => {
  mocks.latestReturn.value =null;
  mocks.liveScanSpy.mockReset();
});

function snapshot(opts: { ageMs: number; results: any[]; budgetMs?: number }) {
  return {
    modelVersion: 'test-model',
    generatedAt: new Date(Date.now() - opts.ageMs).toISOString(),
    scanDurationMs: 0,
    universeChecked: opts.results.length,
    results: opts.results,
    freshnessBudgetMs: opts.budgetMs ?? 26 * 60 * 60_000,
    warnings: [],
  };
}

describe('target-board — russell2k snapshot-only path', () => {
  it('serves fresh snapshot for russell2k', async () => {
    mocks.latestReturn.value =snapshot({ ageMs: 1 * 60 * 60_000, results: [{ ticker: 'A' }, { ticker: 'B' }] });
    const res = (await handler(evt({ universe: 'russell2k' }), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('snapshot');
    expect(body.stale).toBeFalsy();
    expect(body.targets).toHaveLength(2);
    expect(mocks.liveScanSpy).not.toHaveBeenCalled();
  });

  it('serves stale snapshot flagged stale: true for russell2k — NEVER live-scans', async () => {
    mocks.latestReturn.value =snapshot({
      ageMs: 30 * 60 * 60_000, // 30h old; > 26h budget
      results: [{ ticker: 'STALE1' }, { ticker: 'STALE2' }],
      budgetMs: 26 * 60 * 60_000,
    });
    const res = (await handler(evt({ universe: 'russell2k' }), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('snapshot-stale');
    expect(body.stale).toBe(true);
    expect(body.targets).toHaveLength(2);
    expect(body.generatedAt).toBeDefined();
    expect(body.warning).toMatch(/older than the freshness budget/);
    expect(mocks.liveScanSpy).not.toHaveBeenCalled();
  });

  it('returns empty snapshot-missing for russell2k when no snapshot exists', async () => {
    mocks.latestReturn.value =null;
    const res = (await handler(evt({ universe: 'russell2k' }), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('snapshot-missing');
    expect(body.stale).toBe(true);
    expect(body.targets).toEqual([]);
    expect(mocks.liveScanSpy).not.toHaveBeenCalled();
  });

  it('also applies to "russell" alias', async () => {
    mocks.latestReturn.value =null;
    const res = (await handler(evt({ universe: 'russell' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.source).toBe('snapshot-missing');
    expect(mocks.liveScanSpy).not.toHaveBeenCalled();
  });
});

describe('target-board — sp500 snapshot-only path', () => {
  it('never live-scans sp500 on stale snapshot', async () => {
    mocks.latestReturn.value =snapshot({
      ageMs: 48 * 60 * 60_000,
      results: [{ ticker: 'AAPL' }],
    });
    const res = (await handler(evt({ universe: 'sp500' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.source).toBe('snapshot-stale');
    expect(body.stale).toBe(true);
    expect(mocks.liveScanSpy).not.toHaveBeenCalled();
  });

  it('forced rescan on sp500 still refuses to inline-scan', async () => {
    mocks.latestReturn.value =snapshot({ ageMs: 1 * 60 * 60_000, results: [{ ticker: 'AAPL' }] });
    const res = (await handler(evt({ universe: 'sp500', force: '1' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    // Forced + fresh snapshot → serve as snapshot (not as forced-partial).
    expect(['snapshot', 'snapshot-stale']).toContain(body.source);
    expect(mocks.liveScanSpy).not.toHaveBeenCalled();
  });

  it('forced rescan on sp500 with no snapshot returns snapshot-missing, not a live scan', async () => {
    mocks.latestReturn.value =null;
    const res = (await handler(evt({ universe: 'sp500', force: '1' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.source).toBe('snapshot-missing');
    expect(mocks.liveScanSpy).not.toHaveBeenCalled();
  });
});

describe('target-board — small-universe inline-scan still allowed', () => {
  it('dow with stale snapshot falls back to runTargetScan', async () => {
    mocks.latestReturn.value =snapshot({ ageMs: 48 * 60 * 60_000, results: [{ ticker: 'AAPL' }] });
    mocks.liveScanSpy.mockResolvedValue({
      results: [{ ticker: 'AAPL', composite: 90 }],
      universeChecked: 30,
      pass1Scanned: 30,
      pass2Survivors: 5,
      scanDurationMs: 1000,
      warnings: [],
      budgetExceeded: false,
    });
    const res = (await handler(evt({ universe: 'dow' }), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('fallback-partial');
    expect(mocks.liveScanSpy).toHaveBeenCalledTimes(1);
  });

  it('core with no snapshot inline-scans as before', async () => {
    mocks.latestReturn.value =null;
    mocks.liveScanSpy.mockResolvedValue({
      results: [{ ticker: 'AAPL', composite: 88 }],
      universeChecked: 33,
      pass1Scanned: 33,
      pass2Survivors: 10,
      scanDurationMs: 1000,
      warnings: [],
      budgetExceeded: false,
    });
    const res = (await handler(evt({ universe: 'core' }), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    expect(mocks.liveScanSpy).toHaveBeenCalledTimes(1);
  });
});
