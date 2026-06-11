import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Phase 4b-2 — trigger endpoint tests.
//
// Mock surfaces:
//   - getAdminDb (single-flight Firestore read)
//   - persistRunPending (pending row write)
//   - generateRunId (so we can assert the dispatched runId is the
//     same one the trigger returns)
//   - global fetch (so we can assert the fire-and-forget background
//     invocation happened with { runId, config })
//
// We deliberately DO NOT mock validateConfig — the trigger reuses the
// engine's real validator, so the tests verify the actual integration
// (400 on bad startDate, etc.).

const mockPending = vi.fn();
const mockGenerateRunId = vi.fn();
const mockRecoverStuckBacktestRuns = vi.fn<(...args: any[]) => Promise<any>>(
  async () => ({
    inspected: 0,
    resumed: [],
    failed: [],
    skipped: [],
  }),
);
let inFlightRunId: string | null = null;

vi.mock('../shared/backtest/persistence', async () => {
  const actual = await vi.importActual<any>('../shared/backtest/persistence');
  return {
    ...actual,
    persistRunPending: (...args: any[]) => mockPending(...args),
    generateRunId: () => mockGenerateRunId(),
  };
});

// Phase 4v — recovery sweep mocked at module level so we can assert
// the trigger calls it (with the regular-engine collection name) on
// every fire. Test-suite cannot rely on the real Firestore mock under
// recover.ts's `orderBy().limit().get()` chain.
vi.mock('../shared/backtest-resume/recover', () => ({
  recoverStuckBacktestRuns: (...args: any[]) =>
    mockRecoverStuckBacktestRuns(...args),
}));

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      where: () => ({
        limit: () => ({
          async get() {
            if (inFlightRunId == null) {
              return { docs: [] };
            }
            return {
              docs: [
                {
                  id: inFlightRunId,
                  data: () => ({
                    status: 'running',
                    // Within the 30-min window.
                    startedAt: new Date().toISOString(),
                  }),
                },
              ],
            };
          },
        }),
      }),
    }),
  }),
}));

import { handler } from '../backtest-runs-trigger';

function makeEvent(opts: {
  method?: string;
  body?: any;
  host?: string;
} = {}): any {
  return {
    httpMethod: opts.method ?? 'POST',
    body: opts.body == null ? null : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    headers: { host: opts.host ?? 'tradeiq-alpha.netlify.app' },
    queryStringParameters: null,
    path: '/api/backtest-runs',
    rawUrl: '',
    rawQuery: '',
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
  };
}

async function invoke(h: any, event: any): Promise<{ statusCode: number; body: string }> {
  const res = await h(event, {} as any, () => {});
  return res as any;
}

// A valid prophet/dow config that passes validateConfig.
const validConfig = {
  universe: 'dow',
  startDate: '2018-01-01',
  endDate: '2018-04-01',
  rebalanceFrequency: 'monthly',
  board: 'prophet',
  portfolio: {
    topN: 10,
    weighting: 'equal',
    maxPositionPct: 0.1,
    maxSectorPct: 0.4,
    cashSleeve: 0.05,
    minComposite: 50,
  },
  costs: { slippageBps: { dow: 3 }, commission: 0 },
  initialCapital: 10000,
};

