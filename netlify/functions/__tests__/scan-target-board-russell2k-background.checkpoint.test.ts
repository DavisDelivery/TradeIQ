// Phase 4h W1 — russell2k bg-worker checkpoint chain integration.
//
// Drives the bg-worker across consecutive invocations using the SAME
// mock Firestore doc store so a cursor written by invocation N is read
// by invocation N+1. Verifies the full chain: fresh → partial → ...
// → terminal, that the snapshot is only written on the terminal batch,
// and that retention pruning fires after publication.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveUniverse: vi.fn(),
  batchScan: vi.fn(),
  enrichNames: vi.fn(),
  computeRegime: vi.fn(),
  regimeToBias: vi.fn(),
  writeSnapshot: vi.fn(),
  pruneOldSnapshots: vi.fn(),
  dispatchReinvoke: vi.fn(),
  // mock the watchdog to be controllable per-invocation
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

vi.mock('../shared/scan-target', async () => {
  const actual = await vi.importActual<any>('../shared/scan-target');
  return {
    ...actual,
    resolveTargetUniverse: mocks.resolveUniverse,
    runTargetScanBatch: mocks.batchScan,
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

vi.mock('../shared/ticker-reference', () => ({
  enrichTickerNames: mocks.enrichNames,
}));

vi.mock('../shared/regime', () => ({
  computeRegime: mocks.computeRegime,
  regimeToMacroBias: mocks.regimeToBias,
}));

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

import { handler } from '../scan-target-board-russell2k-background';

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

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  setOps.length = 0;
  mocks.resolveUniverse.mockReset();
  mocks.batchScan.mockReset();
  mocks.enrichNames.mockReset();
  mocks.computeRegime.mockReset();
  mocks.regimeToBias.mockReset();
  mocks.writeSnapshot.mockReset();
  mocks.pruneOldSnapshots.mockReset();
  mocks.dispatchReinvoke.mockReset();
  mocks.createWatchdog.mockReset();

  mocks.enrichNames.mockResolvedValue({});
  mocks.computeRegime.mockResolvedValue({ regime: 'neutral' });
  mocks.regimeToBias.mockReturnValue(0);
  mocks.writeSnapshot.mockResolvedValue({ snapshotId: 'snap-x' });
  mocks.pruneOldSnapshots.mockResolvedValue({ deleted: 0, kept: 0 });
  mocks.dispatchReinvoke.mockResolvedValue({ ok: true });
});

function setUniverse(size: number) {
  const tickers = Array.from({ length: size }, (_, i) => `T${i.toString().padStart(4, '0')}`);
  mocks.resolveUniverse.mockReturnValue(tickers);
  return tickers;
}

describe('russell2k bg-worker — checkpoint resume chain', () => {
  it('rejects non-POST', async () => {
    const res = (await handler({ httpMethod: 'GET' } as any, {} as any)) as any;
    expect(res.statusCode).toBe(405);
  });

  it('starts fresh: writes cursor, processes batches, reinvokes when watchdog expires', async () => {
    // Universe of 200 tickers, BATCH_SIZE=50 → 4 batches total.
    // Watchdog expires after 2 batches.
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(2));
    mocks.batchScan.mockImplementation(async (opts: any) =>
      ({
        results: Array.from({ length: opts.batchSize }, (_, i) => ({
          ticker: `T${(opts.startIdx + i).toString().padStart(4, '0')}`,
          composite: 50 + i,
        })),
        tickersConsumed: opts.batchSize,
        warnings: [],
      } as any),
    );

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
    const runIds = Object.keys(store).filter((k) => k.startsWith('scanRuns/') && !k.includes('/partial/'));
    expect(runIds).toHaveLength(1);
    const cursor = store[runIds[0]].cursor;
    expect(cursor.nextTickerIndex).toBe(100);
    expect(cursor.partialBatchCount).toBe(2);
    expect(cursor.scoredCount).toBe(100);
    expect(cursor.invocationCount).toBe(1);

    // Partial subcollection has 2 docs.
    const partials = Object.keys(store).filter((k) => k.includes('/partial/'));
    expect(partials).toHaveLength(2);
  });

  it('resumes from cursor on subsequent invocation', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(2));
    mocks.batchScan.mockImplementation(async (opts: any) =>
      ({
        results: Array.from({ length: opts.batchSize }, (_, i) => ({
          ticker: `T${(opts.startIdx + i).toString().padStart(4, '0')}`,
          composite: 50 + i,
        })),
        tickersConsumed: opts.batchSize,
        warnings: [],
      } as any),
    );

    // Invocation 1: writes cursor at nextTickerIndex = 100.
    await handler(postEvent({}), { waitUntil: vi.fn() } as any);
    const runIds = Object.keys(store).filter((k) => k.startsWith('scanRuns/') && !k.includes('/partial/'));
    const runId = runIds[0].split('/')[1];

    // Invocation 2: same watchdog (2 more batches), should finish (200 total).
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(2));
    const res2 = (await handler(
      postEvent({ runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;

    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.ok).toBe(true);
    expect(body2.snapshotId).toBe('snap-x');
    expect(body2.invocationCount).toBe(2);
    expect(body2.resultsCount).toBe(200);

    // writeSnapshot fired exactly once, on the terminal invocation.
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [board, universe, snap] = mocks.writeSnapshot.mock.calls[0];
    expect(board).toBe('target-board');
    expect(universe).toBe('russell2k');
    expect(snap.results).toHaveLength(200);
    expect(snap.universeChecked).toBe(200);

    // Retention pruning ran after publish.
    expect(mocks.pruneOldSnapshots).toHaveBeenCalledTimes(1);
    expect(mocks.pruneOldSnapshots).toHaveBeenCalledWith('target-board', 'russell2k', 30);
  });

  it('completes inside one invocation when the universe fits the budget', async () => {
    setUniverse(50); // exactly one batch
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10)); // generous
    mocks.batchScan.mockImplementation(async (opts: any) =>
      ({
        results: [{ ticker: 'T0000', composite: 90 }],
        tickersConsumed: opts.batchSize,
        warnings: [],
      } as any),
    );
    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.invocationCount).toBe(1);
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchReinvoke).not.toHaveBeenCalled();
  });

  it('no-ops gracefully when resume sees an already-cleared cursor', async () => {
    setUniverse(50);
    // No cursor in store; resume payload with a runId that has no run doc.
    const res = (await handler(
      postEvent({ runId: 'phantom-run', resume: true }),
      {} as any,
    )) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.note).toMatch(/no cursor/);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
  });

  it('does NOT publish a partial snapshot when watchdog trips mid-run', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(1));
    mocks.batchScan.mockImplementation(async (opts: any) =>
      ({
        results: Array.from({ length: opts.batchSize }, (_, i) => ({
          ticker: `T${(opts.startIdx + i).toString().padStart(4, '0')}`,
          composite: 50,
        })),
        tickersConsumed: opts.batchSize,
        warnings: [],
      } as any),
    );
    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(202);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.pruneOldSnapshots).not.toHaveBeenCalled();
    // _latest pointer is the responsibility of writeSnapshot, which we
    // didn't call — so it was never advanced. The partial subcollection
    // exists; the next resume invocation continues from there.
  });

  it('counts invocationCount across the chain — proves resume worked', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(1));
    mocks.batchScan.mockImplementation(async (opts: any) =>
      ({
        results: [{ ticker: 'T', composite: 50 }],
        tickersConsumed: opts.batchSize,
        warnings: [],
      } as any),
    );

    // Invocation 1
    await handler(postEvent({}), { waitUntil: vi.fn() } as any);
    const runIds = Object.keys(store).filter((k) => k.startsWith('scanRuns/') && !k.includes('/partial/'));
    const runId = runIds[0].split('/')[1];

    // Invocation 2
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(1));
    await handler(postEvent({ runId, resume: true }), { waitUntil: vi.fn() } as any);
    expect(store[`scanRuns/${runId}`].cursor.invocationCount).toBe(2);

    // Invocation 3
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(1));
    await handler(postEvent({ runId, resume: true }), { waitUntil: vi.fn() } as any);
    expect(store[`scanRuns/${runId}`].cursor.invocationCount).toBe(3);
  });
});
