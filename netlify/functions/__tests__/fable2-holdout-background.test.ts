// FABLE-2 R3 — the holdout runner's binding guarantees: hardcoded frozen
// window (no config input accepted), and the single-use guard (a
// completed measurement is FINAL).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();
let completedExists = false;
vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (_c: string) => ({
      where: () => ({
        limit: () => ({
          get: async () => ({
            empty: !completedExists,
            docs: completedExists ? [{ id: 'fbl2h_prior' }] : [],
          }),
        }),
      }),
      doc: (id: string) => ({
        set: async (payload: Record<string, unknown>, opts?: { merge?: boolean }) => {
          docs.set(id, opts?.merge ? { ...(docs.get(id) ?? {}), ...payload } : { ...payload });
        },
      }),
    }),
  }),
}));

const loadCalls: any[] = [];
vi.mock('../shared/backtest/policy-data', () => ({
  loadPolicyInputs: vi.fn(async (opts: any) => {
    loadCalls.push(opts);
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
      equity: [{ date: '2024-01-31', value: 100000, spy: 480 }],
      trades: [],
      metrics: { totalReturnPct: 0, excessVsSpyPp: 0, rankIc63: null },
      warnings: [],
    })),
  };
});

import { handler } from '../fable2-holdout-background';

const invoke = (body: unknown) =>
  handler(
    { httpMethod: 'POST', body: JSON.stringify(body), headers: {}, queryStringParameters: null } as any,
    {} as any,
  ) as Promise<{ statusCode: number; body: string }>;

beforeEach(() => {
  docs.clear();
  loadCalls.length = 0;
  completedExists = false;
});

describe('fable2-holdout-background — one shot, frozen window', () => {
  it('runs with the FROZEN config only — no config input accepted, window pinned', async () => {
    const res = await invoke({ runId: 'fbl2h_confirmatory', config: { endDate: '2030-01-01', stopPct: 0.5 } });
    expect(res.statusCode).toBe(200);
    // whatever the caller sent is ignored — the loader saw the frozen window
    expect(loadCalls[0].config.startDate).toBe('2024-01-01');
    expect(loadCalls[0].config.endDate).toBe('2026-06-30');
    expect(loadCalls[0].config.stopPct).toBe(0.12);
    expect(loadCalls[0].config.maxPositions).toBe(15);
    expect(loadCalls[0].insiderMode).toBe('live');
    expect((docs.get('fbl2h_confirmatory') as any).frozenPer).toMatch(/APPENDIX A/);
  });

  it('single-use guard: refuses (409) once any complete measurement exists', async () => {
    completedExists = true;
    const res = await invoke({ runId: 'fbl2h_second_try' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/single-use|FINAL/);
    expect(loadCalls).toHaveLength(0); // no work performed
    expect(docs.has('fbl2h_second_try')).toBe(false);
  });

  it('rejects malformed runId', async () => {
    const res = await invoke({ runId: 'not_the_prefix' });
    expect(res.statusCode).toBe(400);
  });
});
