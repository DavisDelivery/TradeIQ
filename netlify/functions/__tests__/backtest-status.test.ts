// Phase 4r W1 — /api/backtest-status diagnostic endpoint test.
//
// Verifies: per-window dedupe, version-aware done counting, rolling
// missing-list, stale-pending/stale-running inventory. No live Firestore.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeDoc {
  id: string;
  data: () => Record<string, unknown>;
}

let docsForReturn: FakeDoc[] = [];

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: (cn: string) => ({
      orderBy: (_field: string, _dir?: string) => ({
        limit: (_n: number) => ({
          get: async () => {
            if (cn !== 'portfolioBacktests') return { docs: [] };
            return { docs: docsForReturn };
          },
        }),
      }),
    }),
  })),
}));

vi.mock('../shared/logger', () => ({
  logger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

import { handler } from '../backtest-status';

function doc(
  runId: string,
  window: string,
  status: string,
  version: string | null,
  startedAt: string,
  extras: Record<string, unknown> = {},
): FakeDoc {
  const data: Record<string, unknown> = { window, status, startedAt, ...extras };
  if (version !== null) data.version = version;
  return { id: runId, data: () => data };
}

function get(qs: Record<string, string> = {}): Parameters<typeof handler>[0] {
  return { httpMethod: 'GET', queryStringParameters: qs } as unknown as Parameters<typeof handler>[0];
}

beforeEach(() => {
  docsForReturn = [];
});

describe('/api/backtest-status', () => {
  it('reports 0/8 rolling-done and lists every rolling window as missing on an empty collection', async () => {
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rolling.done).toBe(0);
    expect(body.rolling.total).toBe(8);
    expect(body.rolling.missing).toHaveLength(8);
    expect(body.full.present).toBe(false);
  });

  it('counts a done v2 doc toward rolling.done but NOT a done v1 doc', async () => {
    docsForReturn = [
      doc('pb-rolling-2018-x', 'rolling-2018', 'done', 'v2', '2026-05-10T22:00:00Z'),
      doc('pb-rolling-2021-y', 'rolling-2021', 'done', 'v1', '2026-05-15T22:06:00Z'),
    ];
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.rolling.done).toBe(1);
    expect(body.rolling.missing).toContain('rolling-2021');
    expect(body.rolling.missing).not.toContain('rolling-2018');
  });

  it('treats a missing version field as needing a re-run (pre-Phase-4i docs are not active)', async () => {
    docsForReturn = [
      doc('pb-rolling-2018-x', 'rolling-2018', 'done', null, '2026-05-10T22:00:00Z'),
    ];
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.rolling.done).toBe(0);
    expect(body.rolling.missing).toContain('rolling-2018');
  });

  it('honors version=<v> query param', async () => {
    docsForReturn = [
      doc('pb-rolling-2018-x', 'rolling-2018', 'done', 'v1', '2026-05-10T22:00:00Z'),
    ];
    const res = (await handler(get({ version: 'v1' }), {} as never)) as {
      statusCode: number;
      body: string;
    };
    const body = JSON.parse(res.body);
    expect(body.activeVersion).toBe('v1');
    expect(body.rolling.done).toBe(1);
  });

  it('reports stale-pending docs older than the configured threshold', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    docsForReturn = [
      doc('pb-rolling-2022-x', 'rolling-2022', 'pending', null, twoHoursAgo),
      doc('pb-rolling-2023-x', 'rolling-2023', 'pending', null, fiveMinAgo),
    ];
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.stale.pending.length).toBe(1);
    expect(body.stale.pending[0].runId).toBe('pb-rolling-2022-x');
  });

  it('reports stale-running docs with invocation age beyond the threshold', async () => {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    docsForReturn = [
      doc(
        'pb-full-stuck',
        'full',
        'running',
        null,
        fourHoursAgo,
        {
          cursor: { lastInvocationStartedAt: fourHoursAgo },
        },
      ),
    ];
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.stale.running.length).toBe(1);
    expect(body.stale.running[0].runId).toBe('pb-full-stuck');
  });

  it('dedupes per window — most recent doc wins as `latest`', async () => {
    docsForReturn = [
      doc('pb-rolling-2018-newer', 'rolling-2018', 'done', 'v2', '2026-05-15T22:00:00Z'),
      doc('pb-rolling-2018-older', 'rolling-2018', 'pending', null, '2026-04-01T22:00:00Z'),
    ];
    const res = (await handler(get(), {} as never)) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    const w = body.windows.find((x: { window: string }) => x.window === 'rolling-2018');
    expect(w.latest.runId).toBe('pb-rolling-2018-newer');
    expect(w.doneForActiveVersion).toBe(true);
  });

  it('filters to a single window when ?window= is supplied', async () => {
    docsForReturn = [
      doc('pb-rolling-2018-x', 'rolling-2018', 'done', 'v2', '2026-05-10T22:00:00Z'),
      doc('pb-rolling-2022-y', 'rolling-2022', 'done', 'v2', '2026-05-11T22:00:00Z'),
    ];
    const res = (await handler(get({ window: 'rolling-2018' }), {} as never)) as {
      statusCode: number;
      body: string;
    };
    const body = JSON.parse(res.body);
    expect(body.windows).toHaveLength(1);
    expect(body.windows[0].window).toBe('rolling-2018');
  });

  // Phase 4r-W1b — surfaces the new reinvoke diagnostics on the
  // RunSummary so operators can see throttling / recovery without
  // reading raw Firestore.
  it('surfaces reinvokeAttempts / lastReinvokeStatus / recoveryAttempts from the cursor', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    docsForReturn = [
      doc(
        'pb-rolling-2020-diag',
        'rolling-2020',
        'running',
        'v2',
        recent,
        {
          cursor: {
            lastInvocationStartedAt: recent,
            reinvokeAttempts: 4,
            lastReinvokeStatus: 429,
            lastReinvokeError: 'HTTP 429',
            recoveryAttempts: 1,
          },
        },
      ),
    ];
    const res = (await handler(get({ window: 'rolling-2020' }), {} as never)) as {
      statusCode: number;
      body: string;
    };
    const body = JSON.parse(res.body);
    const latest = body.windows[0].latest;
    expect(latest.reinvokeAttempts).toBe(4);
    expect(latest.lastReinvokeStatus).toBe(429);
    expect(latest.lastReinvokeError).toBe('HTTP 429');
    expect(latest.recoveryAttempts).toBe(1);
  });

  it('reports the new diagnostic fields as null when the cursor lacks them (back-compat)', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    docsForReturn = [
      doc(
        'pb-rolling-2020-old',
        'rolling-2020',
        'running',
        'v2',
        recent,
        { cursor: { lastInvocationStartedAt: recent } },
      ),
    ];
    const res = (await handler(get({ window: 'rolling-2020' }), {} as never)) as {
      statusCode: number;
      body: string;
    };
    const body = JSON.parse(res.body);
    const latest = body.windows[0].latest;
    expect(latest.reinvokeAttempts).toBeNull();
    expect(latest.lastReinvokeStatus).toBeNull();
    expect(latest.lastReinvokeError).toBeNull();
    expect(latest.recoveryAttempts).toBeNull();
  });
});
