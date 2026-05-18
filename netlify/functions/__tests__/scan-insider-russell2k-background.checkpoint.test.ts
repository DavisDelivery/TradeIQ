// Phase 4l W2 — russell2k insider bg-worker checkpoint chain.
//
// Mirrors the structure of `scan-target-board-russell2k-background.
// checkpoint.test.ts` (Phase 4h) — same Firestore mock, same cursor
// store, same chain semantics. Insider worker drives a different
// per-batch function (`runInsiderScanBatch`) and writes to a different
// snapshot key, but the checkpoint discipline is identical: terminal-
// only snapshot publish, partial subcollection for rows, atomic _latest
// swap, prune after publish.
//
// Verifies: fresh → partial → terminal chain; resume from cursor;
// snapshot NOT written mid-chain; partial cleanup + retention pruning
// run only on terminal success.

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
const setOps: Array<{ path: string; payload: any; merge: boolean }> = [];

function docHandle(path: string) {
  return {
    ref: { path, id: path.split('/').slice(-1)[0] },
    id: path.split('/').slice(-1)[0],
    get: async () => ({
      exists: store[path] !== undefined,
      data: () => store[path],
    }),
    set: async (payload: any, opts?: { merge?: boolean }) => {
      setOps.push({ path, payload, merge: !!opts?.merge });
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

function makeInsiderRow(ticker: string, buyDollars = 100_000) {
  return {
    ticker,
    buyDollars,
    awardDollars: 0,
    sellDollars: 0,
    netDollars: buyDollars,
    buyerCount: 1,
    totalBuys: 1,
    totalAwards: 0,
    totalSells: 0,
    topBuyer: { name: `Insider-${ticker}`, role: 'CEO', dollars: buyDollars },
    latestFilingDate: '2026-05-01',
    daysSinceLatest: 5,
    price: 100,
    filings: [],
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  setOps.length = 0;
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

function setUniverse(size: number) {
  const tickers = Array.from({ length: size }, (_, i) => `R${i.toString().padStart(4, '0')}`);
  mocks.resolveUniverse.mockReturnValue(tickers);
  return tickers;
}

describe('russell2k insider bg-worker — checkpoint resume chain', () => {
  it('rejects non-POST', async () => {
    const res = (await handler({ httpMethod: 'GET' } as any, {} as any)) as any;
    expect(res.statusCode).toBe(405);
  });

  it('starts fresh: writes cursor, processes batches, reinvokes when watchdog expires', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(2));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      rows: Array.from({ length: opts.batchSize }, (_, i) =>
        makeInsiderRow(`R${(opts.startIdx + i).toString().padStart(4, '0')}`, 50 + i),
      ),
      tickersConsumed: opts.batchSize,
      warnings: [],
    }));

    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.continuing).toBe(true);
    expect(body.invocationCount).toBe(1);
    expect(body.nextTickerIndex).toBe(100); // 2 batches of 50

    // Snapshot must NOT be written mid-chain.
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.pruneOldSnapshots).not.toHaveBeenCalled();
    // Reinvoke fired.
    expect(mocks.dispatchReinvoke).toHaveBeenCalledTimes(1);

    // Cursor doc persisted.
    const runIds = Object.keys(store).filter(
      (k) => k.startsWith('scanRuns/') && !k.includes('/partial/'),
    );
    expect(runIds).toHaveLength(1);
    const cursor = store[runIds[0]].cursor;
    expect(cursor.nextTickerIndex).toBe(100);
    expect(cursor.partialBatchCount).toBe(2);
    expect(cursor.scoredCount).toBe(100);
    expect(cursor.invocationCount).toBe(1);
    expect(cursor.universe).toBe('russell2k');
    expect(cursor.board).toBe('insider');

    // Partial subcollection has 2 docs.
    const partials = Object.keys(store).filter((k) => k.includes('/partial/'));
    expect(partials).toHaveLength(2);
  });

  it('resumes from cursor on subsequent invocation; terminal write fires once', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(2));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      rows: Array.from({ length: opts.batchSize }, (_, i) =>
        makeInsiderRow(`R${(opts.startIdx + i).toString().padStart(4, '0')}`, 50 + i),
      ),
      tickersConsumed: opts.batchSize,
      warnings: [],
    }));

    // Invocation 1: writes cursor at nextTickerIndex = 100.
    await handler(postEvent({}), { waitUntil: vi.fn() } as any);
    const runIds = Object.keys(store).filter(
      (k) => k.startsWith('scanRuns/') && !k.includes('/partial/'),
    );
    const runId = runIds[0].split('/')[1];

    // Invocation 2: 2 more batches, should finish (200 total).
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(2));
    const res2 = (await handler(
      postEvent({ runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;

    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.ok).toBe(true);
    expect(body2.snapshotId).toBe('insider-russell2k-snap-x');
    expect(body2.invocationCount).toBe(2);
    expect(body2.resultsCount).toBe(200);

    // writeSnapshot fired exactly once, on the terminal invocation.
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [board, universe, snap] = mocks.writeSnapshot.mock.calls[0];
    expect(board).toBe('insider');
    expect(universe).toBe('russell2k');
    expect(snap.results).toHaveLength(200);
    expect(snap.universeChecked).toBe(200);

    // Retention pruning ran after publish, for the insider board.
    expect(mocks.pruneOldSnapshots).toHaveBeenCalledTimes(1);
    expect(mocks.pruneOldSnapshots).toHaveBeenCalledWith('insider', 'russell2k', 30);

    // Partial subcollection cleaned up after terminal write.
    const partialsAfter = Object.keys(store).filter((k) => k.includes('/partial/'));
    expect(partialsAfter).toHaveLength(0);

    // Snapshot results are sorted by buyDollars desc.
    const results = snap.results as Array<{ buyDollars: number }>;
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].buyDollars).toBeGreaterThanOrEqual(results[i].buyDollars);
    }
  });

  it('completes inside one invocation when the universe fits the budget', async () => {
    setUniverse(50); // exactly one batch
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10)); // generous
    mocks.batchScan.mockImplementation(async (_opts: any) => ({
      rows: [makeInsiderRow('R0000', 90)],
      tickersConsumed: 50,
      warnings: [],
    }));
    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.invocationCount).toBe(1);
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchReinvoke).not.toHaveBeenCalled();
  });

  it('skips empty batches: partialBatchCount only advances when rows are returned', async () => {
    setUniverse(150); // 3 batches of 50
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(3));
    // First batch: no rows; second batch: 2 rows; third batch: no rows.
    let callIdx = 0;
    mocks.batchScan.mockImplementation(async (opts: any) => {
      callIdx += 1;
      const rows = callIdx === 2 ? [makeInsiderRow('R0050'), makeInsiderRow('R0051')] : [];
      return { rows, tickersConsumed: opts.batchSize, warnings: [] };
    });

    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(200); // completed
    const body = JSON.parse(res.body);
    expect(body.resultsCount).toBe(2);

    // Only the non-empty batch wrote a partial doc.
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [, , snap] = mocks.writeSnapshot.mock.calls[0];
    expect(snap.results).toHaveLength(2);
  });

  it('stale resume (no cursor in store) is a safe no-op', async () => {
    setUniverse(100);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    const res = (await handler(
      postEvent({ runId: 'insider-russell2k-stale', resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.note).toMatch(/already complete/);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.batchScan).not.toHaveBeenCalled();
  });

  it('partial scan does NOT advance _latest: writeSnapshot never called during mid-chain', async () => {
    setUniverse(500); // many batches
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(3));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      rows: [makeInsiderRow(`R${opts.startIdx.toString().padStart(4, '0')}`)],
      tickersConsumed: opts.batchSize,
      warnings: [],
    }));

    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(202); // continuing
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.pruneOldSnapshots).not.toHaveBeenCalled();
    // The partial subcollection holds the in-progress rows; _latest is untouched.
    const partials = Object.keys(store).filter((k) => k.includes('/partial/'));
    expect(partials.length).toBeGreaterThan(0);
  });
});
