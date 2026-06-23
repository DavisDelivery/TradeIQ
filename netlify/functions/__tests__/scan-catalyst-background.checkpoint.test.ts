// catalyst bg-worker checkpoint chain (sp500 comprehensive + russell2k wiring).
//
// Catalyst is the heaviest board; both sp500 and russell2k were dead since
// the PR #66 universe expansion. These workers are clones of the proven
// insider/lynch resume workers driving runCatalystScanBatch. This suite
// asserts catalyst-specific behavior: composite-desc ordering, the
// provider-null warning surfaced at finalize, and the empty-universe skip
// guard (failure-rate branch intentionally disabled for catalyst).

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

vi.mock('../shared/scan-catalyst', async () => {
  const actual = await vi.importActual<any>('../shared/scan-catalyst');
  return {
    ...actual,
    resolveCatalystUniverse: mocks.resolveUniverse,
    runCatalystScanBatch: mocks.batchScan,
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

import { handler as sp500Handler } from '../scan-catalyst-sp500-background';
import { handler as russellHandler } from '../scan-catalyst-russell2k-background';

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

function makeCatalystPick(ticker: string, composite = 50) {
  return { ticker, name: `Name ${ticker}`, sector: 'Tech', composite, conviction: 'low', price: 100, priceChangePct: 0, setupLabels: [] };
}

function setUniverse(size: number) {
  const tickers = Array.from({ length: size }, (_, i) => ({
    ticker: `C${i.toString().padStart(4, '0')}`,
    name: `Name ${i}`,
    sector: 'Tech',
  }));
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

  mocks.writeSnapshot.mockResolvedValue({ snapshotId: 'catalyst-snap-x' });
  mocks.pruneOldSnapshots.mockResolvedValue({ deleted: 0, kept: 0 });
  mocks.dispatchReinvoke.mockResolvedValue({ ok: true });
});

describe('sp500 catalyst bg-worker — checkpoint resume chain', () => {
  it('rejects non-POST', async () => {
    const res = (await sp500Handler({ httpMethod: 'GET' } as any, {} as any)) as any;
    expect(res.statusCode).toBe(405);
  });

  it('fresh → mid-chain reinvoke does NOT publish; cursor keyed to catalyst/sp500', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(2));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      picks: Array.from({ length: opts.batchSize }, (_, i) =>
        makeCatalystPick(`C${(opts.startIdx + i).toString().padStart(4, '0')}`, 50 + i),
      ),
      tickersConsumed: opts.batchSize,
      providerNullSkips: 0,
      warnings: [],
    }));

    const res = (await sp500Handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).continuing).toBe(true);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.dispatchReinvoke).toHaveBeenCalledTimes(1);

    const runIds = Object.keys(store).filter(
      (k) => k.startsWith('scanRuns/') && !k.includes('/partial/'),
    );
    const cursor = store[runIds[0]].cursor;
    expect(cursor.universe).toBe('sp500');
    expect(cursor.board).toBe('catalyst');
    expect(runIds[0].split('/')[1]).toMatch(/^catalyst-sp500-/);
  });

  it('full chain: terminal writes ONE snapshot to catalyst/sp500, composite desc, with provider-null warning', async () => {
    setUniverse(100); // 40 + 40 + 20 → but batches return full 40; use 80 clean instead
    mocks.resolveUniverse.mockReturnValue(
      Array.from({ length: 80 }, (_, i) => ({ ticker: `C${i.toString().padStart(4, '0')}`, name: `N${i}`, sector: 'Tech' })),
    );
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      picks: Array.from({ length: opts.batchSize }, (_, i) =>
        makeCatalystPick(`C${(opts.startIdx + i).toString().padStart(4, '0')}`, opts.startIdx + i),
      ),
      tickersConsumed: opts.batchSize,
      providerNullSkips: 3,
      warnings: [],
    }));

    const res1 = (await sp500Handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    const body1 = JSON.parse(res1.body);
    expect(body1.phase).toBe('finalizing');
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();

    const res2 = (await sp500Handler(
      postEvent({ runId: body1.runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.body).resultsCount).toBe(80);

    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [board, universe, snap] = mocks.writeSnapshot.mock.calls[0];
    expect(board).toBe('catalyst');
    expect(universe).toBe('sp500');
    expect(snap.results).toHaveLength(80);
    // composite desc
    const results = snap.results as Array<{ composite: number }>;
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].composite).toBeGreaterThanOrEqual(results[i].composite);
    }
    // provider-null skips (2 batches × 3) surfaced as a warning
    expect(snap.warnings.some((w: string) => /provider data unavailable.*6 tickers/.test(w))).toBe(true);
    expect(mocks.pruneOldSnapshots).toHaveBeenCalledWith('catalyst', 'sp500', 30);
  });

  it('empty result over a large universe SKIPS publish (guard protects _latest)', async () => {
    setUniverse(200);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    // Every ticker skipped (transient provider outage) → zero picks.
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      picks: [],
      tickersConsumed: opts.batchSize,
      providerNullSkips: opts.batchSize,
      warnings: [],
    }));

    const res1 = (await sp500Handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    const body1 = JSON.parse(res1.body);
    expect(body1.phase).toBe('finalizing');

    const res2 = (await sp500Handler(
      postEvent({ runId: body1.runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.body).publishAction).toBe('skip');
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
  });

  it('stale resume (no cursor) is a safe no-op', async () => {
    setUniverse(100);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    const res = (await sp500Handler(
      postEvent({ runId: 'catalyst-sp500-stale', resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).note).toMatch(/already complete/);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
  });
});

describe('russell2k catalyst bg-worker — wiring', () => {
  it('full chain writes ONE snapshot to catalyst/russell2k with catalyst-russell2k- runId', async () => {
    mocks.resolveUniverse.mockReturnValue(
      Array.from({ length: 80 }, (_, i) => ({ ticker: `C${i.toString().padStart(4, '0')}`, name: `N${i}`, sector: 'Tech' })),
    );
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      picks: Array.from({ length: opts.batchSize }, (_, i) =>
        makeCatalystPick(`C${(opts.startIdx + i).toString().padStart(4, '0')}`, 50 + i),
      ),
      tickersConsumed: opts.batchSize,
      providerNullSkips: 0,
      warnings: [],
    }));

    const res1 = (await russellHandler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    const body1 = JSON.parse(res1.body);
    expect(body1.runId).toMatch(/^catalyst-russell2k-/);

    const res2 = (await russellHandler(
      postEvent({ runId: body1.runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res2.statusCode).toBe(200);
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [board, universe] = mocks.writeSnapshot.mock.calls[0];
    expect(board).toBe('catalyst');
    expect(universe).toBe('russell2k');
  });
});
