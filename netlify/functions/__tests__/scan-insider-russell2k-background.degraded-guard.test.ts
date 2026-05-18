// Phase 4o W3 — degraded-publish guard inside the russell2k insider
// bg-worker's terminal batch.
//
// Bug A's true bite: a rate-limited scan walked the universe, assembled
// an empty result, and ATOMIC-SWAPPED _latest over the previous good
// snapshot. W3 closes that. The terminal batch must consult
// `assessSnapshotPublish` and refuse to call `writeSnapshot` when the
// run looks broken.
//
// These tests use the same in-memory Firestore mock as the checkpoint
// suite. They drive a single-invocation scan to the terminal batch with
// controlled batch results, then assert on whether writeSnapshot was
// called and what flags were attached.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveUniverse: vi.fn(),
  batchScan: vi.fn(),
  writeSnapshot: vi.fn(),
  pruneOldSnapshots: vi.fn(),
  dispatchReinvoke: vi.fn(),
  createWatchdog: vi.fn(),
}));

const store: Record<string, any> = {};

function docHandle(path: string) {
  return {
    ref: { path, id: path.split('/').slice(-1)[0] },
    id: path.split('/').slice(-1)[0],
    get: async () => ({
      exists: store[path] !== undefined,
      data: () => store[path],
    }),
    set: async (payload: any, opts?: { merge?: boolean }) => {
      if (opts?.merge) store[path] = { ...(store[path] ?? {}), ...payload };
      else store[path] = payload;
    },
    delete: async () => {
      delete store[path];
    },
    collection: (sub: string) => collHandle(`${path}/${sub}`),
  };
}

function collHandle(prefix: string) {
  return {
    doc: (id: string) => docHandle(`${prefix}/${id}`),
    orderBy: () => ({
      get: async () => {
        const docs = Object.keys(store)
          .filter(
            (p) =>
              p.startsWith(`${prefix}/`) &&
              p.split('/').length === prefix.split('/').length + 1,
          )
          .sort()
          .map((p) => ({ id: p.split('/').slice(-1)[0], data: () => store[p], ref: { path: p } }));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    }),
    get: async () => {
      const docs = Object.keys(store)
        .filter(
          (p) =>
            p.startsWith(`${prefix}/`) &&
            p.split('/').length === prefix.split('/').length + 1,
        )
        .map((p) => ({ id: p.split('/').slice(-1)[0], data: () => store[p], ref: { path: p } }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  };
}

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: (cn: string) => collHandle(cn),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        delete: (ref: any) => ops.push(() => delete store[ref.path]),
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
  })),
}));

vi.mock('../shared/scan-insider', async () => {
  const actual = await vi.importActual<any>('../shared/scan-insider');
  return {
    ...actual,
    resolveInsiderUniverse: mocks.resolveUniverse,
    runInsiderScanBatch: mocks.batchScan,
  };
});

vi.mock('../shared/snapshot-store', async () => {
  const actual = await vi.importActual<any>('../shared/snapshot-store');
  return {
    ...actual,
    writeSnapshot: mocks.writeSnapshot,
    pruneOldSnapshots: mocks.pruneOldSnapshots,
  };
});

vi.mock('../shared/backtest-resume/reinvoke', async () => {
  const actual = await vi.importActual<any>('../shared/backtest-resume/reinvoke');
  return {
    ...actual,
    dispatchReinvoke: mocks.dispatchReinvoke,
  };
});

vi.mock('../shared/backtest-resume/watchdog', () => ({
  createWatchdog: mocks.createWatchdog,
}));

vi.mock('../shared/logger', () => ({
  logger: {
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
}));

vi.mock('../shared/model-version', () => ({ MODEL_VERSION: 'test-model' }));

import { handler } from '../scan-insider-russell2k-background';

function postEvent(body: any) {
  return {
    httpMethod: 'POST',
    body: JSON.stringify(body),
    headers: { host: 'tradeiq-alpha.netlify.app', 'x-forwarded-proto': 'https' },
    queryStringParameters: {},
  } as any;
}

function fakeWatchdog(expireAfterCalls: number) {
  let calls = 0;
  return {
    start: () => {},
    stop: () => {},
    isExpired: () => {
      calls += 1;
      return calls > expireAfterCalls;
    },
  };
}

function setUniverse(size: number) {
  const tickers = Array.from({ length: size }, (_, i) => `R${i.toString().padStart(4, '0')}`);
  mocks.resolveUniverse.mockReturnValue(tickers);
  return tickers;
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  mocks.resolveUniverse.mockReset();
  mocks.batchScan.mockReset();
  mocks.writeSnapshot.mockReset();
  mocks.pruneOldSnapshots.mockReset();
  mocks.dispatchReinvoke.mockReset();
  mocks.createWatchdog.mockReset();
  mocks.writeSnapshot.mockResolvedValue({ snapshotId: 'insider-russell2k-snap-x' });
  mocks.pruneOldSnapshots.mockResolvedValue({ deleted: 0, kept: 0 });
  mocks.dispatchReinvoke.mockResolvedValue({ ok: true });
});

