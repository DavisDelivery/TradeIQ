// russell2k lynch bg-worker checkpoint chain.
//
// Companion to scan-insider-russell2k-background.checkpoint.test.ts: the
// worker drives the same checkpoint-resume machinery but a different
// per-batch function (runLynchScanBatch) producing LynchCandidate rows
// sorted by score. Verifies lynch/russell2k wiring + terminal-only publish
// + resume chain + stale-resume no-op.

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
    get: async () => ({ exists: store[path] !== undefined, data: () => store[path] }),
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
  const matchDocs = () =>
    Object.keys(store)
      .filter(
        (p) =>
          p.startsWith(`${prefix}/`) &&
          p.split('/').length === prefix.split('/').length + 1,
      )
      .map((p) => ({ id: p.split('/').slice(-1)[0], data: () => store[p], ref: { path: p } }));
  return {
    doc: (id: string) => docHandle(`${prefix}/${id}`),
    orderBy: () => ({
      get: async () => {
        const docs = matchDocs().sort((a, b) => a.ref.path.localeCompare(b.ref.path));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    }),
    get: async () => {
      const docs = matchDocs();
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

vi.mock('../shared/scan-lynch', async () => {
  const actual = await vi.importActual<any>('../shared/scan-lynch');
  return {
    ...actual,
    resolveLynchUniverse: mocks.resolveUniverse,
    runLynchScanBatch: mocks.batchScan,
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
  return { ...actual, dispatchReinvoke: mocks.dispatchReinvoke };
});

vi.mock('../shared/backtest-resume/watchdog', () => ({
  createWatchdog: mocks.createWatchdog,
}));

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

vi.mock('../shared/model-version', () => ({ MODEL_VERSION: 'test-model' }));

import { handler } from '../scan-lynch-russell2k-background';

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

function makeLynchCandidate(ticker: string, score = 50) {
  return {
    ticker,
    name: `Name ${ticker}`,
    sector: 'Industrials',
    score,
    confidence: 0.6,
    rationale: 'test',
    signals: {},
    side: 'long',
    signal: { signal: 'BUY' },
    price: 100,
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  mocks.resolveUniverse.mockReset();
  mocks.batchScan.mockReset();
  mocks.writeSnapshot.mockReset();
  mocks.pruneOldSnapshots.mockReset();
  mocks.dispatchReinvoke.mockReset();
  mocks.createWatchdog.mockReset();

  mocks.writeSnapshot.mockResolvedValue({ snapshotId: 'lynch-russell2k-snap-x' });
  mocks.pruneOldSnapshots.mockResolvedValue({ deleted: 0, kept: 0 });
  mocks.dispatchReinvoke.mockResolvedValue({ ok: true });
});

function setUniverse(size: number) {
  const tickers = Array.from({ length: size }, (_, i) => ({
    ticker: `R${i.toString().padStart(4, '0')}`,
    name: `Name ${i}`,
    sector: 'Industrials',
  }));
  mocks.resolveUniverse.mockReturnValue(tickers);
  return tickers;
}

describe('russell2k lynch bg-worker — checkpoint resume chain', () => {
  it('rejects non-POST', async () => {
    const res = (await handler({ httpMethod: 'GET' } as any, {} as any)) as any;
    expect(res.statusCode).toBe(405);
  });

  it('fresh → mid-chain reinvoke does NOT publish; cursor keyed to lynch/russell2k', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(2));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      candidates: Array.from({ length: opts.batchSize }, (_, i) =>
        makeLynchCandidate(`R${(opts.startIdx + i).toString().padStart(4, '0')}`, 50 + i),
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
    expect(cursor.universe).toBe('russell2k');
    expect(cursor.board).toBe('lynch');
    expect(runIds[0].split('/')[1]).toMatch(/^lynch-russell2k-/);
  });

  it('full chain: walk → finalizing → terminal writes ONE snapshot to lynch/russell2k, sorted by score desc', async () => {
    setUniverse(100); // 2 clean batches of 50
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      candidates: Array.from({ length: opts.batchSize }, (_, i) =>
        makeLynchCandidate(`R${(opts.startIdx + i).toString().padStart(4, '0')}`, opts.startIdx + i),
      ),
      tickersConsumed: opts.batchSize,
      warnings: [],
    }));

    const res1 = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res1.statusCode).toBe(202);
    const body1 = JSON.parse(res1.body);
    expect(body1.phase).toBe('finalizing');
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();

    const res2 = (await handler(
      postEvent({ runId: body1.runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.snapshotId).toBe('lynch-russell2k-snap-x');
    expect(body2.resultsCount).toBe(100);

    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [board, universe, snap] = mocks.writeSnapshot.mock.calls[0];
    expect(board).toBe('lynch');
    expect(universe).toBe('russell2k');
    expect(snap.results).toHaveLength(100);
    expect(snap.universeChecked).toBe(100);
    expect(mocks.pruneOldSnapshots).toHaveBeenCalledWith('lynch', 'russell2k', 30);

    expect(Object.keys(store).filter((k) => k.includes('/partial/'))).toHaveLength(0);
    const results = snap.results as Array<{ score: number }>;
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('stale resume (no cursor) is a safe no-op', async () => {
    setUniverse(100);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    const res = (await handler(
      postEvent({ runId: 'lynch-russell2k-stale', resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).note).toMatch(/already complete/);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.batchScan).not.toHaveBeenCalled();
  });
});
