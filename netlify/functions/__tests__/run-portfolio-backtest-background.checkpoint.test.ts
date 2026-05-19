// Phase 4e-1-infra — checkpoint integration tests (multi-invocation chain).
//
// These tests exercise the bg-function across consecutive invocations
// using the SAME mock-Firestore doc so the cursor written by invocation
// N is read by invocation N+1. They pin the end-to-end chain that
// production relies on:
//
//   1. Fresh start → partial batch 0: cursor.nextRebalanceIndex = 8,
//      status: 'running', reinvoke fires.
//   2. Resume → partial batch 1: cursor.nextRebalanceIndex = 16,
//      invocationCount = 2, reinvoke fires.
//   3. Resume → terminal: status: 'done', cursor cleared.
//
// The harness is mocked to advance the cursor's state exactly batchSize
// rebalances per call until the schedule is exhausted, simulating the
// chain Netlify will see in production.

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
  getAdminDb: vi.fn(() => {
    const dbObj: any = {
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
              },
            }),
            // Phase 4u — readAllPortfolio* helpers iterate this.
            get: async () => ({
              forEach: (_cb: (d: { data: () => any }) => void) => {
                // empty subcollection in this test — terminal finalize
                // gets [] for all 4 arrays, which the mockFinalize
                // accepts regardless.
              },
            }),
          }),
        }),
      }),
      // Phase 4u — the bg-function now appends per-batch subcollection
      // rows via batched writes; the mock needs a batch() shim.
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

const TOTAL_REBALANCES = 24; // 3 batches at batchSize=8
const BATCH_SIZE = 8;

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

