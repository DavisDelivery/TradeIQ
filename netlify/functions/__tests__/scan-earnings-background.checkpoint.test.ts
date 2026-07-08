// FIX-1 W1 — earnings bg-worker checkpoint chain.
//
// Mirrors scan-lynch-russell2k-background.checkpoint.test.ts (#96) with
// the earnings-specific additions:
//   - the universe is a CALENDAR resolved once on fresh start and
//     persisted on the run doc (resumes must NOT re-resolve);
//   - a failed/empty calendar resolution ends the run `error` with the
//     reason stamped and publishes NOTHING (the hollow-publish bug that
//     blanked the earnings board in production);
//   - the terminal publish guard skips an empty result set over a
//     large universe (previous `_latest` stays served).

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

vi.mock('../shared/scan-earnings', async () => {
  const actual = await vi.importActual<any>('../shared/scan-earnings');
  return {
    ...actual,
    resolveEarningsScanUniverse: mocks.resolveUniverse,
    runEarningsScanBatch: mocks.batchScan,
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

import { handler } from '../scan-earnings-background';

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

function makeEntry(i: number) {
  return { ticker: `E${i.toString().padStart(4, '0')}`, date: '2026-07-15', hour: 'amc' };
}

function makeSetup(ticker: string, reportDate = '2026-07-15') {
  return {
    ticker,
    price: 100,
    reportDate,
    reportTime: 'amc',
    daysUntil: 7,
    bias: 'neutral',
    strategy: 'test',
    composite: 60,
    rvRank: 50,
    ivr: 50,
    expectedMove: 4,
    avgPriorMove: 3,
    rationale: 'test',
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

  mocks.writeSnapshot.mockResolvedValue({ snapshotId: 'earnings-all-snap-x' });
  mocks.pruneOldSnapshots.mockResolvedValue({ deleted: 0, kept: 0 });
  mocks.dispatchReinvoke.mockResolvedValue({ ok: true });
});

function setCalendar(size: number) {
  const entries = Array.from({ length: size }, (_, i) => makeEntry(i));
  mocks.resolveUniverse.mockResolvedValue({ entries, warnings: [], calendarFailed: false });
  return entries;
}

describe('earnings bg-worker — checkpoint resume chain', () => {
  it('rejects non-POST', async () => {
    const res = (await handler({ httpMethod: 'GET' } as any, {} as any)) as any;
    expect(res.statusCode).toBe(405);
  });

  it('FAILED calendar resolution ends run error, stamps reason, publishes nothing', async () => {
    mocks.resolveUniverse.mockResolvedValue({
      entries: [],
      warnings: ['calendar_range_failed: HTTP 403'],
      calendarFailed: true,
    });
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));

    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.skipped).toBe(true);
    expect(body.reason).toMatch(/calendar resolution FAILED/);

    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.batchScan).not.toHaveBeenCalled();

    const runIds = Object.keys(store).filter(
      (k) => k.startsWith('scanRuns/') && !k.includes('/partial/'),
    );
    expect(runIds).toHaveLength(1);
    expect(store[runIds[0]].status).toBe('error');
    expect(store[runIds[0]].publishAction).toBe('skip');
    expect(store[runIds[0]].publishReason).toMatch(/calendar resolution FAILED/);
  });

  it('EMPTY (but ok) calendar also skips without publishing', async () => {
    mocks.resolveUniverse.mockResolvedValue({ entries: [], warnings: [], calendarFailed: false });
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));

    const res = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.skipped).toBe(true);
    expect(body.reason).toMatch(/0 entries/);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
  });

  it('fresh → mid-chain reinvoke does NOT publish; calendar persisted on run doc', async () => {
    setCalendar(120);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(2));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      setups: Array.from({ length: Math.min(opts.batchSize, 5) }, (_, i) =>
        makeSetup(`E${(opts.startIdx + i).toString().padStart(4, '0')}`),
      ),
      tickersConsumed: opts.batchSize,
      tickersErrored: 0,
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
    const doc = store[runIds[0]];
    expect(doc.cursor.universe).toBe('all');
    expect(doc.cursor.board).toBe('earnings');
    expect(doc.calendarEntries).toHaveLength(120);
    expect(runIds[0].split('/')[1]).toMatch(/^earnings-all-/);
  });

  it('full chain: walk → finalizing → terminal publishes ONE earnings/all snapshot; resume does NOT re-resolve the calendar', async () => {
    setCalendar(80); // 2 clean batches of 40
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      setups: opts.entries
        .slice(opts.startIdx, opts.startIdx + opts.batchSize)
        .map((e: any) => makeSetup(e.ticker)),
      tickersConsumed: Math.min(opts.batchSize, opts.entries.length - opts.startIdx),
      tickersErrored: 0,
      warnings: [],
    }));

    const res1 = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    expect(res1.statusCode).toBe(202);
    const body1 = JSON.parse(res1.body);
    expect(body1.phase).toBe('finalizing');
    expect(mocks.resolveUniverse).toHaveBeenCalledTimes(1);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();

    const res2 = (await handler(
      postEvent({ runId: body1.runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.snapshotId).toBe('earnings-all-snap-x');
    expect(body2.resultsCount).toBe(80);
    // Resume must not have re-resolved the calendar.
    expect(mocks.resolveUniverse).toHaveBeenCalledTimes(1);

    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    const [board, universe, snap] = mocks.writeSnapshot.mock.calls[0];
    expect(board).toBe('earnings');
    expect(universe).toBe('all');
    expect(snap.results).toHaveLength(80);
    expect(snap.universeChecked).toBe(80);
    expect(mocks.pruneOldSnapshots).toHaveBeenCalledWith('earnings', 'all', 30);

    // Partials cleaned; run doc stamped done + publish decision.
    expect(Object.keys(store).filter((k) => k.includes('/partial/'))).toHaveLength(0);
    const runDoc = store[`scanRuns/${body1.runId}`];
    expect(runDoc.status).toBe('done');
    expect(runDoc.publishAction).toBe('publish');
  });

  it('terminal publish guard: empty results over large universe → skip, status error, reason stamped', async () => {
    setCalendar(150);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    mocks.batchScan.mockImplementation(async (opts: any) => ({
      setups: [],
      tickersConsumed: opts.batchSize,
      tickersErrored: 0,
      warnings: [],
    }));

    const res1 = (await handler(postEvent({}), { waitUntil: vi.fn() } as any)) as any;
    const body1 = JSON.parse(res1.body);
    expect(body1.phase).toBe('finalizing');

    const res2 = (await handler(
      postEvent({ runId: body1.runId, resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    const body2 = JSON.parse(res2.body);
    expect(body2.snapshotId).toBeNull();
    expect(body2.publishAction).toBe('skip');
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();

    const runDoc = store[`scanRuns/${body1.runId}`];
    expect(runDoc.status).toBe('error');
    expect(runDoc.publishAction).toBe('skip');
    expect(runDoc.publishReason).toMatch(/empty result/);
  });

  it('stale resume (no cursor) is a safe no-op', async () => {
    setCalendar(100);
    mocks.createWatchdog.mockReturnValue(fakeWatchdog(10));
    const res = (await handler(
      postEvent({ runId: 'earnings-all-stale', resume: true }),
      { waitUntil: vi.fn() } as any,
    )) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).note).toMatch(/already complete/);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.batchScan).not.toHaveBeenCalled();
  });
});
