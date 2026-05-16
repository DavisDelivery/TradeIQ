// Phase 4e-1-infra — regular bg-function checkpoint chain integration.
//
// Drives the bg-function across consecutive invocations using the SAME
// mock-Firestore doc so cursor written by invocation N is read by N+1.
// Verifies the full chain: fresh → partial → partial → terminal.
//
// The batched engine is mocked to advance the cursor by BATCH_SIZE each
// call and produce per-batch ml rows, simulating what Netlify will see
// in production for a full sp500/monthly run.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

let storedDoc: Record<string, unknown> | null = null;
const writeOps: Array<{
  collection: string;
  doc: string;
  payload: any;
}> = [];

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: (cn: string) => ({
      doc: (dn: string) => ({
        get: async () => ({
          exists: storedDoc !== null,
          data: () => storedDoc ?? undefined,
        }),
        set: async (payload: any, opts?: { merge?: boolean }) => {
          writeOps.push({ collection: cn, doc: dn, payload });
          if (opts?.merge) {
            storedDoc = { ...(storedDoc ?? {}), ...payload };
          } else {
            storedDoc = { ...payload };
          }
        },
      }),
    }),
  })),
}));

const mockPersistRunRunning = vi.fn(async (..._args: any[]) => {});
const mockPersistRunResult = vi.fn(async (..._args: any[]) => {});
const mockPersistRunFailure = vi.fn(async (..._args: any[]) => {});
const mockAppendMl = vi.fn(async (..._args: any[]) => {});
const mockReadAllMl = vi.fn(async (..._args: any[]) => [] as any[]);

vi.mock('../shared/backtest/persistence', () => ({
  persistRunRunning: (...args: any[]) => mockPersistRunRunning(...args),
  persistRunResult: (...args: any[]) => mockPersistRunResult(...args),
  persistRunFailure: (...args: any[]) => mockPersistRunFailure(...args),
  appendMLTrainingRows: (...args: any[]) => mockAppendMl(...args),
  readAllMLTrainingRows: (...args: any[]) => mockReadAllMl(...args),
}));

vi.mock('../shared/backtest/engine', () => ({
  validateConfig: vi.fn(() => {}),
}));

const TOTAL_REBALANCES = 24;
const BATCH_SIZE = 8;

const mockProcessBatch = vi.fn();
const mockFinalize = vi.fn();
const mockPrepRun = vi.fn(async (..._args: any[]) => ({
  rebalanceDates: Array.from({ length: TOTAL_REBALANCES }, (_, i) => `2024-${(i + 1).toString().padStart(2, '0')}-01`),
  benchTicker: 'SPY',
  benchBars: [] as any[],
  survivorship: { corrected: true, coverageThrough: null as string | null },
}));
const mockInitialRegularState = vi.fn(
  (...args: any[]) => {
    const [config, total, firstDate] = args;
    return {
      nextRebalanceIdx: 0,
      totalRebalances: total,
      portfolio: [],
      nav: config.initialCapital ?? 100_000,
      dailyEquity: [{ date: firstDate, value: config.initialCapital ?? 100_000 }],
      trades: [],
      attribution: [],
      warnings: [],
      tickerFailureSample: [],
      tickerFailureTotal: 0,
      tickerAttemptTotal: 0,
      mlTrainingRowCount: 0,
      survivorshipWarned: false,
    };
  },
);

vi.mock('../shared/backtest/engine-batched', () => ({
  processRegularBatch: (...args: any[]) => mockProcessBatch(...args),
  finalizeRegularBacktest: (...args: any[]) => mockFinalize(...args),
  prepRun: (...args: any[]) => mockPrepRun(...args),
  initialRegularState: (...args: any[]) => mockInitialRegularState(...args),
}));

const fetchSpy = vi.fn(async (..._args: any[]): Promise<{ status: number }> => ({ status: 202 }));
const originalFetch = globalThis.fetch;
(globalThis as any).fetch = fetchSpy;

import { handler } from '../run-backtest-background';

const sampleConfig = {
  universe: 'sp500' as const,
  startDate: '2018-01-01',
  endDate: '2024-12-31',
  rebalanceFrequency: 'monthly' as const,
  board: 'prophet' as const,
  portfolio: {
    topN: 50,
    weighting: 'equal' as const,
    maxPositionPct: 0.05,
    maxSectorPct: 0.4,
    cashSleeve: 0.0,
    minComposite: 50,
  },
  costs: { slippageBps: { sp500: 10 }, commission: 0 },
  initialCapital: 100_000,
};

