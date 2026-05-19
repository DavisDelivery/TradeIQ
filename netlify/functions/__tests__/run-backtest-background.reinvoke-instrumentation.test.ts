// Phase 4v — non-portfolio bg-function reinvoke instrumentation regression.
//
// Pins the contract added in Phase 4v: the regular bg-function MUST
// always stamp the W1b telemetry fields (`lastReinvokeAt`,
// `reinvokeAttempts`, `lastReinvokeRetries`, `lastReinvokeStatus`)
// onto the cursor after every reinvoke dispatch — success OR failure
// — AND pass a non-zero `jitterMs` to `dispatchReinvoke`.
//
// Pre-4v the regular bg-function only stamped `lastReinvokeError` on
// failure and passed jitterMs=0 (default). Result observed live:
// bt_20260519184826_khgy8s (russell2k Phase 4t composite) sat at
// status='running' after 6 batches with zero W1b telemetry on its
// cursor, leaving us unable to distinguish "dispatch never ran" from
// "dispatch ran and the next invocation was throttled".
//
// The portfolio bg-function has had this contract since Phase 4r-W1b
// (run-portfolio-backtest-background.ts:417-433). This test pins the
// regular bg-function to the same shape.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchReinvoke: vi.fn<(...args: any[]) => Promise<any>>(),
}));

