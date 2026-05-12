import { describe, it, expect, beforeEach, vi } from 'vitest';

// Phase 4b-2 — background runner tests.
//
// We mock both the engine and the persistence module so the handler can
// be exercised without Firestore. Three contracts to pin:
//
//   1. HTTP plumbing: 405 on non-POST, 400 on missing payload fields.
//   2. Engine wiring: handler calls persistRunRunning then runBacktest
//      with { resumeRunId: <runId> } and the same config it received.
//   3. Error path: when the engine throws, the handler logs
//      'background_run_failed' and returns 500 (the engine's own
//      persistRunFailure path writes the Firestore failure record;
//      the handler doesn't re-write it).

const mockRunBacktest = vi.fn();
const mockPersistRunRunning = vi.fn();

vi.mock('../shared/backtest/engine', () => ({
  runBacktest: (...args: any[]) => mockRunBacktest(...args),
}));

vi.mock('../shared/backtest/persistence', () => ({
  persistRunRunning: (...args: any[]) => mockPersistRunRunning(...args),
}));

// Sentry's withSentry is a passthrough wrapper; we still invoke it so the
// handler's real export shape is exercised, but its initSentry call won't
// have a DSN in the test env and bails out gracefully.

import { handler } from '../run-backtest-background';

function makeEvent(opts: { method?: string; body?: any } = {}): any {
  return {
    httpMethod: opts.method ?? 'POST',
    body: opts.body == null ? null : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    headers: {},
    queryStringParameters: null,
    path: '/.netlify/functions/run-backtest-background',
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

const sampleConfig = {
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

describe('run-backtest-background', () => {
  beforeEach(() => {
    mockRunBacktest.mockReset();
    mockPersistRunRunning.mockReset();
  });

  it('returns 405 on non-POST', async () => {
    const res = await invoke(handler, makeEvent({ method: 'GET' }));
    expect(res.statusCode).toBe(405);
    expect(mockRunBacktest).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON body', async () => {
    const res = await invoke(handler, makeEvent({ body: '{not json' }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/invalid payload/i);
    expect(mockRunBacktest).not.toHaveBeenCalled();
  });

  it('returns 400 on missing runId', async () => {
    const res = await invoke(handler, makeEvent({ body: { config: sampleConfig } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/missing runId/i);
    expect(mockRunBacktest).not.toHaveBeenCalled();
  });

  it('returns 400 on missing config', async () => {
    const res = await invoke(handler, makeEvent({ body: { runId: 'bt_test' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/missing config/i);
    expect(mockRunBacktest).not.toHaveBeenCalled();
  });

  it('flips status to running, then awaits runBacktest with resumeRunId', async () => {
    mockPersistRunRunning.mockResolvedValue(undefined);
    mockRunBacktest.mockResolvedValue({
      runId: 'bt_xyz',
      metrics: { tradeCount: 42, totalReturnPct: 7.3 },
    });
    const res = await invoke(
      handler,
      makeEvent({ body: { runId: 'bt_xyz', config: sampleConfig } }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, runId: 'bt_xyz' });
    // Status flip happens before engine work.
    expect(mockPersistRunRunning).toHaveBeenCalledWith('bt_xyz');
    expect(mockRunBacktest).toHaveBeenCalledTimes(1);
    const [cfg, opts] = mockRunBacktest.mock.calls[0];
    expect(cfg).toEqual(sampleConfig);
    expect(opts.resumeRunId).toBe('bt_xyz');
  });

  it('does NOT abort the run if persistRunRunning fails (logs and proceeds)', async () => {
    // Defensive: a transient Firestore hiccup on the status flip
    // shouldn't kill an otherwise-valid engine run.
    mockPersistRunRunning.mockRejectedValue(new Error('firestore unavailable'));
    mockRunBacktest.mockResolvedValue({
      runId: 'bt_xyz',
      metrics: { tradeCount: 0, totalReturnPct: 0 },
    });
    const res = await invoke(
      handler,
      makeEvent({ body: { runId: 'bt_xyz', config: sampleConfig } }),
    );
    expect(res.statusCode).toBe(200);
    expect(mockRunBacktest).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the engine throws (engine writes failure itself)', async () => {
    mockPersistRunRunning.mockResolvedValue(undefined);
    mockRunBacktest.mockRejectedValue(new Error('no rebalance dates in window'));
    const res = await invoke(
      handler,
      makeEvent({ body: { runId: 'bt_xyz', config: sampleConfig } }),
    );
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.runId).toBe('bt_xyz');
    expect(body.error).toMatch(/no rebalance dates/i);
  });
});