describe('russell2k insider bg-worker — Phase 4o W3 degraded-publish guard', () => {
  it('SKIPS the writeSnapshot when the assembled result is 0 rows over a large universe (Bug A pattern)', async () => {
    setUniverse(200); // > PUBLISH_GUARD_EMPTY_UNIVERSE_MIN
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    // Every batch returns empty (the Bug A symptom — 429s swallowed silently
    // become empty results that pass-through).
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      rows: [],
      tickersConsumed: opts.batchSize,
      warnings: [],
      finnhubCalls: opts.batchSize,
      finnhubRateLimited: opts.batchSize, // EVERY call rate-limited
      finnhubErrors: 0,
    }));

    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // The W3 guard refused to swap _latest.
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    // The retention pruner also didn't fire (we didn't publish).
    expect(mocks.pruneOldSnapshots).not.toHaveBeenCalled();
    // The response surfaces the skip decision.
    expect(body.publishAction).toBe('skip');
    expect(body.snapshotId).toBeNull();
    expect(body.resultsCount).toBe(0);

    // The cursor was cleared with status: 'error' so a future scan starts fresh.
    const cursorEntry = Object.keys(store).find(
      (k) => k.startsWith('scanRuns/') && !k.includes('/partial/'),
    );
    expect(cursorEntry).toBeDefined();
    expect(store[cursorEntry!].status).toBe('error');
  });

  it('publishes DEGRADED when failure rate is moderate (10-49%)', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      rows: Array.from({ length: 10 }, (_, i) => ({
        ticker: `R${(opts.startIdx + i).toString().padStart(4, '0')}`,
        buyDollars: 1000 + i,
        awardDollars: 0,
        sellDollars: 0,
        netDollars: 1000 + i,
        buyerCount: 1,
        totalBuys: 1,
        totalAwards: 0,
        totalSells: 0,
        topBuyer: null,
        latestFilingDate: '2026-05-01',
        daysSinceLatest: 5,
        price: null,
        filings: [],
      })),
      tickersConsumed: opts.batchSize,
      warnings: [],
      finnhubCalls: opts.batchSize,
      finnhubRateLimited: Math.floor(opts.batchSize * 0.15), // 15% of calls rate-limited
      finnhubErrors: 0,
    }));

    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.publishAction).toBe('publish-degraded');

    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [, , snap] = mocks.writeSnapshot.mock.calls[0];
    expect(snap.degraded).toBe(true);
    expect(snap.degradedReason).toMatch(/calls failed/);
    // Warnings include the propagated rate-limit summary.
    expect(snap.warnings.some((w: string) => w.includes('rate-limit'))).toBe(true);
  });

  it('publishes NORMALLY (no degraded flag) when the run is healthy', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      rows: Array.from({ length: 20 }, (_, i) => ({
        ticker: `R${(opts.startIdx + i).toString().padStart(4, '0')}`,
        buyDollars: 1000 + i,
        awardDollars: 0,
        sellDollars: 0,
        netDollars: 1000 + i,
        buyerCount: 1,
        totalBuys: 1,
        totalAwards: 0,
        totalSells: 0,
        topBuyer: null,
        latestFilingDate: '2026-05-01',
        daysSinceLatest: 5,
        price: null,
        filings: [],
      })),
      tickersConsumed: opts.batchSize,
      warnings: [],
      finnhubCalls: opts.batchSize,
      finnhubRateLimited: 0,
      finnhubErrors: 0,
    }));

    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.publishAction).toBe('publish');

    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [, , snap] = mocks.writeSnapshot.mock.calls[0];
    expect(snap.degraded).toBeUndefined();
    expect(mocks.pruneOldSnapshots).toHaveBeenCalledTimes(1);
  });

  it('accumulates apiCalls / apiRateLimited / apiErrors across multiple batches', async () => {
    setUniverse(150); // 3 batches of 50
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      rows: [
        {
          ticker: `R${opts.startIdx.toString().padStart(4, '0')}`,
          buyDollars: 1000,
          awardDollars: 0,
          sellDollars: 0,
          netDollars: 1000,
          buyerCount: 1,
          totalBuys: 1,
          totalAwards: 0,
          totalSells: 0,
          topBuyer: null,
          latestFilingDate: '2026-05-01',
          daysSinceLatest: 5,
          price: null,
          filings: [],
        },
      ],
      tickersConsumed: opts.batchSize,
      warnings: [],
      finnhubCalls: opts.batchSize, // 50 per batch
      finnhubRateLimited: 5, // 5 per batch
      finnhubErrors: 1,
    }));

    await handler(postEvent({}), { waitUntil: vi.fn() } as any);
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [, , snap] = mocks.writeSnapshot.mock.calls[0];
    // 3 batches × 50 calls = 150 calls; 3 × 5 = 15 rate-limited; 3 × 1 = 3 errors.
    // 18/150 = 12% → degraded.
    expect(snap.degraded).toBe(true);
    expect(snap.warnings.some((w: string) => w.includes('15/150'))).toBe(true);
  });
});
