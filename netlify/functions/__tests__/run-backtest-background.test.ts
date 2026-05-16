// Phase 4e-1-infra — regular bg-function checkpoint tests.
//
// The regular bg-function now drives a batched engine with cursor +
// watchdog + self-reinvoke. These tests pin the production-critical
// contracts:
//
//   1. HTTP plumbing: 405 on non-POST, 400 on missing payload fields.
//   2. Fresh start: cursor null + config in body → init state, flip
//      status to 'running' via persistRunRunning, run batch, append
//      mlTraining rows, write cursor, dispatch reinvoke, return 202.
//   3. Resume: cursor non-null → re-read persisted config from the run
//      doc, increment invocationCount, do NOT re-stamp 'running'.
//   4. Terminal batch: done=true → readAllMLTrainingRows for IC,
//      finalize, persistRunResult, clearCursor, return 200.
//   5. Reinvoke uses context.waitUntil — mirrors PR #30/#31 trigger fix.
//   6. Error path: persistRunFailure writes status=failed, returns 500.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

let storedDoc: Record<string, unknown> | null = null;
const writeOps: Array<{
  collection: string;
  doc: string;
  sub?: string;
  subDoc?: string;
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

const mockValidateConfig = vi.fn((..._args: any[]) => {});

vi.mock('../shared/backtest/engine', () => ({
  validateConfig: (...args: any[]) => mockValidateConfig(...args),
}));

const mockProcessBatch = vi.fn();
const mockFinalize = vi.fn();
const mockPrepRun = vi.fn(async (..._args: any[]) => ({
  rebalanceDates: ['2024-01-02', '2024-02-01', '2024-03-01', '2024-04-01'],
  benchTicker: 'SPY',
  benchBars: [] as any[],
  survivorship: { corrected: true, coverageThrough: '2024-01-01' },
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

function makeEvent(opts: { method?: string; body?: any; headers?: Record<string, string> } = {}): any {
  return {
    httpMethod: opts.method ?? 'POST',
    body: opts.body == null ? null : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    headers: opts.headers ?? { 'x-forwarded-host': 'test.netlify.app', 'x-forwarded-proto': 'https' },
    queryStringParameters: null,
    path: '/.netlify/functions/run-backtest-background',
    rawUrl: '',
    rawQuery: '',
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
  };
}

async function invoke(ev: any, ctx: any = {}) {
  return (await (handler as any)(ev, ctx, () => {})) as { statusCode: number; body: string };
}

const sampleConfig = {
  universe: 'dow' as const,
  startDate: '2024-01-01',
  endDate: '2024-04-01',
  rebalanceFrequency: 'monthly' as const,
  board: 'prophet' as const,
  portfolio: {
    topN: 10,
    weighting: 'equal' as const,
    maxPositionPct: 0.1,
    maxSectorPct: 0.4,
    cashSleeve: 0.05,
    minComposite: 50,
  },
  costs: { slippageBps: { dow: 3 }, commission: 0 },
  initialCapital: 10000,
};

beforeEach(() => {
  storedDoc = null;
  writeOps.length = 0;
  mockPersistRunRunning.mockClear();
  mockPersistRunResult.mockClear();
  mockPersistRunFailure.mockClear();
  mockAppendMl.mockClear();
  mockReadAllMl.mockClear();
  mockReadAllMl.mockImplementation(async () => []);
  mockValidateConfig.mockClear();
  mockProcessBatch.mockReset();
  mockFinalize.mockReset();
  mockInitialRegularState.mockClear();
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({ status: 202 } as any);
});

afterAll(() => {
  (globalThis as any).fetch = originalFetch;
});

function makeTerminalBatchResult() {
  mockProcessBatch.mockResolvedValue({
    state: {
      nextRebalanceIdx: 4,
      totalRebalances: 4,
      portfolio: [],
      nav: 10_500,
      dailyEquity: [{ date: '2024-01-02', value: 10_000 }, { date: '2024-04-01', value: 10_500 }],
      trades: [{}, {}],
      attribution: [{}, {}],
      warnings: [],
      tickerFailureSample: [],
      tickerFailureTotal: 0,
      tickerAttemptTotal: 100,
      mlTrainingRowCount: 40,
      survivorshipWarned: true,
    },
    done: true,
    rebalancesProcessed: 4,
    batchMlRows: [{ runId: 'bt_x' } as any],
  });
  mockFinalize.mockReturnValue({
    runId: 'bt_x',
    config: sampleConfig,
    metrics: { tradeCount: 2, totalReturnPct: 5, rebalanceCount: 4 } as any,
    dailyEquity: [],
    trades: [],
    perAnalystAttribution: [],
    universeSurvivorshipCorrected: { universe: 'dow' as const, corrected: true, coverageThrough: '2024-01-01' },
    warnings: [],
    tickerFailures: { total: 0, totalAttempts: 100, failureRatePct: 0, sample: [] },
    completedAt: '2024-04-01T00:00:00.000Z',
    benchmark: { ticker: 'SPY', totalReturnPct: 4 },
  });
}

function makePartialBatchResult() {
  mockProcessBatch.mockResolvedValue({
    state: {
      nextRebalanceIdx: 8,
      totalRebalances: 84,
      portfolio: [],
      nav: 95_000,
      dailyEquity: [{ date: '2018-01-02', value: 100_000 }],
      trades: [{}, {}],
      attribution: [],
      warnings: [],
      tickerFailureSample: [],
      tickerFailureTotal: 0,
      tickerAttemptTotal: 400,
      mlTrainingRowCount: 400,
      survivorshipWarned: true,
    },
    done: false,
    rebalancesProcessed: 8,
    batchMlRows: Array.from({ length: 400 }, () => ({ runId: 'bt_x' } as any)),
  });
}

describe('run-backtest-background — HTTP plumbing', () => {
  it('returns 405 on non-POST', async () => {
    const res = await invoke(makeEvent({ method: 'GET' }));
    expect(res.statusCode).toBe(405);
    expect(mockProcessBatch).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON body', async () => {
    const res = await invoke(makeEvent({ body: '{not json' }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/invalid payload/i);
  });

  it('returns 400 on missing runId', async () => {
    const res = await invoke(makeEvent({ body: { config: sampleConfig } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/missing runId/i);
  });

  it('returns 400 on missing config for fresh start (no persisted config)', async () => {
    // No body.config + no storedDoc.config means we can't validate.
    const res = await invoke(makeEvent({ body: { runId: 'bt_x' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/missing config/i);
  });
});

describe('run-backtest-background — fresh start, terminal in one batch', () => {
  it('inits state, flips status to running, finalizes, clears cursor, returns 200', async () => {
    makeTerminalBatchResult();
    const res = await invoke(makeEvent({ body: { runId: 'bt_x', config: sampleConfig } }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, runId: 'bt_x' });

    expect(mockValidateConfig).toHaveBeenCalledTimes(1);
    expect(mockInitialRegularState).toHaveBeenCalled();
    expect(mockPersistRunRunning).toHaveBeenCalledWith('bt_x');

    // Batch was called with env-default batchSize.
    expect(mockProcessBatch).toHaveBeenCalledTimes(1);
    const [batchArgs] = mockProcessBatch.mock.calls[0];
    expect(batchArgs.batchSize).toBe(8);
    expect(typeof batchArgs.isExpired).toBe('function');

    // Per-batch ml rows appended with startIdx=0 (first batch).
    expect(mockAppendMl).toHaveBeenCalledWith('bt_x', expect.any(Array), 0);

    // Terminal path: readAllMl → finalize → persistRunResult → clearCursor.
    expect(mockReadAllMl).toHaveBeenCalledWith('bt_x');
    expect(mockFinalize).toHaveBeenCalledTimes(1);
    expect(mockPersistRunResult).toHaveBeenCalledTimes(1);

    // Cursor cleared on terminal.
    const clearWrite = writeOps.find((w) => w.payload?.cursor === null);
    expect(clearWrite).toBeDefined();

    // No self-reinvoke.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('run-backtest-background — checkpoint + reinvoke', () => {
  it('writes cursor and dispatches self-reinvoke via context.waitUntil when batch is partial', async () => {
    makePartialBatchResult();
    const waitUntilSpy = vi.fn();
    const res = await invoke(
      makeEvent({ body: { runId: 'bt_y', config: sampleConfig } }),
      { waitUntil: waitUntilSpy },
    );
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.continuing).toBe(true);
    expect(body.nextRebalanceIndex).toBe(8);

    // Ml rows appended for THIS batch (startIdx=0 on first invocation).
    expect(mockAppendMl).toHaveBeenCalledWith('bt_y', expect.any(Array), 0);

    // Cursor written with updated state.
    const cursorWrites = writeOps.filter((w) => 'cursor' in (w.payload ?? {}));
    expect(cursorWrites.length).toBeGreaterThan(0);
    const lastCursorWrite = cursorWrites[cursorWrites.length - 1];
    expect(lastCursorWrite.payload.cursor.nextRebalanceIndex).toBe(8);
    expect(lastCursorWrite.payload.cursor.cumulativeMetrics.mlTrainingCount).toBe(400);

    // Self-reinvoke via context.waitUntil.
    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Terminal-only writes did NOT happen.
    expect(mockPersistRunResult).not.toHaveBeenCalled();
    expect(mockReadAllMl).not.toHaveBeenCalled();
  });

  it('resume: reads persisted config from doc, reuses state, increments invocationCount, no persistRunRunning', async () => {
    makeTerminalBatchResult();
    storedDoc = {
      runId: 'bt_z',
      config: sampleConfig,
      status: 'running',
      cursor: {
        nextRebalanceIndex: 16,
        totalRebalances: 84,
        lastInvocationStartedAt: '2026-05-15T14:00:00.000Z',
        invocationCount: 2,
        state: {
          nextRebalanceIdx: 16,
          totalRebalances: 84,
          portfolio: [],
          nav: 110_000,
          dailyEquity: [],
          trades: Array(32).fill({}),
          attribution: [],
          warnings: [],
          tickerFailureSample: [],
          tickerFailureTotal: 0,
          tickerAttemptTotal: 0,
          mlTrainingRowCount: 800,
          survivorshipWarned: true,
        },
        cumulativeMetrics: { tradeCount: 32, mlTrainingCount: 800 },
      },
    };
    // Body has runId only — config comes from storedDoc.
    const res = await invoke(makeEvent({ body: { runId: 'bt_z' } }));
    expect(res.statusCode).toBe(200);

    expect(mockInitialRegularState).not.toHaveBeenCalled();
    // persistRunRunning must NOT fire on resume.
    expect(mockPersistRunRunning).not.toHaveBeenCalled();

    // Append uses startIdx = previously-persisted count = 800.
    expect(mockAppendMl).toHaveBeenCalledWith('bt_z', expect.any(Array), 800);

    // Batch received the resumed state.
    const [batchArgs] = mockProcessBatch.mock.calls[0];
    expect(batchArgs.state.nextRebalanceIdx).toBe(16);
    expect(batchArgs.state.nav).toBe(110_000);
  });
});

describe('run-backtest-background — error path', () => {
  it('writes failed status via persistRunFailure when engine-batched throws', async () => {
    mockProcessBatch.mockRejectedValue(new Error('synthetic engine failure'));
    const res = await invoke(makeEvent({ body: { runId: 'bt_x', config: sampleConfig } }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toMatch(/synthetic engine failure/);
    expect(mockPersistRunFailure).toHaveBeenCalledWith('bt_x', expect.stringMatching(/synthetic engine failure/));
  });

  it('writes failed status when validateConfig throws on a malformed config', async () => {
    mockValidateConfig.mockImplementation(() => {
      throw new Error('startDate is before 2018-01-01');
    });
    const res = await invoke(
      makeEvent({ body: { runId: 'bt_x', config: { ...sampleConfig, startDate: '2017-01-01' } } }),
    );
    expect(res.statusCode).toBe(500);
    expect(mockPersistRunFailure).toHaveBeenCalled();
  });
});
