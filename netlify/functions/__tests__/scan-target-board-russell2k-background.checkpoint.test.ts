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

  it('resumes from cursor; finishes the walk; then runs the terminal step in a separate finalizing invocation', async () => {
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

    // Invocation 1: walks 100 tickers, watchdog trips.
    await handler(postEvent({}), { waitUntil: vi.fn() } as any);
    const runIds = Object.keys(store).filter((k) => k.startsWith('scanRuns/') && !k.includes('/partial/'));
    const runId = runIds[0].split('/')[1];

    // Invocation 2: walks the remaining 100 tickers, hits the end of
    // the universe, dispatches the finalizing reinvoke. Phase 4p W1 —
    // the terminal step is NEVER inline anymore.
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(2));
    const res2 = (await handler(
      postEvent({ runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res2.statusCode).toBe(202);
    expect(JSON.parse(res2.body).phase).toBe('finalizing');
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(store[`scanRuns/${runId}`].cursor.phase).toBe('finalizing');

    // Invocation 3: finalizing — skips the batch loop entirely and
    // runs only the terminal step with a fresh budget.
    const batchCallsBeforeFinalizing = mocks.batchScan.mock.calls.length;
    const res3 = (await handler(
      postEvent({ runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res3.statusCode).toBe(200);
    const body3 = JSON.parse(res3.body);
    expect(body3.ok).toBe(true);
    expect(body3.snapshotId).toBe('snap-x');
    expect(body3.invocationCount).toBe(3);
    expect(body3.resultsCount).toBe(200);
    // Finalizing must not invoke the per-batch scoring function again.
    expect(mocks.batchScan.mock.calls.length).toBe(batchCallsBeforeFinalizing);

    // writeSnapshot fired exactly once — on the finalizing invocation.
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

  it('walks the universe in one invocation but still defers terminal work to a finalizing reinvoke (Phase 4p W1)', async () => {
    setUniverse(50); // exactly one batch
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10)); // generous
    mocks.batchScan.mockImplementation(async (opts: any) =>
      ({
        results: [{ ticker: 'T0000', composite: 90 }],
        tickersConsumed: opts.batchSize,
        warnings: [],
      } as any),
    );

    // Walk invocation: returns 202 with phase: 'finalizing'; the
    // terminal step is NOT crammed in here (this is the whole 4p fix).
    const res1 = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res1.statusCode).toBe(202);
    const body1 = JSON.parse(res1.body);
    expect(body1.phase).toBe('finalizing');
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.dispatchReinvoke).toHaveBeenCalledTimes(1); // the finalizing reinvoke

    // Finalizing invocation: terminal step runs, snapshot lands.
    const res2 = (await handler(
      postEvent({ runId: body1.runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.invocationCount).toBe(2);
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
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

  // Phase 4p W1 — finalizing-phase entry behavior.
  it('a finalizing cursor on entry skips the batch loop entirely and runs only the terminal step (W1)', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10)); // would let many batches run
    mocks.batchScan.mockImplementation(async (opts: any) =>
      ({
        results: [{ ticker: 'preexisting', composite: 80 }],
        tickersConsumed: opts.batchSize,
        warnings: [],
      } as any),
    );

    // Pre-stage a finalizing cursor + partial-batch data, as if a prior
    // walk invocation finished and dispatched the finalizing reinvoke.
    const runId = 'target-board-russell2k-prestaged';
    store[`scanRuns/${runId}`] = {
      status: 'running',
      updatedAt: '2026-05-18T09:30:00.000Z',
      cursor: {
        universe: 'russell2k',
        board: 'target-board',
        status: 'running',
        phase: 'finalizing',
        nextTickerIndex: 200,
        totalTickers: 200,
        invocationCount: 2,
        startedAt: '2026-05-18T09:00:00.000Z',
        lastInvocationStartedAt: '2026-05-18T09:25:00.000Z',
        partialBatchCount: 1,
        scoredCount: 1,
        reinvokeAttempts: 1,
        lastReinvokeAt: '2026-05-18T09:30:00.000Z',
      },
    };
    store[`scanRuns/${runId}/partial/batch-000000`] = {
      batchIndex: 0,
      rowCount: 1,
      rows: [{ ticker: 'PRE', composite: 95 }],
    };

    const res = (await handler(
      postEvent({ runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.resultsCount).toBe(1);
    expect(body.snapshotId).toBe('snap-x');

    // CRITICAL — the finalizing invocation must NOT have called the per-batch
    // scoring function. That's the whole point of W1: terminal step runs alone.
    expect(mocks.batchScan).not.toHaveBeenCalled();
    expect(mocks.dispatchReinvoke).not.toHaveBeenCalled();

    // Snapshot persisted from the pre-staged partial batch.
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [, , snap] = mocks.writeSnapshot.mock.calls[0];
    expect(snap.results).toEqual([{ ticker: 'PRE', composite: 95 }]);
  });

  // Phase 4p W2 — idempotency: a killed-and-retried finalizing invocation
  // must redo assemble+write cleanly. The contract: same runId, same
  // partial batches, terminal step runs twice without corrupting state.
  it('terminal step is idempotent — a re-fired finalizing invocation redoes the work without error (W2)', async () => {
    setUniverse(100);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));

    const runId = 'target-board-russell2k-idempotent';
    // Pre-stage a finalizing cursor + partial data.
    store[`scanRuns/${runId}`] = {
      status: 'running',
      updatedAt: '2026-05-18T09:00:00.000Z',
      cursor: {
        universe: 'russell2k',
        board: 'target-board',
        status: 'running',
        phase: 'finalizing',
        nextTickerIndex: 100,
        totalTickers: 100,
        invocationCount: 2,
        startedAt: '2026-05-18T08:50:00.000Z',
        lastInvocationStartedAt: '2026-05-18T08:55:00.000Z',
        partialBatchCount: 2,
        scoredCount: 2,
      },
    };
    store[`scanRuns/${runId}/partial/batch-000000`] = {
      batchIndex: 0,
      rowCount: 1,
      rows: [{ ticker: 'X', composite: 70 }],
    };
    store[`scanRuns/${runId}/partial/batch-000001`] = {
      batchIndex: 1,
      rowCount: 1,
      rows: [{ ticker: 'Y', composite: 80 }],
    };

    // First finalizing invocation: completes, clears cursor, deletes partials.
    const res1 = (await handler(
      postEvent({ runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res1.statusCode).toBe(200);
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    // The cursor was cleared.
    expect(store[`scanRuns/${runId}`].cursor).toBeNull();
    expect(store[`scanRuns/${runId}`].status).toBe('done');

    // Now SIMULATE a kill-and-retry: the finalizing invocation's
    // platform process died mid-write before the cursor was cleared.
    // To re-create that state we manually put the cursor back into a
    // finalizing state and re-stage the partials.
    store[`scanRuns/${runId}`] = {
      ...store[`scanRuns/${runId}`],
      status: 'running',
      cursor: {
        universe: 'russell2k',
        board: 'target-board',
        status: 'running',
        phase: 'finalizing',
        nextTickerIndex: 100,
        totalTickers: 100,
        invocationCount: 3,
        startedAt: '2026-05-18T08:50:00.000Z',
        lastInvocationStartedAt: '2026-05-18T09:10:00.000Z',
        partialBatchCount: 2,
        scoredCount: 2,
      },
    };
    store[`scanRuns/${runId}/partial/batch-000000`] = {
      batchIndex: 0, rowCount: 1, rows: [{ ticker: 'X', composite: 70 }],
    };
    store[`scanRuns/${runId}/partial/batch-000001`] = {
      batchIndex: 1, rowCount: 1, rows: [{ ticker: 'Y', composite: 80 }],
    };

    // Second finalizing invocation must succeed — that's the W2 idempotency contract.
    const res2 = (await handler(
      postEvent({ runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.snapshotId).toBe('snap-x');
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(2); // second invocation re-wrote
    expect(store[`scanRuns/${runId}`].cursor).toBeNull();
    expect(store[`scanRuns/${runId}`].status).toBe('done');
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