function makeEvent(body: any) {
  return {
    httpMethod: 'POST',
    body: JSON.stringify(body),
    headers: { 'x-forwarded-host': 'tradeiq-alpha.netlify.app', 'x-forwarded-proto': 'https' },
    queryStringParameters: null,
    path: '/.netlify/functions/run-backtest-background',
    rawUrl: '',
    rawQuery: '',
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
  } as any;
}

async function invoke(ev: any, ctx: any = {}) {
  return (await (handler as any)(ev, ctx, () => {})) as { statusCode: number; body: string };
}

// Drives the engine batch-by-batch.
function setupAdvancingEngine() {
  mockProcessBatch.mockImplementation(async (opts: any) => {
    const start = opts.state.nextRebalanceIdx;
    const next = Math.min(start + BATCH_SIZE, TOTAL_REBALANCES);
    const rebalancesProcessed = next - start;
    const batchMlRows = Array.from({ length: rebalancesProcessed * 50 }, (_, i) => ({
      runId: opts.runId,
      ticker: `T${i}`,
    }));
    return {
      state: {
        ...opts.state,
        nextRebalanceIdx: next,
        trades: opts.state.trades.concat(Array.from({ length: rebalancesProcessed * 10 }).map(() => ({}))),
        mlTrainingRowCount: opts.state.mlTrainingRowCount + batchMlRows.length,
      },
      done: next >= TOTAL_REBALANCES,
      rebalancesProcessed,
      batchMlRows,
    };
  });
  mockFinalize.mockImplementation((opts: any) => ({
    runId: opts.runId,
    config: opts.config,
    metrics: { tradeCount: 240, totalReturnPct: 60, rebalanceCount: TOTAL_REBALANCES } as any,
    dailyEquity: [],
    trades: [],
    perAnalystAttribution: [],
    universeSurvivorshipCorrected: { universe: 'sp500' as const, corrected: true, coverageThrough: null },
    warnings: [],
    tickerFailures: { total: 0, totalAttempts: 0, failureRatePct: 0, sample: [] },
    completedAt: '2024-12-31T00:00:00.000Z',
    benchmark: { ticker: 'SPY', totalReturnPct: 50 },
  }));
}

beforeEach(() => {
  storedDoc = null;
  writeOps.length = 0;
  mockPersistRunRunning.mockClear();
  mockPersistRunResult.mockClear();
  mockPersistRunFailure.mockClear();
  mockAppendMl.mockClear();
  mockReadAllMl.mockClear();
  mockReadAllMl.mockImplementation(async () => []);
  mockProcessBatch.mockReset();
  mockFinalize.mockReset();
  mockInitialRegularState.mockClear();
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({ status: 202 } as any);
});

afterAll(() => {
  (globalThis as any).fetch = originalFetch;
});

