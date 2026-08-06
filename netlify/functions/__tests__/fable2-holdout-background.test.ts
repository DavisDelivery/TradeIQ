// FABLE-2 R3 — the holdout runner's binding guarantees: hardcoded frozen
// window (no config input accepted), and the single-use guard (a
// completed measurement is FINAL).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();
// Prior completed runs the guard sees: [{id, completedAt}]. AUDIT-1 split the
// guard on completedAt vs the membership-fix deploy time, so the mock carries
// data() now, and `.where().get()` (no limit) is the shape the guard uses.
let completedRuns: Array<{ id: string; completedAt: string }> = [];
vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (_c: string) => ({
      where: () => {
        const result = async () => ({
          empty: completedRuns.length === 0,
          docs: completedRuns.map((r) => ({ id: r.id, data: () => ({ completedAt: r.completedAt }) })),
        });
        return { get: result, limit: () => ({ get: result }) };
      },
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
      stats: { universeSize: 0, tickersWithBars: 0, barFetchFailures: 0, insiderFetches: 0, insiderFailures: 0, checkpoints: 0, membershipSource: 'pit-history' },
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
  completedRuns = [];
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

  it('single-use guard: refuses (409) once a POST-FIX complete measurement exists', async () => {
    completedRuns = [{ id: 'fbl2h_prior', completedAt: '2026-08-07T01:00:00.000Z' }];
    const res = await invoke({ runId: 'fbl2h_second_try' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/single-use|FINAL/);
    expect(loadCalls).toHaveLength(0); // no work performed
    expect(docs.has('fbl2h_second_try')).toBe(false);
  });

  // AUDIT-1: "final" binds the measurement, not a defective instrument. The
  // pre-fix run measured the survivorship bug (candidates = today's roster),
  // so it is superseded — one corrected run is permitted, config unchanged.
  it('permits exactly one supersession of a PRE-FIX completion', async () => {
    completedRuns = [{ id: 'fbl2h_confirmatory', completedAt: '2026-07-14T02:11:00.000Z' }];
    const res = await invoke({ runId: 'fbl2h_pit_rerun' });
    expect(res.statusCode).toBe(200);
    expect(loadCalls).toHaveLength(1);
    // the frozen window still binds — supersession is not a re-roll
    expect(loadCalls[0].config.startDate).toBe('2024-01-01');
    expect(loadCalls[0].config.endDate).toBe('2026-06-30');
  });

  it('a post-fix completion blocks even when pre-fix runs also exist', async () => {
    completedRuns = [
      { id: 'fbl2h_confirmatory', completedAt: '2026-07-14T02:11:00.000Z' },
      { id: 'fbl2h_pit_rerun', completedAt: '2026-08-07T04:00:00.000Z' },
    ];
    const res = await invoke({ runId: 'fbl2h_third_try' });
    expect(res.statusCode).toBe(409);
  });

  it('rejects malformed runId', async () => {
    const res = await invoke({ runId: 'not_the_prefix' });
    expect(res.statusCode).toBe(400);
  });
});
