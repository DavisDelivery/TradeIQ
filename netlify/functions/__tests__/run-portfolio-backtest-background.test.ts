// Phase 4e-1-infra — checkpoint-and-resume bg-function tests.
//
// The portfolio bg-function now drives a batched harness with cursor +
// watchdog + self-reinvoke. These tests pin the contracts the orchestrator
// needs to trust in production:
//
//   1. HTTP plumbing: 405 on non-POST, 400 on missing payload fields.
//   2. Fresh start: cursor null → init state, flip status to 'running',
//      run batch, write cursor, dispatch reinvoke, return 202.
//   3. Resume: cursor non-null → reuse state, increment invocationCount,
//      do NOT re-stamp runningAt.
//   4. Terminal batch: done=true → finalize, write 'done' summary, write
//      detail/full subdoc, clear cursor, return 200.
//   5. Reinvoke uses context.waitUntil — never bare fetch (mirrors PR
//      #30/#31 fix at the trigger layer).
//   6. Error path: handler catches, writes failed status, returns 500.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

let storedDoc: Record<string, unknown> | null = null;
const writeOps: Array<{
  collection: string;
  doc: string;
  sub?: string;
  subDoc?: string;
  payload: any;
  merge?: boolean;
}> = [];
const mockSetImpl = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: vi.fn(() => {
    const dbObj: any = {
      collection: (cn: string) => ({
        doc: (dn: string) => ({
          get: async () => ({
            exists: storedDoc !== null,
            data: () => storedDoc ?? undefined,
          }),
          set: async (payload: any, opts?: { merge?: boolean }) => {
            writeOps.push({
              collection: cn,
              doc: dn,
              payload,
              merge: !!opts?.merge,
            });
            if (opts?.merge) {
              storedDoc = { ...(storedDoc ?? {}), ...payload };
            } else {
              storedDoc = { ...payload };
            }
            return mockSetImpl(payload, opts);
          },
          collection: (subCn: string) => ({
            doc: (subDn: string) => ({
              set: async (payload: any) => {
                writeOps.push({
                  collection: cn,
                  doc: dn,
                  sub: subCn,
                  subDoc: subDn,
                  payload,
                });
                return mockSetImpl(payload);
              },
            }),
            // Phase 4u — readAllPortfolio* helpers iterate the subcollection.
            get: async () => ({
              forEach: (_cb: (d: { data: () => any }) => void) => {},
            }),
          }),
        }),
      }),
      // Phase 4u — append helpers use a batched write.
      batch: () => {
        const ops: Array<() => Promise<void>> = [];
        return {
          set: (docRef: any, payload: any) => {
            ops.push(async () => {
              await docRef.set(payload);
            });
          },
          commit: async () => {
            for (const op of ops) await op();
          },
        };
      },
    };
    return dbObj;
  }),
}));

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => ({ _seconds: 1700000000, _nanoseconds: 0 }) },
}));

const mockProcessBatch = vi.fn();
const mockFinalize = vi.fn();
const mockInitialState = vi.fn((..._args: any[]) => ({
  cash: 100_000,
  positions: [],
  totalSlippage: 0,
  totalTurnoverNotional: 0,
  nextMarkIdx: 0,
  nextRebalanceIdx: 0,
  // Phase 4u — bounded cursor counters.
  equityCurveRowCount: 0,
  swapRowCount: 0,
  completedHoldRowCount: 0,
  warningRowCount: 0,
}));

vi.mock('../shared/prophet-portfolio/backtest-harness-batched', () => ({
  processPortfolioBatch: (...args: any[]) => mockProcessBatch(...args),
  finalizePortfolioBacktest: (...args: any[]) => mockFinalize(...args),
  initialPortfolioState: (...args: any[]) => mockInitialState(...args),
}));

vi.mock('../shared/prophet-portfolio/signal', () => ({
  compositeRankingSignal: { id: 'composite-v1', rankAtDate: async () => [] },
}));

vi.mock('../shared/data-provider', () => ({
  getDailyBars: vi.fn(async () => []),
}));

const fetchSpy = vi.fn(async (..._args: any[]): Promise<{ status: number }> => ({ status: 202 }));
const originalFetch = globalThis.fetch;
(globalThis as any).fetch = fetchSpy;

import { handler } from '../run-portfolio-backtest-background';

function makeEvent(opts: { method?: string; body?: any; headers?: Record<string, string> } = {}): any {
  return {
    httpMethod: opts.method ?? 'POST',
    body: opts.body == null ? null : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    headers: opts.headers ?? { 'x-forwarded-host': 'test.netlify.app', 'x-forwarded-proto': 'https' },
    queryStringParameters: null,
    path: '/.netlify/functions/run-portfolio-backtest-background',
    rawUrl: '',
    rawQuery: '',
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
  };
}

