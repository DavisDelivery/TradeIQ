import { describe, it, expect, beforeEach, vi } from 'vitest';

// We mock the firebase-admin module so the handlers can be exercised
// without a real Firestore connection. The mock exposes a programmable
// fake db where collection/.doc/.get return canned snapshots.

const fakeDocs = {
  // Top-level run docs by runId, keyed for the list endpoint.
  runs: new Map<string, any>(),
  // Subcollection data keyed as `${runId}/${name}` → array of docs.
  subcols: new Map<string, any[]>(),
};

function makeSnap(items: { id: string; data: any }[]) {
  return {
    size: items.length,
    docs: items.map((it) => ({
      id: it.id,
      data: () => it.data,
      exists: true,
    })),
  };
}

function makeDocSnap(id: string, data: any) {
  return { id, data: () => data, exists: data !== null };
}

function buildFakeDb() {
  // The handlers chain: db().collection('backtestRuns').doc(id).{get|collection(...)...}
  // and db().collection('backtestRuns').orderBy(...).limit(...).get().
  const runsCol: any = {
    _ordered: false,
    _limit: Infinity,
    orderBy() {
      this._ordered = true;
      return this;
    },
    limit(n: number) {
      this._limit = n;
      return this;
    },
    async get() {
      // Sort by completedAt desc for the list.
      const all = Array.from(fakeDocs.runs.entries()).map(([id, data]) => ({ id, data }));
      all.sort((a, b) => String(b.data.completedAt ?? '').localeCompare(String(a.data.completedAt ?? '')));
      return makeSnap(all.slice(0, this._limit));
    },
    doc(id: string) {
      return {
        async get() {
          const data = fakeDocs.runs.get(id) ?? null;
          return makeDocSnap(id, data);
        },
        collection(name: string) {
          const key = `${id}/${name}`;
          const items = fakeDocs.subcols.get(key) ?? [];
          const built: any = {
            _limit: Infinity,
            _ordered: false,
            orderBy() {
              this._ordered = true;
              return this;
            },
            limit(n: number) {
              this._limit = n;
              return this;
            },
            async get() {
              return makeSnap(items.slice(0, this._limit).map((d, i) => ({ id: String(i), data: d })));
            },
            count() {
              return {
                async get() {
                  return { data: () => ({ count: items.length }) };
                },
              };
            },
          };
          return built;
        },
      };
    },
  };
  return {
    collection(name: string) {
      if (name !== 'backtestRuns') throw new Error('unexpected collection ' + name);
      return runsCol;
    },
  };
}

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => buildFakeDb(),
}));

// Import handlers AFTER the mock is registered.
import { handler as listHandler } from '../backtest-runs-list';
import { handler as getHandler } from '../backtest-runs-get';

function makeEvent(opts: { qs?: Record<string, string>; path?: string } = {}): any {
  return {
    queryStringParameters: opts.qs ?? null,
    path: opts.path ?? '/.netlify/functions/backtest-runs-get',
    httpMethod: 'GET',
    headers: {},
    body: null,
    isBase64Encoded: false,
    rawUrl: '',
    rawQuery: '',
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
  };
}

// Helper to invoke a Netlify handler that may return void via callback.
async function invoke(h: any, event: any): Promise<{ statusCode: number; headers?: any; body: string }> {
  const res = await h(event, {} as any, () => {});
  return res as any;
}

const sampleRun = (overrides: Partial<any> = {}) => ({
  runId: 'bt_test_001',
  config: { universe: 'dow', board: 'prophet', startDate: '2020-01-01', endDate: '2024-01-01', rebalanceFrequency: 'monthly' },
  status: 'complete',
  completedAt: '2026-05-11T16:00:00.000Z',
  metrics: {
    totalReturnPct: 7.3,
    cagrPct: 1.03,
    sharpe: 0.224,
    sortino: 0.31,
    maxDrawdownPct: -9.2,
    winRatePct: 56.8,
    informationCoefficient: -0.095,
    informationRatio: 0.05,
    tradeCount: 350,
    rebalanceCount: 84,
    perRegime: {},
  },
  universeSurvivorshipCorrected: { universe: 'dow', corrected: true, coverageThrough: '2018-01-31' },
  warnings: [],
  benchmark: { ticker: 'SPY', totalReturnPct: 12.4 },
  ...overrides,
});

