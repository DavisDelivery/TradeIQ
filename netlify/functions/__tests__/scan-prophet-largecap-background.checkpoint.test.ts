// Prophet largecap checkpoint-resume worker.
//
// Guards the fix for a real prod outage (2026-07-28): the single-shot scan
// could not finish the ~508-name universe inside its 14-min budget, stamped
// every run `partial`, and a partial never promotes — so `_latest` froze on
// 2026-07-23 and the board served 117h-stale data indefinitely. The chained
// worker must walk the universe across invocations and publish exactly ONE
// snapshot, with budgetExceeded false, from the terminal step.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  runProphetScan: vi.fn(),
  resolveUniverse: vi.fn(),
  publish: vi.fn(),
  readCursor: vi.fn(),
  writeCursor: vi.fn(),
  appendPartial: vi.fn(),
  readAllPartials: vi.fn(),
  deletePartials: vi.fn(),
  clearCursor: vi.fn(),
  dispatchReinvoke: vi.fn(),
  dispatchFinalizing: vi.fn(),
  createWatchdog: vi.fn(),
  runDoc: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => m.runDoc }) }),
}));
vi.mock('../shared/scan-prophet', () => ({
  runProphetScan: m.runProphetScan,
  resolveProphetUniverse: m.resolveUniverse,
}));
vi.mock('../shared/prophet-snapshot-runner', () => ({ publishProphetSnapshot: m.publish }));
vi.mock('../shared/scan-resume/cursor', () => ({
  readScanCursor: m.readCursor,
  writeScanCursor: m.writeCursor,
  appendPartialBatch: m.appendPartial,
  readAllPartialBatches: m.readAllPartials,
  deletePartialBatches: m.deletePartials,
  clearScanCursor: m.clearCursor,
  getCursorPhase: (c: any) => c?.phase ?? 'scanning',
}));
vi.mock('../shared/scan-resume/finalize', () => ({ dispatchFinalizingReinvoke: m.dispatchFinalizing }));
vi.mock('../shared/backtest-resume/watchdog', () => ({ createWatchdog: m.createWatchdog }));
vi.mock('../shared/backtest-resume/reinvoke', () => ({
  dispatchReinvoke: m.dispatchReinvoke,
  inferFunctionUrl: () => 'https://x/.netlify/functions/scan-prophet-largecap-background',
}));

import { handler } from '../scan-prophet-largecap-background';

const post = (body: any) => ({ httpMethod: 'POST', body: JSON.stringify(body), headers: {} }) as any;
const ctx = { waitUntil: vi.fn() } as any;

/** Watchdog that expires after N isExpired() checks. */
const fakeWatchdog = (expireAfter: number) => {
  let n = 0;
  return { start: vi.fn(), stop: vi.fn(), isExpired: () => ++n > expireAfter };
};

const universe = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ ticker: `T${String(i).padStart(3, '0')}`, sector: 'Tech' }));

beforeEach(() => {
  vi.clearAllMocks();
  m.resolveUniverse.mockReturnValue(universe(150));
  m.readCursor.mockResolvedValue(null);
  m.writeCursor.mockResolvedValue(undefined);
  m.appendPartial.mockResolvedValue(undefined);
  m.deletePartials.mockResolvedValue({ deleted: 0 });
  m.clearCursor.mockResolvedValue(undefined);
  m.runDoc.set.mockResolvedValue(undefined);
  m.runDoc.get.mockResolvedValue({ data: () => ({ prophetTickers: universe(150).map((t) => t.ticker) }) });
  m.createWatchdog.mockReturnValue(fakeWatchdog(100));
  m.dispatchReinvoke.mockResolvedValue({ ok: true });
  m.publish.mockResolvedValue({ snapshotId: 'largecap-x', promotedToLatest: true, status: 'complete' });
  m.runProphetScan.mockImplementation(async (o: any) => ({
    picks: o.explicitTickers.map((t: string) => ({ ticker: t, composite: 50 })),
    warnings: [],
    scanDurationMs: 10,
    universeChecked: o.explicitTickers.length,
    tickersScanned: o.explicitTickers.length,
    budgetExceeded: false,
    regime: null,
  }));
});

describe('prophet largecap — checkpoint chain', () => {
  it('rejects non-POST', async () => {
    const r: any = await handler({ httpMethod: 'GET' } as any, ctx, () => {});
    expect(r.statusCode).toBe(405);
  });

  it('pins the resolved universe on the run doc so resumes walk the same list', async () => {
    m.createWatchdog.mockReturnValue(fakeWatchdog(1));
    await handler(post({}), ctx, () => {});
    expect(m.runDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({ prophetTickers: expect.any(Array) }),
      { merge: true },
    );
  });

  it('mid-walk invocation checkpoints and reinvokes WITHOUT publishing', async () => {
    m.createWatchdog.mockReturnValue(fakeWatchdog(1)); // one batch then expire
    const r: any = await handler(post({}), ctx, () => {});
    expect(r.statusCode).toBe(202);
    expect(JSON.parse(r.body).continuing).toBe(true);
    expect(m.publish).not.toHaveBeenCalled(); // _latest must not move mid-scan
    expect(m.dispatchReinvoke).toHaveBeenCalledTimes(1);
  });

  it('completing the walk hands off to a dedicated finalizing invocation', async () => {
    m.dispatchFinalizing.mockResolvedValue({
      cursor: { invocationCount: 2 },
      dispatched: { ok: true },
    });
    const r: any = await handler(post({}), ctx, () => {});
    expect(JSON.parse(r.body).phase).toBe('finalizing');
    expect(m.publish).not.toHaveBeenCalled();
    expect(m.dispatchFinalizing).toHaveBeenCalledTimes(1);
  });

  it('terminal step publishes ONE complete snapshot with every pick, budgetExceeded FALSE', async () => {
    // This is the whole point of the port: the old single-shot path could only
    // ever report partial here, and a partial never promotes.
    m.readCursor.mockResolvedValue({
      universe: 'largecap', board: 'prophet', status: 'running', phase: 'finalizing',
      nextTickerIndex: 150, totalTickers: 150, invocationCount: 3,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      lastInvocationStartedAt: new Date().toISOString(),
      partialBatchCount: 3, scoredCount: 150, warnings: ['catalyst layer degraded'],
    });
    m.readAllPartials.mockResolvedValue([
      { ticker: 'A', composite: 40 },
      { ticker: 'B', composite: 90 },
      { ticker: 'C', composite: 70 },
    ]);

    const r: any = await handler(post({ runId: 'prophet-largecap-1', resume: true }), ctx, () => {});
    expect(r.statusCode).toBe(200);
    expect(m.publish).toHaveBeenCalledTimes(1);

    const arg = m.publish.mock.calls[0][0];
    expect(arg.budgetExceeded).toBe(false);
    expect(arg.storeKey).toBe('largecap');
    expect(arg.universeChecked).toBe(150);
    expect(arg.picks.map((p: any) => p.ticker)).toEqual(['B', 'C', 'A']); // composite desc
    expect(arg.warnings).toContain('catalyst layer degraded'); // survive the chain
    expect(m.clearCursor).toHaveBeenCalled();
    expect(m.deletePartials).toHaveBeenCalled();
  });

  it('a stale resume whose cursor was already cleared is a safe no-op', async () => {
    m.readCursor.mockResolvedValue(null);
    const r: any = await handler(post({ runId: 'gone', resume: true }), ctx, () => {});
    expect(r.statusCode).toBe(200);
    expect(m.publish).not.toHaveBeenCalled();
    expect(m.runProphetScan).not.toHaveBeenCalled();
  });
});