async function invoke(h: any, ev: any, ctx: any = {}): Promise<{ statusCode: number; body: string }> {
  const res = await h(ev, ctx, () => {});
  return res as any;
}

beforeEach(() => {
  storedDoc = null;
  writeOps.length = 0;
  mockSetImpl.mockClear();
  mockProcessBatch.mockReset();
  mockFinalize.mockReset();
  mockInitialState.mockClear();
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({ status: 202 } as any);
});

afterAll(() => {
  (globalThis as any).fetch = originalFetch;
});

function makeTerminalHarnessResult() {
  mockProcessBatch.mockResolvedValue({
    state: {
      cash: 100_000,
      positions: [],
      totalSlippage: 0,
      totalTurnoverNotional: 0,
      nextMarkIdx: 91,
      nextRebalanceIdx: 14,
      equityCurveRowCount: 1,
      swapRowCount: 0,
      completedHoldRowCount: 0,
      warningRowCount: 0,
    },
    done: true,
    rebalancesProcessed: 14,
    marksProcessed: 91,
    batchEquityCurve: [{ date: '2024-04-08', portfolio: 100_000, spy: null, qqq: null, iwf: null }],
    batchSwaps: [],
    batchCompletedHolds: [],
    batchWarnings: [],
  });
  mockFinalize.mockReturnValue({
    windowLabel: 'short-demo',
    startDate: '2024-01-08',
    endDate: '2024-04-08',
    portfolioReturnPct: 1.0,
    spyReturnPct: 0.5,
    qqqReturnPct: 0.7,
    iwfReturnPct: 0.4,
    excessReturnPct: 0.5,
    sharpe: 0.9,
    spySharpe: 0.6,
    maxDDPct: 5.0,
    spyMaxDDPct: 4.0,
    longestUnderwaterDays: 12,
    swapCount: 3,
    avgHoldDays: 30,
    turnoverPct: 100,
    costDragPct: 0.1,
    rebalanceCount: 14,
    swaps: [],
    equityCurve: [{ date: '2024-04-08', portfolio: 100_000, spy: null, qqq: null, iwf: null }],
    warnings: [],
  });
}

function makePartialHarnessResult() {
  const batchSwaps = [{
    swapId: '2024-01-08-bt',
    timestamp: '2024-01-08T21:00:00.000Z',
    asOfDate: '2024-01-08',
    out: [],
    in: [],
    candidatesConsidered: 5,
    swapsApplied: 0,
    snapshotId: 'bt-2024-01-08',
    notes: '',
    signalId: 'composite-v1',
  }];
  const batchEquityCurve = [{ date: '2024-01-08', portfolio: 100_000, spy: null, qqq: null, iwf: null }];
  mockProcessBatch.mockResolvedValue({
    state: {
      cash: 90_000,
      positions: [
        {
          ticker: 'AAPL',
          shares: 10,
          entryDate: '2024-01-08',
          entryPrice: 100,
          currentPrice: 100,
          marketValue: 1000,
          weight: 0.01,
          sector: 'Tech',
        },
      ],
      totalSlippage: 0,
      totalTurnoverNotional: 10_000,
      nextMarkIdx: 1,
      nextRebalanceIdx: 8,
      equityCurveRowCount: batchEquityCurve.length,
      swapRowCount: batchSwaps.length,
      completedHoldRowCount: 0,
      warningRowCount: 0,
    },
    done: false,
    rebalancesProcessed: 8,
    marksProcessed: 1,
    batchEquityCurve,
    batchSwaps,
    batchCompletedHolds: [],
    batchWarnings: [],
  });
}