describe('backtest-runs endpoints', () => {
  beforeEach(() => {
    fakeDocs.runs.clear();
    fakeDocs.subcols.clear();
  });

  describe('list', () => {
    it('returns empty array when no runs exist', async () => {
      const res = await invoke(listHandler, makeEvent());
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.runs).toEqual([]);
    });

    it('returns runs sorted by completedAt descending', async () => {
      fakeDocs.runs.set('older', sampleRun({ runId: 'older', completedAt: '2026-05-10T10:00:00.000Z' }));
      fakeDocs.runs.set('newer', sampleRun({ runId: 'newer', completedAt: '2026-05-11T10:00:00.000Z' }));
      fakeDocs.runs.set('oldest', sampleRun({ runId: 'oldest', completedAt: '2026-05-09T10:00:00.000Z' }));

      const res = await invoke(listHandler, makeEvent());
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.runs.map((r: any) => r.runId)).toEqual(['newer', 'older', 'oldest']);
    });

    it('respects the limit query parameter', async () => {
      for (let i = 0; i < 5; i++) {
        const id = `run_${i}`;
        fakeDocs.runs.set(id, sampleRun({ runId: id, completedAt: `2026-05-1${i}T10:00:00.000Z` }));
      }
      const res = await invoke(listHandler, makeEvent({ qs: { limit: '2' } }));
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.runs.length).toBe(2);
    });

    it('returns truncated metrics (no per-regime, no equity)', async () => {
      fakeDocs.runs.set('r1', sampleRun({ runId: 'r1' }));
      const res = await invoke(listHandler, makeEvent());
      const body = JSON.parse(res.body);
      const m = body.runs[0].metrics;
      expect(m).toHaveProperty('totalReturnPct', 7.3);
      expect(m).toHaveProperty('sharpe', 0.224);
      expect(m).toHaveProperty('tradeCount', 350);
      // Per-regime breakdown stays on the detail endpoint, not the list.
      expect(m).not.toHaveProperty('perRegime');
    });

    it('preserves the survivorship stamp on every row', async () => {
      fakeDocs.runs.set('uncorrected', sampleRun({
        runId: 'uncorrected',
        universeSurvivorshipCorrected: { universe: 'sp500', corrected: false, coverageThrough: null },
      }));
      const res = await invoke(listHandler, makeEvent());
      const body = JSON.parse(res.body);
      expect(body.runs[0].universeSurvivorshipCorrected.corrected).toBe(false);
      expect(body.runs[0].universeSurvivorshipCorrected.universe).toBe('sp500');
    });

    it('clamps limit > 50 to 50 (zod max validation rejects)', async () => {
      // zod schema fails the request rather than silently clamping, which
      // keeps the contract explicit. A bad caller gets a 500 with the
      // zod error message.
      const res = await invoke(listHandler, makeEvent({ qs: { limit: '100' } }));
      expect(res.statusCode).toBe(500);
    });
  });

  describe('get', () => {
    beforeEach(() => {
      fakeDocs.runs.set('bt_xyz', sampleRun({ runId: 'bt_xyz' }));
      fakeDocs.subcols.set('bt_xyz/dailyEquity', [
        { date: '2020-01-01', value: 100000 },
        { date: '2020-01-02', value: 100500 },
      ]);
      fakeDocs.subcols.set('bt_xyz/trades', [
        { rebalanceDate: '2020-01-01', ticker: 'AAPL', side: 'buy', notional: 5000 },
      ]);
      fakeDocs.subcols.set('bt_xyz/attribution', [
        {
          rebalanceDate: '2020-01-01',
          ticker: 'AAPL',
          weight: 0.05,
          segmentReturn: 0.02,
          contribution: 0.001,
          layers: { momentum: 70, fundamental: 60 },
          composite: 65,
          regime: 'risk_on',
        },
      ]);
      fakeDocs.subcols.set('bt_xyz/mlTraining', [{}, {}, {}]);
    });

    it('returns full run + subcollection data on match (path-segment form)', async () => {
      const res = await invoke(
        getHandler,
        makeEvent({ path: '/.netlify/functions/backtest-runs-get/bt_xyz' }),
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.run.runId).toBe('bt_xyz');
      expect(body.dailyEquity).toHaveLength(2);
      expect(body.trades).toHaveLength(1);
      expect(body.attribution).toHaveLength(1);
      expect(body.mlTrainingCount).toBe(3);
    });

    it('returns full run + subcollection data on match (query-param form, Netlify redirect)', async () => {
      const res = await invoke(
        getHandler,
        makeEvent({ qs: { runId: 'bt_xyz' }, path: '/api/backtest-runs/bt_xyz' }),
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.run.runId).toBe('bt_xyz');
    });

    it('returns 404 when run does not exist', async () => {
      const res = await invoke(
        getHandler,
        makeEvent({ path: '/.netlify/functions/backtest-runs-get/missing' }),
      );
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/not found/i);
    });

    it('returns 400 when runId is missing', async () => {
      const res = await invoke(
        getHandler,
        makeEvent({ path: '/.netlify/functions/backtest-runs-get' }),
      );
      expect(res.statusCode).toBe(400);
    });
  });
});