function makeEvent(body: any) {
  return {
    httpMethod: 'POST',
    body: JSON.stringify(body),
    headers: { 'x-forwarded-host': 'tradeiq-alpha.netlify.app', 'x-forwarded-proto': 'https' },
    queryStringParameters: null,
    path: '/.netlify/functions/run-portfolio-backtest-background',
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

// Drives the harness forward batch-by-batch: each call advances
// nextRebalanceIdx by BATCH_SIZE and returns done=true when it reaches
// TOTAL_REBALANCES.
function setupAdvancingHarness() {
  mockProcessBatch.mockImplementation(async (opts: any) => {
    const start = opts.state.nextRebalanceIdx;
    const next = Math.min(start + BATCH_SIZE, TOTAL_REBALANCES);
    const batchSwaps = Array.from({ length: next - start }).map((_, i) => ({
      swapId: `swap-${start + i}`,
      timestamp: '2024-01-01T00:00:00.000Z',
      asOfDate: '2024-01-01',
      out: [],
      in: [],
      candidatesConsidered: 0,
      swapsApplied: 0,
      snapshotId: '',
      notes: '',
      signalId: 'composite-v1',
    }));
    return {
      state: {
        ...opts.state,
        nextRebalanceIdx: next,
        nextMarkIdx: opts.state.nextMarkIdx + 30, // arbitrary daily advance
        swapRowCount: (opts.state.swapRowCount ?? 0) + batchSwaps.length,
        equityCurveRowCount: opts.state.equityCurveRowCount ?? 0,
        completedHoldRowCount: opts.state.completedHoldRowCount ?? 0,
        warningRowCount: opts.state.warningRowCount ?? 0,
      },
      done: next >= TOTAL_REBALANCES,
      rebalancesProcessed: next - start,
      marksProcessed: 30,
      batchEquityCurve: [],
      batchSwaps,
      batchCompletedHolds: [],
      batchWarnings: [],
    };
  });
  mockFinalize.mockImplementation(() => ({
    windowLabel: 'full',
    startDate: '2018-01-01',
    endDate: '2026-01-01',
    portfolioReturnPct: 50,
    spyReturnPct: 30,
    qqqReturnPct: 40,
    iwfReturnPct: 25,
    excessReturnPct: 20,
    sharpe: 1.2,
    spySharpe: 0.8,
    maxDDPct: 15,
    spyMaxDDPct: 18,
    longestUnderwaterDays: 60,
    swapCount: TOTAL_REBALANCES,
    avgHoldDays: 45,
    turnoverPct: 80,
    costDragPct: 0.5,
    rebalanceCount: TOTAL_REBALANCES,
    swaps: [],
    equityCurve: [],
    warnings: [],
  }));
}

beforeEach(() => {
  storedDoc = null;
  writeOps.length = 0;
  mockProcessBatch.mockReset();
  mockFinalize.mockReset();
  mockInitialState.mockClear();
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({ status: 202 } as any);
});

afterAll(() => {
  (globalThis as any).fetch = originalFetch;
});

describe('checkpoint chain — 3 batches × 8 rebalances = 24 total', () => {
  it('first invocation initializes, processes batch 0, persists cursor, dispatches reinvoke', async () => {
    setupAdvancingHarness();
    const waitUntilSpy = vi.fn();
    const res = await invoke(makeEvent({ runId: 'pb-chain-x', window: 'full' }), {
      waitUntil: waitUntilSpy,
    });
    expect(res.statusCode).toBe(202);

    expect(mockInitialState).toHaveBeenCalledTimes(1);

    // Cursor was written with nextRebalanceIndex = 8.
    const stored = storedDoc as any;
    expect(stored.cursor.nextRebalanceIndex).toBe(8);
    expect(stored.cursor.invocationCount).toBe(1);
    expect(stored.status).toBe('running');

    // Reinvoke fired via context.waitUntil.
    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('second invocation reads cursor, advances to nextRebalanceIndex=16, dispatches reinvoke', async () => {
    setupAdvancingHarness();
    // First batch
    await invoke(makeEvent({ runId: 'pb-chain-x', window: 'full' }), { waitUntil: vi.fn() });
    writeOps.length = 0;
    fetchSpy.mockClear();
    // Second batch — same doc, same handler
    const waitUntilSpy = vi.fn();
    const res = await invoke(makeEvent({ runId: 'pb-chain-x', window: 'full' }), {
      waitUntil: waitUntilSpy,
    });
    expect(res.statusCode).toBe(202);

    const stored = storedDoc as any;
    expect(stored.cursor.nextRebalanceIndex).toBe(16);
    expect(stored.cursor.invocationCount).toBe(2);
    // initialPortfolioState should NOT have been called a 2nd time.
    expect(mockInitialState).toHaveBeenCalledTimes(1);

    // Reinvoke fired again.
    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('terminal batch writes summary, detail subdoc, clears cursor', async () => {
    setupAdvancingHarness();
    await invoke(makeEvent({ runId: 'pb-chain-x', window: 'full' }), { waitUntil: vi.fn() });
    await invoke(makeEvent({ runId: 'pb-chain-x', window: 'full' }), { waitUntil: vi.fn() });
    writeOps.length = 0;
    fetchSpy.mockClear();
    // Third batch — should be terminal
    const res = await invoke(makeEvent({ runId: 'pb-chain-x', window: 'full' }));
    expect(res.statusCode).toBe(200);

    const stored = storedDoc as any;
    expect(stored.status).toBe('done');
    expect(stored.cursor).toBeNull();
    expect(stored.invocationCount).toBe(3);

    // detail/full was written.
    const detail = writeOps.find((w) => w.sub === 'detail' && w.subDoc === 'full');
    expect(detail).toBeDefined();

    // No reinvoke on terminal batch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('full chain produces the expected final invocationCount and rebalances processed', async () => {
    setupAdvancingHarness();
    const results: number[] = [];
    let safety = 0;
    while (storedDoc == null || (storedDoc as any).status !== 'done') {
      const res = await invoke(makeEvent({ runId: 'pb-chain-y', window: 'full' }), {
        waitUntil: vi.fn(),
      });
      results.push(res.statusCode);
      if (safety++ > 10) throw new Error('chain did not terminate');
    }
    expect(results).toEqual([202, 202, 200]);
    expect((storedDoc as any).cursor).toBeNull();
    expect((storedDoc as any).invocationCount).toBe(3);
  });
});

describe('checkpoint chain — race protection', () => {
  it('a second invocation reading the same cursor skips already-processed work', async () => {
    setupAdvancingHarness();
    // First invocation completes batch 0.
    await invoke(makeEvent({ runId: 'pb-race-x', window: 'full' }), { waitUntil: vi.fn() });
    // Race: a duplicate dispatch lands BEFORE the next legitimate one.
    // It will read the cursor at nextRebalanceIndex=8 and resume from
    // there, NOT re-process batch 0.
    const stateBefore = JSON.parse(JSON.stringify(storedDoc));
    expect((stateBefore as any).cursor.nextRebalanceIndex).toBe(8);
    await invoke(makeEvent({ runId: 'pb-race-x', window: 'full' }), { waitUntil: vi.fn() });
    expect((storedDoc as any).cursor.nextRebalanceIndex).toBe(16);
    // Phase 4u — swaps live in a subcollection now; the cursor only
    // carries the count. After two batches of 8 rebalances we've
    // appended 16 swap rows total.
    expect((storedDoc as any).cursor.state.swapRowCount).toBe(16);
  });
});