describe('run-portfolio-backtest-background — HTTP plumbing', () => {
  it('rejects GET with 405', async () => {
    const res = await invoke(handler, makeEvent({ method: 'GET' }));
    expect(res.statusCode).toBe(405);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await invoke(handler, makeEvent({ body: 'not json' }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing runId with 400', async () => {
    const res = await invoke(handler, makeEvent({ body: { window: 'short-demo' } }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing window with 400', async () => {
    const res = await invoke(handler, makeEvent({ body: { runId: 'pb-short-demo-x' } }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown window with 500 (windowSpec throws)', async () => {
    const res = await invoke(handler, makeEvent({ body: { runId: 'pb-junk-x', window: 'NOT_A_WINDOW' } }));
    expect(res.statusCode).toBe(500);
    const failedWrite = writeOps.find((w) => w.payload?.status === 'failed');
    expect(failedWrite).toBeDefined();
  });
});

describe('run-portfolio-backtest-background — fresh start, terminal in one batch', () => {
  it('initializes state, flips to running, finalizes, clears cursor, returns 200', async () => {
    makeTerminalHarnessResult();
    const res = await invoke(
      handler,
      makeEvent({ body: { runId: 'pb-short-demo-x', window: 'short-demo' } }),
    );
    expect(res.statusCode).toBe(200);

    // Status flipped to running BEFORE the harness fired.
    const runningWrite = writeOps.find((w) => w.payload?.status === 'running');
    expect(runningWrite).toBeDefined();

    expect(mockInitialState).toHaveBeenCalled();

    // processPortfolioBatch was called with the env-configured batchSize.
    expect(mockProcessBatch).toHaveBeenCalledTimes(1);
    const [batchArgs] = mockProcessBatch.mock.calls[0];
    expect(batchArgs.batchSize).toBe(8);
    expect(typeof batchArgs.isExpired).toBe('function');

    // finalize was called and the 'done' summary was written.
    expect(mockFinalize).toHaveBeenCalledTimes(1);
    const doneWrite = writeOps.find((w) => w.payload?.status === 'done');
    expect(doneWrite).toBeDefined();
    expect(doneWrite!.payload.invocationCount).toBe(1);

    // detail/full subdoc was written.
    const detail = writeOps.find((w) => w.sub === 'detail' && w.subDoc === 'full');
    expect(detail).toBeDefined();
    expect(detail!.payload).toHaveProperty('equityCurve');

    // Cursor was cleared on the terminal write.
    const clearWrite = writeOps.find((w) => w.payload?.cursor === null);
    expect(clearWrite).toBeDefined();

    // No self-reinvoke on terminal batch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('run-portfolio-backtest-background — checkpoint + reinvoke', () => {
  it('writes cursor and dispatches self-reinvoke via context.waitUntil when batch is partial', async () => {
    makePartialHarnessResult();
    const waitUntilSpy = vi.fn();
    const res = await invoke(
      handler,
      makeEvent({ body: { runId: 'pb-full-y', window: 'full' } }),
      { waitUntil: waitUntilSpy },
    );
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.continuing).toBe(true);
    expect(body.invocationCount).toBe(1);
    expect(body.nextRebalanceIndex).toBe(8);

    // Cursor write happened with the post-batch state.
    const cursorWrites = writeOps.filter((w) => 'cursor' in (w.payload ?? {}));
    expect(cursorWrites.length).toBeGreaterThan(0);
    const lastCursorWrite = cursorWrites[cursorWrites.length - 1];
    expect(lastCursorWrite.payload.cursor.nextRebalanceIndex).toBe(8);

    // Self-reinvoke used context.waitUntil.
    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [reinvokeUrl, init] = fetchSpy.mock.calls[0];
    expect(reinvokeUrl).toContain('run-portfolio-backtest-background');
    expect(reinvokeUrl).toContain('test.netlify.app');
    const reinvokeBody = JSON.parse((init as any).body);
    expect(reinvokeBody).toMatchObject({ runId: 'pb-full-y', resume: true, window: 'full' });
  });

  it('resumes from existing cursor: reuses state, increments invocationCount, no fresh-init', async () => {
    makeTerminalHarnessResult();
    storedDoc = {
      runId: 'pb-full-z',
      status: 'running',
      cursor: {
        nextRebalanceIndex: 16,
        totalRebalances: 84,
        lastInvocationStartedAt: '2026-05-15T14:00:00.000Z',
        invocationCount: 2,
        state: {
          cash: 60_000,
          positions: [],
          totalSlippage: 0,
          totalTurnoverNotional: 0,
          nextMarkIdx: 100,
          nextRebalanceIdx: 16,
          equityCurveRowCount: 100,
          swapRowCount: 16,
          completedHoldRowCount: 4,
          warningRowCount: 0,
        },
        cumulativeMetrics: { tradeCount: 16, mlTrainingCount: 80 },
      },
    };
    const res = await invoke(
      handler,
      makeEvent({ body: { runId: 'pb-full-z', window: 'full' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(mockInitialState).not.toHaveBeenCalled();
    // batch received the resumed state, not a freshly initialized one.
    const [batchArgs] = mockProcessBatch.mock.calls[0];
    expect(batchArgs.state.nextRebalanceIdx).toBe(16);
    expect(batchArgs.state.cash).toBe(60_000);

    // Summary writes invocationCount = previous + 1 = 3.
    const doneWrite = writeOps.find((w) => w.payload?.status === 'done');
    expect(doneWrite!.payload.invocationCount).toBe(3);
  });
});

describe('run-portfolio-backtest-background — error path', () => {
  it('writes failed status when batched harness throws', async () => {
    mockProcessBatch.mockRejectedValue(new Error('synthetic harness failure'));
    const res = await invoke(
      handler,
      makeEvent({ body: { runId: 'pb-x', window: 'short-demo' } }),
    );
    expect(res.statusCode).toBe(500);
    const failedWrite = writeOps.find((w) => w.payload?.status === 'failed');
    expect(failedWrite).toBeDefined();
    expect(failedWrite!.payload?.error).toMatch(/synthetic harness failure/);
  });
});
