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
let inFlightRunId: string | null = null;

vi.mock('../shared/backtest/persistence', async () => {
  const actual = await vi.importActual<any>('../shared/backtest/persistence');
  return {
    ...actual,
    persistRunPending: (...args: any[]) => mockPending(...args),
    generateRunId: () => mockGenerateRunId(),
  };
});

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

  it('returns 400 when board is not prophet', async () => {
    const res = await invoke(
      handler,
      makeEvent({ body: { ...validConfig, board: 'catalyst' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/only the prophet board/i);
    expect(mockPending).not.toHaveBeenCalled();
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

    // Pending row was written with the same runId.
    expect(mockPending).toHaveBeenCalledTimes(1);
    expect(mockPending.mock.calls[0][0]).toBe('bt_test_001');
    expect(mockPending.mock.calls[0][1]).toEqual(validConfig);

    // Background was dispatched. Because the call is fire-and-forget,
    // we wait a microtask for the dispatch to register.
    await new Promise((r) => setTimeout(r, 5));
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
    await new Promise((r) => setTimeout(r, 5));
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
});
