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
  // and db().collection('backtestRuns')[.where(...)].orderBy(field, dir).limit(...).get().
  const runsCol: any = {
    _ordered: false,
    _orderField: 'completedAt',
    _whereField: null as string | null,
    _whereValue: null as unknown,
    _limit: Infinity,
    where(field: string, _op: string, value: unknown) {
      const clone = { ...this };
      clone._whereField = field;
      clone._whereValue = value;
      return clone;
    },
    orderBy(field: string) {
      const clone = { ...this };
      clone._ordered = true;
      clone._orderField = field;
      return clone;
    },
    limit(n: number) {
      const clone = { ...this };
      clone._limit = n;
      return clone;
    },
    async get() {
      // Sort by the queried field (defaults to completedAt).
      const all = Array.from(fakeDocs.runs.entries())
        .map(([id, data]) => ({ id, data }))
        .filter((e) => {
          if (!this._whereField) return true;
          return e.data[this._whereField] === this._whereValue;
        });
      const field = this._orderField;
      all.sort((a, b) => String(b.data[field] ?? '').localeCompare(String(a.data[field] ?? '')));
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

    // Phase 4u W2 — failed-run visibility.
    it('excludes failed runs from the default list (back-compat)', async () => {
      fakeDocs.runs.set('ok', sampleRun({
        runId: 'ok', status: 'complete', completedAt: '2026-05-10T10:00:00.000Z',
        startedAt: '2026-05-10T09:00:00.000Z',
      }));
      fakeDocs.runs.set('boom', sampleRun({
        runId: 'boom', status: 'failed', completedAt: null, failedAt: '2026-05-11T11:00:00.000Z',
        startedAt: '2026-05-11T10:00:00.000Z', error: 'cursor doc too big',
      }));
      const res = await invoke(listHandler, makeEvent());
      const body = JSON.parse(res.body);
      expect(body.runs.map((r: any) => r.runId)).toEqual(['ok']);
    });

    it('includeIncomplete=1 returns failed/pending/running runs ordered by startedAt', async () => {
      fakeDocs.runs.set('ok', sampleRun({
        runId: 'ok', status: 'complete', completedAt: '2026-05-10T10:00:00.000Z',
        startedAt: '2026-05-10T09:00:00.000Z',
      }));
      fakeDocs.runs.set('boom', sampleRun({
        runId: 'boom', status: 'failed', completedAt: null, failedAt: '2026-05-11T11:00:00.000Z',
        startedAt: '2026-05-11T10:00:00.000Z', error: 'cursor doc too big',
      }));
      fakeDocs.runs.set('go', sampleRun({
        runId: 'go', status: 'running', completedAt: null,
        startedAt: '2026-05-12T10:00:00.000Z',
      }));
      const res = await invoke(listHandler, makeEvent({ qs: { includeIncomplete: '1' } }));
      const body = JSON.parse(res.body);
      // Sorted by startedAt desc → go (12th), boom (11th), ok (10th).
      expect(body.runs.map((r: any) => r.runId)).toEqual(['go', 'boom', 'ok']);
      // The error field is surfaced for the failed run, null for the others.
      expect(body.runs.find((r: any) => r.runId === 'boom').error).toBe('cursor doc too big');
      expect(body.runs.find((r: any) => r.runId === 'ok').error).toBeNull();
    });

    it('status=failed filters to failed runs and surfaces the error', async () => {
      fakeDocs.runs.set('ok', sampleRun({
        runId: 'ok', status: 'complete', completedAt: '2026-05-10T10:00:00.000Z',
        startedAt: '2026-05-10T09:00:00.000Z',
      }));
      fakeDocs.runs.set('boom1', sampleRun({
        runId: 'boom1', status: 'failed', completedAt: null,
        startedAt: '2026-05-11T10:00:00.000Z',
        failedAt: '2026-05-11T11:00:00.000Z',
        error: 'Document exceeds 1 MiB',
      }));
      fakeDocs.runs.set('boom2', sampleRun({
        runId: 'boom2', status: 'failed', completedAt: null,
        startedAt: '2026-05-12T10:00:00.000Z',
        failedAt: '2026-05-12T11:00:00.000Z',
        error: 'synthetic engine failure',
      }));
      const res = await invoke(listHandler, makeEvent({ qs: { status: 'failed' } }));
      const body = JSON.parse(res.body);
      expect(body.runs.map((r: any) => r.runId)).toEqual(['boom2', 'boom1']);
      expect(body.runs.every((r: any) => r.status === 'failed')).toBe(true);
      expect(body.runs[0].error).toBe('synthetic engine failure');
      expect(body.runs[1].error).toBe('Document exceeds 1 MiB');
    });

    it('exposes startedAt + failedAt fields on every row', async () => {
      fakeDocs.runs.set('boom', sampleRun({
        runId: 'boom', status: 'failed', completedAt: null,
        startedAt: '2026-05-19T01:44:34.890Z',
        failedAt: '2026-05-19T02:28:44.931Z',
        error: 'cursor over 1 MiB',
      }));
      const res = await invoke(listHandler, makeEvent({ qs: { status: 'failed' } }));
      const body = JSON.parse(res.body);
      expect(body.runs[0].startedAt).toBe('2026-05-19T01:44:34.890Z');
      expect(body.runs[0].failedAt).toBe('2026-05-19T02:28:44.931Z');
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