describe('backtest-runs-trigger', () => {
  let fetchSpy: any;

  beforeEach(() => {
    inFlightRunId = null;
    mockPending.mockReset();
    mockPending.mockResolvedValue(undefined);
    mockGenerateRunId.mockReset();
    mockGenerateRunId.mockReturnValue('bt_test_001');
    mockRecoverStuckBacktestRuns.mockReset();
    mockRecoverStuckBacktestRuns.mockResolvedValue({
      inspected: 0,
      resumed: [],
      failed: [],
      skipped: [],
    });
    // global fetch returns a resolved 202 — the trigger fire-and-forgets,
    // so the resolution is observed asynchronously after the handler returns.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 202,
      text: async () => '',
      json: async () => ({ ok: true }),
      headers: { get: () => null },
    } as any));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns 405 on GET', async () => {
    const res = await invoke(handler, makeEvent({ method: 'GET' }));
    expect(res.statusCode).toBe(405);
    expect(mockPending).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON body', async () => {
    const res = await invoke(handler, makeEvent({ body: '{not json' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/invalid config json/);
    expect(mockPending).not.toHaveBeenCalled();
  });

  it('returns 400 when config fails validateConfig (startDate > endDate)', async () => {
    const res = await invoke(
      handler,
      makeEvent({ body: { ...validConfig, startDate: '2024-01-01', endDate: '2018-01-01' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/startDate.*endDate/i);
    expect(mockPending).not.toHaveBeenCalled();
  });

  it('returns 400 when startDate is before 2018-01-01 (engine floor)', async () => {
    const res = await invoke(
      handler,
      makeEvent({ body: { ...validConfig, startDate: '2017-06-01' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/2018-01-01/);
    expect(mockPending).not.toHaveBeenCalled();
  });

  // Wave 4D (track-3 minor 10) — a future endDate is clamped to today
  // (with a warning surfaced in the 202 body), not rejected, so
  // "through today"-style windows keep working.
  it('clamps a future endDate to today, persists the clamped config, and surfaces a warning', async () => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const res = await invoke(
      handler,
      makeEvent({ body: { ...validConfig, endDate: '2099-01-01' } }),
    );
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/endDate 2099-01-01 is in the future/);
    // The pending row (and the dispatched config) must carry the CLAMPED
    // endDate, not the future one.
    expect(mockPending).toHaveBeenCalledTimes(1);
    const persistedConfig = mockPending.mock.calls[0][1];
    expect(persistedConfig.endDate).toBe(todayIso);
  });

  it('returns no warnings for an untouched, valid config', async () => {
    const res = await invoke(handler, makeEvent({ body: validConfig }));
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).warnings).toEqual([]);
  });

  it('returns 400 when board lacks PIT scoring (catalyst/insider)', async () => {
    for (const board of ['catalyst', 'insider']) {
      const res = await invoke(
        handler,
        makeEvent({ body: { ...validConfig, board } }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/not supported/i);
    }
    expect(mockPending).not.toHaveBeenCalled();
  });

  it('accepts williams, lynch, and target boards (PIT scoring landed in Phase 4m+4n+4t)', async () => {
    for (const board of ['williams', 'lynch', 'target']) {
      mockPending.mockClear();
      mockGenerateRunId.mockReturnValue(`bt_${board}_001`);
      const res = await invoke(
        handler,
        makeEvent({ body: { ...validConfig, board } }),
      );
      expect(res.statusCode).toBe(202);
      expect(mockPending).toHaveBeenCalledTimes(1);
    }
  });

  it('returns 409 when an in-flight run exists, with the existing runId', async () => {
    inFlightRunId = 'bt_inflight_existing';
    const res = await invoke(handler, makeEvent({ body: validConfig }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.runId).toBe('bt_inflight_existing');
    expect(body.error).toMatch(/already running/i);
    expect(mockPending).not.toHaveBeenCalled();
  });

  it('happy path: 202 with new runId, persists pending row, fires background', async () => {
    const res = await invoke(handler, makeEvent({ body: validConfig }));
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.runId).toBe('bt_test_001');
    // Post-fix: trigger awaits the dispatch, so dispatchOk lands true
    // in the response body when the fetch resolves successfully.
    expect(body.dispatchOk).toBe(true);

    // Pending row was written with the same runId.
    expect(mockPending).toHaveBeenCalledTimes(1);
    expect(mockPending.mock.calls[0][0]).toBe('bt_test_001');
    expect(mockPending.mock.calls[0][1]).toEqual(validConfig);

    // Background was dispatched. Post-fix the dispatch is awaited, so
    // no microtask wait is required to observe the call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://tradeiq-alpha.netlify.app/.netlify/functions/run-backtest-background');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ runId: 'bt_test_001', config: validConfig });
  });

  it('uses the request host to build the background URL (deploy previews)', async () => {
    const res = await invoke(
      handler,
      makeEvent({ body: validConfig, host: 'deploy-preview-99--tradeiq-alpha.netlify.app' }),
    );
    expect(res.statusCode).toBe(202);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://deploy-preview-99--tradeiq-alpha.netlify.app/.netlify/functions/run-backtest-background',
    );
  });

  it('returns 500 if the pending write itself fails', async () => {
    mockPending.mockRejectedValueOnce(new Error('firestore unavailable'));
    const res = await invoke(handler, makeEvent({ body: validConfig }));
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/failed to queue/i);
    // Background dispatch must NOT happen if we never wrote the pending row.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Phase 5a seed-runs depend on launching 5 configs back-to-back inside
  // one wall-clock window. The default 30-min single-flight blocks runs
  // 2-5; `allowParallel: true` opts out of that check for the caller who
  // explicitly wants concurrent runs.
  it('bypasses single-flight when allowParallel:true is in the body', async () => {
    inFlightRunId = 'bt_inflight_existing';
    const res = await invoke(
      handler,
      makeEvent({ body: { ...validConfig, allowParallel: true } }),
    );
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.runId).toBe('bt_test_001');
    expect(body.allowParallel).toBe(true);
    // Pending row was written, and the persisted config does NOT include
    // the allowParallel sidecar (stripped before persist).
    expect(mockPending).toHaveBeenCalledTimes(1);
    expect(mockPending.mock.calls[0][1]).toEqual(validConfig);
    expect(mockPending.mock.calls[0][1]).not.toHaveProperty('allowParallel');
  });

  it('bypasses single-flight when ?parallel=1 is in the query string', async () => {
    inFlightRunId = 'bt_inflight_existing';
    const event = makeEvent({ body: validConfig });
    event.queryStringParameters = { parallel: '1' };
    const res = await invoke(handler, event);
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.allowParallel).toBe(true);
    expect(mockPending).toHaveBeenCalledTimes(1);
  });

  it('without allowParallel, in-flight error message points at the new opt-in', async () => {
    inFlightRunId = 'bt_inflight_existing';
    const res = await invoke(handler, makeEvent({ body: validConfig }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/allowParallel/i);
  });

  // ---- bg-dispatch regression tests (mirrors PR #30) ----
  //
  // Bug context: bt_20260515115436_ixxt1o sat at 'pending' for hours
  // because the trigger fired an UNAWAITED fetch and AWS Lambda froze
  // the container before the POST left. The fix awaits the dispatch
  // (with a 3s timeout race so the trigger stays within its 26s
  // budget even on a slow gateway). Same fix as PR #30 applied to
  // the portfolio path.

  it('AWAITS the dispatch fetch before returning (regression test for the stuck-pending bug)', async () => {
    // The bug: the original implementation did `fetch(...).then(...)` without
    // awaiting, so the trigger could return before Lambda actually sent the
    // POST. The fix awaits the fetch. We verify by making fetch resolve
    // asynchronously and asserting the trigger only returns after it does.
    let dispatchResolved = false;
    fetchSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            dispatchResolved = true;
            resolve({
              ok: true,
              status: 202,
              text: async () => '',
              json: async () => ({ ok: true }),
              headers: { get: () => null },
            } as any);
          }, 30);
        }),
    );
    const res = await invoke(handler, makeEvent({ body: validConfig }));
    // If the trigger had returned before awaiting fetch, this would be false.
    expect(dispatchResolved).toBe(true);
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.dispatchOk).toBe(true);
  });

  it('returns 202 with dispatchOk:false when the dispatch times out', async () => {
    // Simulate a hung gateway — fetch never resolves. The trigger should
    // race against its 3s internal timeout and return cleanly so the
    // 26s trigger budget isn't blown.
    fetchSpy.mockImplementation(() => new Promise(() => {})); // never resolves
    const start = Date.now();
    const res = await invoke(handler, makeEvent({ body: validConfig }));
    const elapsed = Date.now() - start;
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.dispatchOk).toBe(false);
    expect(body.runId).toBe('bt_test_001');
    // 3s race timeout + small slack — must NOT be the 26s trigger timeout.
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  it('returns 202 with dispatchOk:false when the dispatch fetch throws', async () => {
    // A network error on the dispatch (DNS failure, connection reset, etc.)
    // should be logged and swallowed — the pending row is already in
    // Firestore, the user has the runId, and the trigger still returns 202.
    // The response surfaces dispatchOk:false so the orchestrator/UI can
    // detect the degraded state.
    fetchSpy.mockImplementation(async () => {
      throw new Error('ECONNRESET');
    });
    const res = await invoke(handler, makeEvent({ body: validConfig }));
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.dispatchOk).toBe(false);
    expect(body.runId).toBe('bt_test_001');
  });

  // ---- Phase 4v stuck-run recovery wiring ----
  //
  // Two Phase 4t composite runs (sp500 + russell2k) stalled at
  // status='running' after PR #48. Diagnosis:
  // reports/phase-4v-backtest-concurrency/diagnosis.md. The portfolio
  // path already had `recoverStuckBacktestRuns` wired in scan-portfolio-
  // backtest-cron.ts; the non-portfolio trigger had no equivalent. This
  // test pins the wiring so the gap doesn't reopen.

  it('calls recoverStuckBacktestRuns against the regular collection before the single-flight check', async () => {
    const res = await invoke(handler, makeEvent({ body: validConfig }));
    expect(res.statusCode).toBe(202);
    expect(mockRecoverStuckBacktestRuns).toHaveBeenCalledTimes(1);
    const callArgs = mockRecoverStuckBacktestRuns.mock.calls[0][0];
    expect(callArgs.collection).toBe('backtestRuns');
    expect(callArgs.functionPath).toBe('/.netlify/functions/run-backtest-background');
    expect(typeof callArgs.origin).toBe('string');
    expect(callArgs.origin).toMatch(/^https?:\/\//);
  });

  it('runs the recovery sweep even when single-flight is bypassed (allowParallel:true)', async () => {
    // allowParallel:true takes the bypass branch — recovery must still
    // run because a stuck run from a prior parallel fire is exactly the
    // case Chad hit on 2026-05-19.
    inFlightRunId = 'bt_inflight_existing';
    const res = await invoke(
      handler,
      makeEvent({ body: { ...validConfig, allowParallel: true } }),
    );
    expect(res.statusCode).toBe(202);
    expect(mockRecoverStuckBacktestRuns).toHaveBeenCalledTimes(1);
  });

  it('does not block the trigger when recoverStuckBacktestRuns throws', async () => {
    // Recovery is best-effort. A Firestore hiccup here must not block
    // a fresh trigger — mirrors the portfolio cron's contract.
    mockRecoverStuckBacktestRuns.mockRejectedValue(new Error('firestore down'));
    const res = await invoke(handler, makeEvent({ body: validConfig }));
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).runId).toBe('bt_test_001');
    expect(mockPending).toHaveBeenCalledTimes(1);
  });

  it('runs recovery BEFORE the single-flight check (so a resumed run advances first)', async () => {
    // The order matters: recovery's resume may advance a stuck run's
    // cursor or fail it, which changes what `findInFlightRun` sees.
    // Mirrors the portfolio cron's docstring at
    // scan-portfolio-backtest-cron.ts:160-167.
    const callOrder: string[] = [];
    mockRecoverStuckBacktestRuns.mockImplementation(async () => {
      callOrder.push('recover');
      return { inspected: 0, resumed: [], failed: [], skipped: [] };
    });
    mockPending.mockImplementation(async () => {
      callOrder.push('pending');
    });
    await invoke(handler, makeEvent({ body: validConfig }));
    expect(callOrder).toEqual(['recover', 'pending']);
  });
});
