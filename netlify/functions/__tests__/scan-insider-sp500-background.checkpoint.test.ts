// sp500 insider bg-worker checkpoint chain.
//
// Lean companion to scan-insider-russell2k-background.checkpoint.test.ts:
// the worker is a verbatim clone driving the same machinery, so this test
// focuses on the sp500-specific wiring (board/universe/snapshot key) plus
// the core chain invariants — terminal-only publish and stale-resume
// no-op — rather than re-proving every edge case the russell2k suite
// already covers.

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

import { handler } from '../scan-insider-sp500-background';

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

  mocks.writeSnapshot.mockResolvedValue({ snapshotId: 'insider-sp500-snap-x' });
  mocks.pruneOldSnapshots.mockResolvedValue({ deleted: 0, kept: 0 });
  mocks.dispatchReinvoke.mockResolvedValue({ ok: true });
});

function setUniverse(size: number) {
  const tickers = Array.from({ length: size }, (_, i) => `S${i.toString().padStart(4, '0')}`);
  mocks.resolveUniverse.mockReturnValue(tickers);
  return tickers;
}

describe('sp500 insider bg-worker — checkpoint resume chain', () => {
  it('rejects non-POST', async () => {
    const res = (await handler({ httpMethod: 'GET' } as any, {} as any)) as any;
    expect(res.statusCode).toBe(405);
  });

  it('fresh → mid-chain reinvoke does NOT publish, cursor is keyed to sp500/insider', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(2));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      rows: Array.from({ length: opts.batchSize }, (_, i) =>
        makeInsiderRow(`S${(opts.startIdx + i).toString().padStart(4, '0')}`, 50 + i),
      ),
      tickersConsumed: opts.batchSize,
      warnings: [],
    }));

    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).continuing).toBe(true);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.dispatchReinvoke).toHaveBeenCalledTimes(1);

    const runIds = Object.keys(store).filter(
      (k) => k.startsWith('scanRuns/') && !k.includes('/partial/'),
    );
    expect(runIds).toHaveLength(1);
    const cursor = store[runIds[0]].cursor;
    expect(cursor.universe).toBe('sp500');
    expect(cursor.board).toBe('insider');
    // runId is minted with the insider-sp500- prefix.
    expect(runIds[0].split('/')[1]).toMatch(/^insider-sp500-/);
  });

  it('full chain: walk → finalizing → terminal writes ONE snapshot to insider/sp500', async () => {
    setUniverse(100); // 2 clean batches of 50
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10)); // walk in one go
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      rows: Array.from({ length: opts.batchSize }, (_, i) =>
        makeInsiderRow(`S${(opts.startIdx + i).toString().padStart(4, '0')}`, 50 + i),
      ),
      tickersConsumed: opts.batchSize,
      warnings: [],
    }));

    // Walk invocation → 202 finalizing, no snapshot yet.
    const res1 = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res1.statusCode).toBe(202);
    const body1 = JSON.parse(res1.body);
    expect(body1.phase).toBe('finalizing');
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();

    // Finalizing invocation → terminal step writes the snapshot.
    const res2 = (await handler(
      postEvent({ runId: body1.runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.snapshotId).toBe('insider-sp500-snap-x');
    expect(body2.resultsCount).toBe(100);

    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [board, universe, snap] = mocks.writeSnapshot.mock.calls[0];
    expect(board).toBe('insider');
    expect(universe).toBe('sp500');
    expect(snap.results).toHaveLength(100);
    expect(snap.universeChecked).toBe(100);
    expect(mocks.pruneOldSnapshots).toHaveBeenCalledWith('insider', 'sp500', 30);

    // Partials cleaned up after publish.
    expect(Object.keys(store).filter((k) => k.includes('/partial/'))).toHaveLength(0);
    // Results sorted by buyDollars desc.
    const results = snap.results as Array<{ buyDollars: number }>;
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].buyDollars).toBeGreaterThanOrEqual(results[i].buyDollars);
    }
  });

  it('stale resume (no cursor in store) is a safe no-op', async () => {
    setUniverse(100);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    const res = (await handler(
      postEvent({ runId: 'insider-sp500-stale', resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).note).toMatch(/already complete/);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.batchScan).not.toHaveBeenCalled();
  });
});