describe('regular bg-function checkpoint chain — 3 batches × 8 rebalances', () => {
  it('first invocation: init, persistRunRunning, append ml rows at idx=0, write cursor, reinvoke', async () => {
    setupAdvancingEngine();
    // Production trigger has already persisted the config on 'pending'.
    storedDoc = { runId: 'bt_chain_x', config: sampleConfig, status: 'pending' };
    const waitUntilSpy = vi.fn();
    const res = await invoke(makeEvent({ runId: 'bt_chain_x', config: sampleConfig }), {
      waitUntil: waitUntilSpy,
    });
    expect(res.statusCode).toBe(202);

    expect(mockInitialRegularState).toHaveBeenCalledTimes(1);
    expect(mockPersistRunRunning).toHaveBeenCalledWith('bt_chain_x');

    // 8 rebalances * 50 positions = 400 ml rows appended at startIdx=0.
    expect(mockAppendMl).toHaveBeenCalledWith('bt_chain_x', expect.any(Array), 0);
    const [, rows] = mockAppendMl.mock.calls[0];
    expect(rows.length).toBe(400);

    // Cursor written.
    const stored = storedDoc as any;
    expect(stored.cursor.nextRebalanceIndex).toBe(8);
    expect(stored.cursor.invocationCount).toBe(1);
    expect(stored.cursor.cumulativeMetrics.mlTrainingCount).toBe(400);

    // Reinvoke fired via context.waitUntil.
    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Reinvoke body has runId + resume: true (no config carry).
    const init = fetchSpy.mock.calls[0][1] as any;
    const reinvokeBody = JSON.parse(init.body);
    expect(reinvokeBody.runId).toBe('bt_chain_x');
    expect(reinvokeBody.resume).toBe(true);
  });

  it('second invocation: reads persisted config + cursor, appends at idx=400', async () => {
    setupAdvancingEngine();
    storedDoc = { runId: 'bt_chain_x', config: sampleConfig, status: 'pending' };
    await invoke(makeEvent({ runId: 'bt_chain_x', config: sampleConfig }), {
      waitUntil: vi.fn(),
    });
    writeOps.length = 0;
    mockAppendMl.mockClear();
    fetchSpy.mockClear();
    mockPersistRunRunning.mockClear();
    // Second invocation comes in as `{runId, resume: true}` — config from doc.
    const res = await invoke(makeEvent({ runId: 'bt_chain_x', resume: true }), {
      waitUntil: vi.fn(),
    });
    expect(res.statusCode).toBe(202);

    // initialRegularState NOT called again.
    expect(mockInitialRegularState).toHaveBeenCalledTimes(1);
    // persistRunRunning NOT called on resume.
    expect(mockPersistRunRunning).not.toHaveBeenCalled();

    // Append happens at startIdx=400 (after first batch).
    expect(mockAppendMl).toHaveBeenCalledWith('bt_chain_x', expect.any(Array), 400);

    const stored = storedDoc as any;
    expect(stored.cursor.nextRebalanceIndex).toBe(16);
    expect(stored.cursor.invocationCount).toBe(2);
    expect(stored.cursor.cumulativeMetrics.mlTrainingCount).toBe(800);
  });

  it('terminal batch: readAllMl + finalize + persistRunResult + clearCursor + no reinvoke', async () => {
    setupAdvancingEngine();
    storedDoc = { runId: 'bt_chain_x', config: sampleConfig, status: 'pending' };
    mockReadAllMl.mockResolvedValue(Array.from({ length: 1200 }, () => ({ runId: 'bt_chain_x' } as any)));
    await invoke(makeEvent({ runId: 'bt_chain_x', config: sampleConfig }), { waitUntil: vi.fn() });
    await invoke(makeEvent({ runId: 'bt_chain_x', resume: true }), { waitUntil: vi.fn() });
    writeOps.length = 0;
    fetchSpy.mockClear();
    const res = await invoke(makeEvent({ runId: 'bt_chain_x', resume: true }));
    expect(res.statusCode).toBe(200);

    expect(mockReadAllMl).toHaveBeenCalledWith('bt_chain_x');
    expect(mockFinalize).toHaveBeenCalledTimes(1);
    const finalizeArgs = mockFinalize.mock.calls[0][0] as any;
    expect(finalizeArgs.allMlRows.length).toBe(1200);

    expect(mockPersistRunResult).toHaveBeenCalledTimes(1);

    // Cursor cleared.
    const stored = storedDoc as any;
    expect(stored.cursor).toBeNull();

    // No reinvoke on terminal batch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('full chain ends with 3 invocations: 2 partial + 1 terminal', async () => {
    setupAdvancingEngine();
    storedDoc = { runId: 'bt_chain_y', config: sampleConfig, status: 'pending' };
    const statuses: number[] = [];
    let safety = 0;
    while ((storedDoc as any).cursor !== null && (storedDoc as any).status !== 'failed') {
      const body = safety === 0
        ? { runId: 'bt_chain_y', config: sampleConfig }
        : { runId: 'bt_chain_y', resume: true };
      const res = await invoke(makeEvent(body), { waitUntil: vi.fn() });
      statuses.push(res.statusCode);
      if (safety++ > 10) throw new Error('chain did not terminate');
    }
    expect(statuses).toEqual([202, 202, 200]);
    expect((storedDoc as any).cursor).toBeNull();
    expect(mockPersistRunResult).toHaveBeenCalledTimes(1);
    // Across the chain we should have called appendMLTrainingRows 3 times.
    expect(mockAppendMl).toHaveBeenCalledTimes(3);
    // Each call at the proper startIdx.
    expect(mockAppendMl.mock.calls[0][2]).toBe(0);
    expect(mockAppendMl.mock.calls[1][2]).toBe(400);
    expect(mockAppendMl.mock.calls[2][2]).toBe(800);
  });
});
