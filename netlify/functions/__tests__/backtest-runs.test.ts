import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock firebase-admin getAdminDb with a tiny in-memory store keyed by runId.
// We also wrap withSentry so it acts as a passthrough — Sentry initSentry
// is no-op when SENTRY_DSN is unset, but the wrapper still expects the
// handler signature to match, so we keep withSentry's identity-like behavior.

type FakeRun = {
  runId: string;
  data: any;
  dailyEquity: any[];
  trades: any[];
  attribution: any[];
  mlTrainingRows: any[];
};
const fakeRuns = new Map<string, FakeRun>();

function makeQuery(items: FakeRun[]) {
  let orderField: string | null = null;
  let orderDir: 'asc' | 'desc' = 'asc';
  let limitN: number | null = null;
  const api: any = {
    orderBy: (f: string, dir: 'asc' | 'desc' = 'asc') => {
      orderField = f;
      orderDir = dir;
      return api;
    },
    limit: (n: number) => {
      limitN = n;
      return api;
    },
    get: async () => {
      let out = [...items];
      if (orderField) {
        out.sort((a, b) => {
          const av = a.data[orderField!] ?? '';
          const bv = b.data[orderField!] ?? '';
          return orderDir === 'asc'
            ? String(av).localeCompare(String(bv))
            : String(bv).localeCompare(String(av));
        });
      }
      if (limitN !== null) out = out.slice(0, limitN);
      return {
        size: out.length,
        docs: out.map((r) => ({ id: r.runId, data: () => r.data })),
      };
    },
    count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
  };
  return api;
}

function makeRunRef(runId: string) {
  return {
    get: async () => {
      const run = fakeRuns.get(runId);
      return run
        ? { exists: true, id: runId, data: () => run.data }
        : { exists: false };
    },
    collection: (subColl: string) => {
      const run = fakeRuns.get(runId);
      const items =
        subColl === 'dailyEquity' ? (run?.dailyEquity ?? []).map((d) => ({ data: () => d })) :
        subColl === 'trades' ? (run?.trades ?? []).map((d) => ({ data: () => d })) :
        subColl === 'attribution' ? (run?.attribution ?? []).map((d) => ({ data: () => d })) :
        subColl === 'mlTraining' ? (run?.mlTrainingRows ?? []).map((d) => ({ data: () => d })) :
        [];
      return {
        orderBy: () => ({
          get: async () => ({ size: items.length, docs: items }),
          limit: (_n: number) => ({
            get: async () => ({ size: items.length, docs: items.slice(0, _n) }),
          }),
        }),
        limit: (_n: number) => ({
          get: async () => ({ size: items.length, docs: items.slice(0, _n) }),
        }),
        get: async () => ({ size: items.length, docs: items }),
        count: () => ({
          get: async () => ({ data: () => ({ count: items.length }) }),
        }),
      };
    },
  };
}

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name !== 'backtestRuns') throw new Error('unexpected collection: ' + name);
      const all = [...fakeRuns.values()];
      const q = makeQuery(all);
      // Augment with .doc() for the detail endpoint
      (q as any).doc = (runId: string) => makeRunRef(runId);
      return q;
    },
  }),
}));

// Sentry passthrough — tests don't need DSN
vi.mock('../shared/sentry', () => ({
  withSentry: (h: any) => h,
  initSentry: () => {},
  captureException: () => {},
}));

import { handler as listHandler } from '../backtest-runs-list';
import { handler as getHandler } from '../backtest-runs-get';

beforeEach(() => {
  fakeRuns.clear();
});

function seedRun(runId: string, completedAt: string, overrides: any = {}) {
  fakeRuns.set(runId, {
    runId,
    data: {
      runId,
      completedAt,
      config: { universe: 'dow', cadence: 'monthly' },
      metrics: {
        totalReturn: 0.073,
        cagr: 0.0103,
        sharpe: 0.224,
        maxDrawdown: -0.0924,
        winRate: 0.568,
        trades: 350,
      },
      universeSurvivorshipCorrected: { universe: 'dow', corrected: true },
      status: 'complete',
      warnings: [],
      ...overrides,
    },
    dailyEquity: [{ date: '2018-01-01', value: 100000 }],
    trades: [{ ticker: 'AAPL', entryDate: '2018-01-15', pnlPct: 0.12 }],
    attribution: [{ ticker: 'AAPL', layers: { fundamental: 0.6 }, pnl: 1200 }],
    mlTrainingRows: [],
  });
}

describe('backtest-runs-list endpoint', () => {
  it('returns runs sorted by completedAt desc', async () => {
    seedRun('bt_a', '2026-05-01T00:00:00Z');
    seedRun('bt_b', '2026-05-11T00:00:00Z');
    seedRun('bt_c', '2026-05-05T00:00:00Z');

    const res: any = await listHandler({ queryStringParameters: {} } as any, {} as any, () => {});
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.runs).toHaveLength(3);
    expect(body.runs[0].runId).toBe('bt_b'); // newest first
    expect(body.runs[2].runId).toBe('bt_a'); // oldest last
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      seedRun(`bt_${i}`, `2026-05-${10 + i}T00:00:00Z`);
    }
    const res: any = await listHandler(
      { queryStringParameters: { limit: '2' } } as any,
      {} as any,
      () => {},
    );
    const body = JSON.parse(res.body);
    expect(body.runs).toHaveLength(2);
  });

  it('returns top-level metrics only (no subcollection bloat)', async () => {
    seedRun('bt_a', '2026-05-11T00:00:00Z');
    const res: any = await listHandler({ queryStringParameters: {} } as any, {} as any, () => {});
    const body = JSON.parse(res.body);
    expect(body.runs[0].metrics.sharpe).toBe(0.224);
    expect((body.runs[0] as any).dailyEquity).toBeUndefined();
    expect((body.runs[0] as any).trades).toBeUndefined();
  });
});

describe('backtest-runs-get endpoint', () => {
  it('returns the run + subcollections when found', async () => {
    seedRun('bt_a', '2026-05-11T00:00:00Z');
    const res: any = await getHandler({ path: '/api/backtest-runs/bt_a' } as any, {} as any, () => {});
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.run.runId).toBe('bt_a');
    expect(body.dailyEquity).toHaveLength(1);
    expect(body.trades).toHaveLength(1);
    expect(body.attribution).toHaveLength(1);
    expect(body.mlTrainingCount).toBe(0);
  });

  it('returns 404 when run does not exist', async () => {
    const res: any = await getHandler(
      { path: '/api/backtest-runs/nonexistent' } as any,
      {} as any,
      () => {},
    );
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('not found');
  });

  it('returns 400 for invalid runId (special chars)', async () => {
    const res: any = await getHandler(
      { path: '/api/backtest-runs/bad$runId!' } as any,
      {} as any,
      () => {},
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('invalid');
  });

  it('returns 400 when runId is missing entirely', async () => {
    const res: any = await getHandler(
      { path: '/.netlify/functions/backtest-runs-get', queryStringParameters: {} } as any,
      {} as any,
      () => {},
    );
    expect(res.statusCode).toBe(400);
  });
});