let storedDoc: Record<string, unknown> | null = null;

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: (_cn: string) => ({
      doc: (_dn: string) => ({
        get: async () => ({
          exists: storedDoc !== null,
          data: () => storedDoc ?? undefined,
        }),
        set: async (payload: any, opts?: { merge?: boolean }) => {
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

vi.mock('../shared/backtest/persistence', () => ({
  persistRunRunning: vi.fn(async () => {}),
  persistRunSummary: vi.fn(async () => {}),
  persistRunFailure: vi.fn(async () => {}),
  appendMLTrainingRows: vi.fn(async () => {}),
  appendDailyEquityRows: vi.fn(async () => {}),
  appendTradeRows: vi.fn(async () => {}),
  appendAttributionRows: vi.fn(async () => {}),
  appendWarningRows: vi.fn(async () => {}),
  readAllMLTrainingRows: vi.fn(async () => []),
  readAllDailyEquityRows: vi.fn(async () => []),
  readAllTradeRows: vi.fn(async () => []),
  readAllAttributionRows: vi.fn(async () => []),
  readAllWarningRows: vi.fn(async () => []),
}));

vi.mock('../shared/backtest/engine', () => ({
  validateConfig: vi.fn(() => {}),
}));

const mockProcessBatch = vi.fn();
const mockInitialState = vi.fn<(...args: any[]) => any>(
  (config: any, total: number) => ({
    nextRebalanceIdx: 0,
    totalRebalances: total,
    portfolio: [],
    nav: config.initialCapital ?? 100_000,
    tickerFailureSample: [],
    tickerFailureTotal: 0,
    tickerAttemptTotal: 0,
    mlTrainingRowCount: 0,
    dailyEquityRowCount: 0,
    tradeRowCount: 0,
    attributionRowCount: 0,
    warningRowCount: 0,
    survivorshipWarned: false,
  }),
);

vi.mock('../shared/backtest/engine-batched', () => ({
  processRegularBatch: (...args: any[]) => mockProcessBatch(...args),
  finalizeRegularBacktest: vi.fn(),
  prepRun: vi.fn(async () => ({
    rebalanceDates: ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01'],
    benchTicker: 'SPY',
    benchBars: [],
    survivorship: { corrected: true, coverageThrough: null },
  })),
  initialRegularState: (...args: any[]) => mockInitialState(...args),
}));

vi.mock('../shared/backtest-resume/reinvoke', async () => {
  const actual = await vi.importActual<any>('../shared/backtest-resume/reinvoke');
  return {
    ...actual,
    dispatchReinvoke: (...args: any[]) => mocks.dispatchReinvoke(...args),
  };
});

const originalFetch = globalThis.fetch;
(globalThis as any).fetch = vi.fn(async () => ({ status: 202 } as any));

import { handler } from '../run-backtest-background';

const sampleConfig = {
  universe: 'sp500' as const,
  startDate: '2024-01-01',
  endDate: '2024-04-01',
  rebalanceFrequency: 'monthly' as const,
  board: 'target' as const,
  portfolio: {
    topN: 20,
    weighting: 'equal' as const,
    maxPositionPct: 0.08,
    maxSectorPct: 0.4,
    cashSleeve: 0.05,
    minComposite: 50,
  },
  costs: { slippageBps: { sp500: 5 }, commission: 0 },
  initialCapital: 100_000,
};

function makeEvent(body: any) {
  return {
    httpMethod: 'POST',
    body: JSON.stringify(body),
    headers: { 'x-forwarded-host': 'test.netlify.app', 'x-forwarded-proto': 'https' },
    queryStringParameters: null,
    path: '/.netlify/functions/run-backtest-background',
    rawUrl: '',
    rawQuery: '',
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
  } as any;
}

async function invoke(ev: any, ctx: any = { waitUntil: vi.fn() }) {
  return (await (handler as any)(ev, ctx, () => {})) as { statusCode: number; body: string };
}

function makePartialBatch() {
  mockProcessBatch.mockResolvedValue({
    state: {
      nextRebalanceIdx: 1,
      totalRebalances: 4,
      portfolio: [],
      nav: 100_000,
      tickerFailureSample: [],
      tickerFailureTotal: 0,
      tickerAttemptTotal: 50,
      mlTrainingRowCount: 0,
      dailyEquityRowCount: 0,
      tradeRowCount: 0,
      attributionRowCount: 0,
      warningRowCount: 0,
      survivorshipWarned: true,
    },
    done: false,
    rebalancesProcessed: 1,
    batchMlRows: [],
    batchDailyEquity: [],
    batchTrades: [],
    batchAttribution: [],
    batchWarnings: [],
  });
}

beforeEach(() => {
  storedDoc = null;
  mocks.dispatchReinvoke.mockReset();
  mockProcessBatch.mockReset();
});

afterAll(() => {
  (globalThis as any).fetch = originalFetch;
});

describe('run-backtest-background — Phase 4v reinvoke instrumentation', () => {
  it('stamps W1b telemetry fields on the cursor when dispatch succeeds', async () => {
    makePartialBatch();
    mocks.dispatchReinvoke.mockResolvedValue({
      ok: true,
      attempts: 1,
      lastStatus: 202,
    });
    storedDoc = { runId: 'bt_v4', config: sampleConfig, status: 'pending' };

    const res = await invoke(makeEvent({ runId: 'bt_v4', config: sampleConfig }));
    expect(res.statusCode).toBe(202);

    expect(mocks.dispatchReinvoke).toHaveBeenCalledTimes(1);
    const cursor = (storedDoc as any).cursor;
    expect(cursor).toBeDefined();
    expect(typeof cursor.lastReinvokeAt).toBe('string');
    expect(cursor.lastReinvokeAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cursor.reinvokeAttempts).toBe(1);
    expect(cursor.lastReinvokeRetries).toBe(1);
    expect(cursor.lastReinvokeStatus).toBe(202);
    // Success path: lastReinvokeError must be cleared (undefined).
    expect(cursor.lastReinvokeError).toBeUndefined();
  });

  it('stamps W1b telemetry fields even when dispatch fails', async () => {
    makePartialBatch();
    mocks.dispatchReinvoke.mockResolvedValue({
      ok: false,
      attempts: 4,
      lastStatus: 500,
      error: 'HTTP 500',
    });
    storedDoc = { runId: 'bt_v4_fail', config: sampleConfig, status: 'pending' };

    const res = await invoke(makeEvent({ runId: 'bt_v4_fail', config: sampleConfig }));
    expect(res.statusCode).toBe(202);

    const cursor = (storedDoc as any).cursor;
    expect(cursor).toBeDefined();
    // All four success-side telemetry fields must be set on failure too —
    // pre-4v code only wrote lastReinvokeError, so a stuck run had no
    // proof a reinvoke was even attempted.
    expect(typeof cursor.lastReinvokeAt).toBe('string');
    expect(cursor.reinvokeAttempts).toBe(1);
    expect(cursor.lastReinvokeRetries).toBe(4);
    expect(cursor.lastReinvokeStatus).toBe(500);
    expect(cursor.lastReinvokeError).toBe('HTTP 500');
  });

  it('increments reinvokeAttempts across multiple batches', async () => {
    // First batch — fresh start, reinvokeAttempts becomes 1.
    makePartialBatch();
    mocks.dispatchReinvoke.mockResolvedValue({
      ok: true,
      attempts: 1,
      lastStatus: 202,
    });
    storedDoc = { runId: 'bt_v4_chain', config: sampleConfig, status: 'pending' };

    await invoke(makeEvent({ runId: 'bt_v4_chain', config: sampleConfig }));
    expect((storedDoc as any).cursor.reinvokeAttempts).toBe(1);

    // Second batch — resume; reinvokeAttempts must become 2.
    mockProcessBatch.mockReset();
    mockProcessBatch.mockResolvedValue({
      state: {
        nextRebalanceIdx: 2,
        totalRebalances: 4,
        portfolio: [],
        nav: 100_000,
        tickerFailureSample: [],
        tickerFailureTotal: 0,
        tickerAttemptTotal: 100,
        mlTrainingRowCount: 0,
        dailyEquityRowCount: 0,
        tradeRowCount: 0,
        attributionRowCount: 0,
        warningRowCount: 0,
        survivorshipWarned: true,
      },
      done: false,
      rebalancesProcessed: 1,
      batchMlRows: [],
      batchDailyEquity: [],
      batchTrades: [],
      batchAttribution: [],
      batchWarnings: [],
    });
    await invoke(makeEvent({ runId: 'bt_v4_chain', resume: true }));
    expect((storedDoc as any).cursor.reinvokeAttempts).toBe(2);
  });

  it('passes a non-zero jitterMs to dispatchReinvoke (mirrors portfolio path)', async () => {
    makePartialBatch();
    mocks.dispatchReinvoke.mockResolvedValue({
      ok: true,
      attempts: 1,
      lastStatus: 202,
    });
    storedDoc = { runId: 'bt_v4_jit', config: sampleConfig, status: 'pending' };

    await invoke(makeEvent({ runId: 'bt_v4_jit', config: sampleConfig }));

    expect(mocks.dispatchReinvoke).toHaveBeenCalledTimes(1);
    // Call signature: (url, runId, ctx, extra, options) — options is the 5th arg.
    const callArgs = mocks.dispatchReinvoke.mock.calls[0];
    expect(callArgs.length).toBeGreaterThanOrEqual(5);
    const options = callArgs[4];
    expect(options).toBeDefined();
    expect(typeof options.jitterMs).toBe('number');
    expect(options.jitterMs).toBeGreaterThan(0);
  });
});
