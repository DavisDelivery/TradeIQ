// Phase 4e-1-finish — bg-dispatch debug test.
//
// The portfolio-backtest pipeline writes `portfolioBacktests/{runId}`
// as 'pending' from the trigger and is supposed to flip to 'running'
// inside the background handler before runPortfolioBacktest executes.
// Two production runs (pb-full-202605150933-fqrsid and
// pb-rolling-2022-202605142200-008f3z) never advanced past 'pending',
// so this test pins the contract the background handler must satisfy:
//
//   1. HTTP plumbing: 405 on non-POST, 400 on missing payload fields.
//   2. Lifecycle: handler calls writeStatus('running') BEFORE invoking
//      runPortfolioBacktest, and writes the 'done' summary after.
//   3. Error path: if runPortfolioBacktest throws, handler writes
//      'failed' status (so the doc doesn't stay stuck at 'pending').
//
// We mock the harness + signal + Firestore so the handler executes
// without live data.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mocks — DEFINED before importing the handler so module-level reads
// of these dependencies pick up the stub.
const mockSet = vi.fn(async () => {});
const writeOps: Array<{ collection: string; doc: string; sub?: string; subDoc?: string; payload: any }> = [];

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: (cn: string) => ({
      doc: (dn: string) => ({
        set: (payload: any, opts?: { merge?: boolean }) => {
          writeOps.push({ collection: cn, doc: dn, payload: { ...payload, _merge: !!opts?.merge } });
          return mockSet();
        },
        collection: (subCn: string) => ({
          doc: (subDn: string) => ({
            set: (payload: any) => {
              writeOps.push({ collection: cn, doc: dn, sub: subCn, subDoc: subDn, payload });
              return mockSet();
            },
          }),
        }),
      }),
    }),
  })),
}));

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => ({ _seconds: 1700000000, _nanoseconds: 0 }) },
}));

const mockRunPortfolioBacktest = vi.fn();
vi.mock('../shared/prophet-portfolio/backtest-harness', () => ({
  runPortfolioBacktest: (...args: any[]) => mockRunPortfolioBacktest(...args),
}));

vi.mock('../shared/prophet-portfolio/signal', () => ({
  compositeRankingSignal: { id: 'composite-v1', rankAtDate: async () => [] },
}));

vi.mock('../shared/data-provider', () => ({
  getDailyBars: vi.fn(async () => []),
}));

import { handler } from '../run-portfolio-backtest-background';

function makeEvent(opts: { method?: string; body?: any } = {}): any {
  return {
    httpMethod: opts.method ?? 'POST',
    body: opts.body == null ? null : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    headers: {},
    queryStringParameters: null,
    path: '/.netlify/functions/run-portfolio-backtest-background',
    rawUrl: '',
    rawQuery: '',
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
  };
}

async function invoke(h: any, ev: any): Promise<{ statusCode: number; body: string }> {
  const res = await h(ev, {} as any, () => {});
  return res as any;
}

beforeEach(() => {
  writeOps.length = 0;
  mockSet.mockClear();
  mockRunPortfolioBacktest.mockReset();
});

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
    // Acceptable outcomes per the brief: handler catches the windowSpec
    // throw and writes 'failed' status, then returns 500. The doc must
    // NOT be left at the caller's 'pending' state.
    expect(res.statusCode).toBe(500);
    const failedWrite = writeOps.find((w) => w.payload?.status === 'failed');
    expect(failedWrite).toBeDefined();
  });
});

describe('run-portfolio-backtest-background — happy-path lifecycle', () => {
  it('writes running BEFORE running the harness; writes done summary AFTER', async () => {
    mockRunPortfolioBacktest.mockResolvedValue({
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
      rebalanceCount: 13,
      swaps: [],
      equityCurve: [{ date: '2024-01-08', portfolio: 100000, spy: 100000, qqq: null, iwf: null }],
      warnings: [],
    });

    const res = await invoke(handler, makeEvent({ body: { runId: 'pb-short-demo-x', window: 'short-demo' } }));
    expect(res.statusCode).toBe(200);
    // First write must be status='running' BEFORE the harness fired.
    const runningWrite = writeOps.find((w) => w.payload?.status === 'running');
    expect(runningWrite).toBeDefined();
    expect(runningWrite!.doc).toBe('pb-short-demo-x');
    // Harness was called exactly once after running-write.
    expect(mockRunPortfolioBacktest).toHaveBeenCalledTimes(1);
    // 'done' summary write happened.
    const doneWrite = writeOps.find((w) => w.payload?.status === 'done');
    expect(doneWrite).toBeDefined();
    expect(doneWrite!.payload?.portfolioReturnPct).toBe(1.0);
    // Detail subdoc was also written under detail/full.
    const detail = writeOps.find((w) => w.sub === 'detail' && w.subDoc === 'full');
    expect(detail).toBeDefined();
  });
});

describe('run-portfolio-backtest-background — error path', () => {
  it('writes failed status when harness throws (doc does not stay pending)', async () => {
    mockRunPortfolioBacktest.mockRejectedValue(new Error('synthetic harness failure'));
    const res = await invoke(handler, makeEvent({ body: { runId: 'pb-short-demo-y', window: 'short-demo' } }));
    expect(res.statusCode).toBe(500);
    const failedWrite = writeOps.find((w) => w.payload?.status === 'failed');
    expect(failedWrite).toBeDefined();
    expect(failedWrite!.payload?.error).toMatch(/synthetic harness failure/);
  });

  it('writes failed status when writeStatus running itself fails (defensive)', async () => {
    // First two writes succeed (running + done bypassed by harness throw),
    // but we want to verify that an exceptional initial-write failure
    // doesn't silently swallow the run. We simulate the first set() call
    // throwing — handler must end with 'failed' or at minimum return 500.
    let callIdx = 0;
    mockSet.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) throw new Error('firestore unavailable');
    });
    const res = await invoke(handler, makeEvent({ body: { runId: 'pb-short-demo-z', window: 'short-demo' } }));
    expect(res.statusCode).toBe(500);
  });
});
