// Phase 4o W2 — /api/scan-status diagnostic endpoint.
//
// Verifies: input validation, doc-id prefix filtering, cursor passthrough,
// `invocationAgeMs` / `scanAgeMs` derivation. No live Firestore.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const store: Record<string, any> = {};

// Platform-faithful Firestore descending-range semantics on the doc id:
// the result set is exactly { id : lower <= id <= upper }, ordered desc,
// capped at `max`. Production passes upper = prefix + '', lower =
// prefix — the canonical descending prefix scan. A degenerate query
// (upper === lower === prefix) yields NOTHING here, so this test fails if
// the U+F8FF sentinel is ever dropped (Wave 5 policy: faithful range
// semantics, not a mock that pins the query's behavior regardless of bounds).
function makeDocs(lower: string, upper: string, max: number) {
  return Object.keys(store)
    .filter((k) => k.startsWith('scanRuns/'))
    .map((k) => k.slice('scanRuns/'.length))
    .filter((id) => id >= lower && id <= upper)
    .sort()
    .reverse()
    .slice(0, max)
    .map((id) => ({ id, data: () => store['scanRuns/' + id] }));
}

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: (cn: string) => ({
      orderBy: (_field: string, _dir?: string) => ({
        startAt: (upper: string) => ({
          endAt: (lower: string) => ({
            limit: (n: number) => ({
              get: async () => {
                if (cn !== 'scanRuns') return { docs: [] };
                const docs = makeDocs(lower, upper, n);
                return { docs };
              },
            }),
          }),
        }),
      }),
    }),
  })),
}));

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

import { handler } from '../scan-status';

