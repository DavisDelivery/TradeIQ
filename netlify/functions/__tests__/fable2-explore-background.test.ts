// FABLE-2 R1 — the exploration runner's TRAIN CLAMP is a binding
// pre-registration rule (protocol.md §3): exploration can NEVER touch
// the holdout (2024-01-01 →). These tests pin the clamp, the audit doc
// writes (no silent discards), and the failure path.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();
vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (_c: string) => ({
      doc: (id: string) => ({
        set: async (payload: Record<string, unknown>, opts?: { merge?: boolean }) => {
          docs.set(id, opts?.merge ? { ...(docs.get(id) ?? {}), ...payload } : { ...payload });
        },
        get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }),
      }),
    }),
  }),
}));

const loadCalls: any[] = [];
let loadShouldThrow = false;
vi.mock('../shared/backtest/policy-data', () => ({
  loadPolicyInputs: vi.fn(async (opts: any) => {
    loadCalls.push(opts);
    if (loadShouldThrow) throw new Error('boom: provider down');
    return {
      inputs: { tickers: [], spyBars: [], checkpoints: [], config: opts.config },
      stats: { universeSize: 0, tickersWithBars: 0, barFetchFailures: 0, insiderFetches: 0, insiderFailures: 0, checkpoints: 0 },
    };
  }),
}));

vi.mock('../shared/backtest/policy-engine', async () => {
  const actual = await vi.importActual<typeof import('../shared/backtest/policy-engine')>(
    '../shared/backtest/policy-engine',
  );
  return {
    ...actual,
    runPolicyBacktest: vi.fn(() => ({
      equity: [{ date: '2018-01-31', value: 100000, spy: 280 }],
      trades: [],
      metrics: { totalReturnPct: 1, excessVsSpyPp: 0, rankIc63: null, tradeCount: 0 },
      warnings: [],
    })),
  };
});

import { handler } from '../fable2-explore-background';

const invoke = (body: unknown) =>
  handler(
    { httpMethod: 'POST', body: JSON.stringify(body), headers: {}, queryStringParameters: null } as any,
    {} as any,
  ) as Promise<{ statusCode: number; body: string }>;

beforeEach(() => {
  docs.clear();
  loadCalls.length = 0;
  loadShouldThrow = false;
});

describe('fable2-explore-background — binding train clamp', () => {
  it('clamps endDate into TRAIN (holdout untouchable) and records clampApplied', async () => {
    const res = await invoke({
      runId: 'fbl2_clamp_test',
      config: { startDate: '2018-01-01', endDate: '2026-06-30' },
    });
    expect(res.statusCode).toBe(200);
    const doc = docs.get('fbl2_clamp_test')!;
    expect((doc.config as any).endDate).toBe('2023-12-31');
    expect(doc.clampApplied).toBe(true);
    // and the data layer only ever saw the clamped window
    expect(loadCalls[0].config.endDate).toBe('2023-12-31');
  });

  it('clamps startDate up to 2018-01-01', async () => {
    await invoke({ runId: 'fbl2_start_clamp', config: { startDate: '2015-01-01', endDate: '2023-06-30' } });
    expect((docs.get('fbl2_start_clamp')!.config as any).startDate).toBe('2018-01-01');
  });

  it('in-train windows pass through unclamped', async () => {
    await invoke({ runId: 'fbl2_in_train', config: { startDate: '2019-01-01', endDate: '2022-12-30' } });
    const doc = docs.get('fbl2_in_train')!;
    expect((doc.config as any).endDate).toBe('2022-12-30');
    expect(doc.clampApplied).toBe(false);
    expect(doc.status).toBe('complete');
  });

  it('rejects missing/malformed runId', async () => {
    const res = await invoke({ config: {} });
    expect(res.statusCode).toBe(400);
    const res2 = await invoke({ runId: 'not-valid-prefix' });
    expect(res2.statusCode).toBe(400);
  });

  it('failure path writes status=failed with the error (no silent discards)', async () => {
    loadShouldThrow = true;
    const res = await invoke({ runId: 'fbl2_fail_case', config: {} });
    expect(res.statusCode).toBe(500);
    const doc = docs.get('fbl2_fail_case')!;
    expect(doc.status).toBe('failed');
    expect(String(doc.error)).toMatch(/boom/);
  });
});