function get(qs: Record<string, string> = {}): any {
  return { httpMethod: 'GET', queryStringParameters: qs } as any;
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('/api/scan-status', () => {
  it('rejects invalid board', async () => {
    const res = (await handler(get({ board: 'bogus' }), {} as any)) as any;
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid universe', async () => {
    const res = (await handler(get({ universe: 'bogus' }), {} as any)) as any;
    expect(res.statusCode).toBe(400);
  });

  it('defaults to target-board + russell2k (the Bug B target)', async () => {
    store['scanRuns/target-board-russell2k-20260518-230000'] = {
      status: 'running',
      updatedAt: '2026-05-18T23:01:00.000Z',
      cursor: {
        universe: 'russell2k',
        board: 'target-board',
        status: 'running',
        nextTickerIndex: 200,
        totalTickers: 2037,
        invocationCount: 2,
        startedAt: '2026-05-18T23:00:00.000Z',
        lastInvocationStartedAt: '2026-05-18T23:00:30.000Z',
        partialBatchCount: 4,
        scoredCount: 80,
      },
    };

    const res = (await handler(get(), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board).toBe('target-board');
    expect(body.universe).toBe('russell2k');
    expect(body.runs).toHaveLength(1);
    expect(body.latest.runId).toMatch(/^target-board-russell2k-/);
    expect((body.latest.cursor as any).nextTickerIndex).toBe(200);
  });

  it('isolates runs to the requested board+universe prefix', async () => {
    store['scanRuns/target-board-russell2k-20260518-230000'] = {
      status: 'running',
      cursor: { nextTickerIndex: 50, totalTickers: 2037 },
    };
    store['scanRuns/insider-russell2k-20260518-213000'] = {
      status: 'done',
      cursor: null,
    };
    store['scanRuns/target-board-sp500-20260518-230000'] = {
      status: 'running',
      cursor: { nextTickerIndex: 10, totalTickers: 503 },
    };

    const res = (await handler(get({ board: 'insider', universe: 'russell2k' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].runId).toMatch(/^insider-russell2k-/);
  });

  it('derives invocationAgeMs and scanAgeMs when cursor has timestamps', async () => {
    // Stalled chain: last invocation 1h ago.
    const oneHourAgoIso = new Date(Date.now() - 60 * 60_000).toISOString();
    const twoHoursAgoIso = new Date(Date.now() - 120 * 60_000).toISOString();
    store['scanRuns/target-board-russell2k-stalled'] = {
      status: 'running',
      cursor: {
        universe: 'russell2k',
        board: 'target-board',
        status: 'running',
        nextTickerIndex: 500,
        totalTickers: 2037,
        invocationCount: 1,
        startedAt: twoHoursAgoIso,
        lastInvocationStartedAt: oneHourAgoIso,
        partialBatchCount: 10,
        scoredCount: 80,
      },
    };
    const res = (await handler(get(), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.latest.invocationAgeMs).toBeGreaterThan(59 * 60_000);
    expect(body.latest.scanAgeMs).toBeGreaterThan(119 * 60_000);
  });

  it('returns empty runs list when no scans match', async () => {
    const res = (await handler(get(), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.runs).toEqual([]);
    expect(body.latest).toBeNull();
  });

  // Phase 4p W3 — `scan` shorthand param.
  it("honors scan=insider-russell2k and routes to the insider scan (W3)", async () => {
    store['scanRuns/target-board-russell2k-20260518-230000'] = {
      status: 'running',
      cursor: { nextTickerIndex: 50, totalTickers: 2037 },
    };
    store['scanRuns/insider-russell2k-20260518-213000'] = {
      status: 'done',
      cursor: null,
    };

    const res = (await handler(get({ scan: 'insider-russell2k' }), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board).toBe('insider');
    expect(body.universe).toBe('russell2k');
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].runId).toMatch(/^insider-russell2k-/);
  });

  it("honors scan=target-board-sp500 (a multi-hyphen board name) (W3)", async () => {
    store['scanRuns/target-board-sp500-20260518-230000'] = {
      status: 'done',
      cursor: null,
    };
    const res = (await handler(get({ scan: 'target-board-sp500' }), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board).toBe('target-board');
    expect(body.universe).toBe('sp500');
  });

  it('rejects a malformed scan value', async () => {
    const res = (await handler(get({ scan: 'totally-bogus' }), {} as any)) as any;
    expect(res.statusCode).toBe(400);
  });

  it('falls back to board+universe when scan is empty', async () => {
    store['scanRuns/insider-russell2k-20260518-213000'] = {
      status: 'done',
      cursor: null,
    };
    const res = (await handler(get({ scan: '', board: 'insider', universe: 'russell2k' }), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board).toBe('insider');
  });

  it('passes through cursor null (terminal write cleared it)', async () => {
    store['scanRuns/target-board-russell2k-completed'] = {
      status: 'done',
      finishedAt: '2026-05-18T23:30:00.000Z',
      cursor: null,
    };
    const res = (await handler(get(), {} as any)) as any;
    const body = JSON.parse(res.body);
    expect(body.runs[0].cursor).toBeNull();
    expect(body.runs[0].status).toBe('done');
    expect(body.runs[0].invocationAgeMs).toBeUndefined();
  });

  it('excludes other-prefix runs (lower bound) and includes prefix runs (upper sentinel)', async () => {
    // A target-board run and an unrelated insider run coexist in scanRuns.
    store['scanRuns/target-board-russell2k-20260518-230000'] = { status: 'running', cursor: null };
    store['scanRuns/insider-sp500-20260518-230000'] = { status: 'running', cursor: null };
    const res = (await handler(get({ board: 'target-board', universe: 'russell2k' }), {} as any)) as any;
    const body = JSON.parse(res.body);
    // The descending prefix scan must return the target-board run (proving
    // the U+F8FF upper bound includes longer ids) and exclude the insider
    // run (proving the lower bound is applied) — not "everything".
    expect(body.runs.map((r: any) => r.runId)).toEqual(['target-board-russell2k-20260518-230000']);
  });

  it('GUARD: the faithful range fake returns the match only with the U+F8FF sentinel, nothing when degenerate', async () => {
    // Direct proof the test models real Firestore range semantics: with the
    // canonical bounds (startAt prefix+, endAt prefix) the seeded id is
    // returned; with the degenerate bounds (startAt===endAt===prefix, i.e.
    // the dropped-sentinel regression) the same query returns nothing. A mock
    // that pinned behavior would return the match in BOTH cases.
    const { getAdminDb } = await import('../shared/firebase-admin');
    store['scanRuns/insider-russell2k-20260518-230000'] = { status: 'running', cursor: null };
    const db: any = (getAdminDb as any)();
    const prefix = 'insider-russell2k-';
    const SENT = '';
    const withSentinel = await db.collection('scanRuns').orderBy('__name__', 'desc')
      .startAt(prefix + SENT).endAt(prefix).limit(5).get();
    const degenerate = await db.collection('scanRuns').orderBy('__name__', 'desc')
      .startAt(prefix).endAt(prefix).limit(5).get();
    expect(withSentinel.docs.map((d: any) => d.id)).toEqual(['insider-russell2k-20260518-230000']);
    expect(degenerate.docs).toHaveLength(0);
  });
});
