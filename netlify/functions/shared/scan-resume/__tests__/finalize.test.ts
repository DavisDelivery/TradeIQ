// Phase 4p — finalize.ts: shared helpers for the dedicated terminal
// reinvocation (W1) and stuck-run recovery (W3).
//
// Hermetic: in-memory Firestore mock + a stubbed dispatchReinvoke so we
// can verify both the pure transition + the persist-then-dispatch order
// without touching real services.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchReinvoke: vi.fn(),
}));

vi.mock('../../backtest-resume/reinvoke', async () => {
  const actual = await vi.importActual<any>('../../backtest-resume/reinvoke');
  return {
    ...actual,
    dispatchReinvoke: mocks.dispatchReinvoke,
  };
});

import {
  transitionCursorToFinalizing,
  dispatchFinalizingReinvoke,
  recoverStuckRuns,
  STALE_RUN_THRESHOLD_MS,
} from '../finalize';
import { writeScanCursor, type ScanCursor } from '../cursor';

type DocPath = string;

function makeMockDb(initial: Record<DocPath, unknown> = {}) {
  const store: Record<DocPath, any> = { ...initial };
  const writes: Array<{ path: DocPath; payload: any; merge: boolean }> = [];

  function doc(path: DocPath) {
    return {
      ref: { path },
      id: path.split('/').slice(-1)[0],
      get: async () => ({
        exists: store[path] !== undefined,
        data: () => store[path],
      }),
      set: async (payload: any, opts?: { merge?: boolean }) => {
        writes.push({ path, payload, merge: !!opts?.merge });
        if (opts?.merge) store[path] = { ...(store[path] ?? {}), ...payload };
        else store[path] = payload;
      },
      delete: async () => {
        delete store[path];
      },
      collection: (sub: string) => collection(`${path}/${sub}`),
    };
  }

  function collection(prefix: string) {
    return {
      doc: (id: string) => doc(`${prefix}/${id}`),
      orderBy: (_field: string, _dir?: string) => ({
        startAt: (_v: string) => ({
          endAt: (lower: string) => ({
            limit: (n: number) => ({
              get: async () => {
                const docs = Object.keys(store)
                  .filter((p) => p.startsWith(`${prefix}/`))
                  .filter((p) => {
                    const id = p.slice(`${prefix}/`.length);
                    return id.startsWith(lower);
                  })
                  .sort()
                  .reverse()
                  .slice(0, n)
                  .map((p) => ({
                    id: p.slice(`${prefix}/`.length),
                    data: () => store[p],
                    ref: { path: p },
                  }));
                return { docs };
              },
            }),
          }),
        }),
      }),
    };
  }

  return {
    db: { collection: (cn: string) => collection(cn) } as any,
    store,
    writes,
  };
}

const baseCursor: ScanCursor = {
  universe: 'russell2k',
  board: 'target-board',
  status: 'running',
  phase: 'scanning',
  nextTickerIndex: 2037,
  totalTickers: 2037,
  invocationCount: 3,
  startedAt: '2026-05-18T08:52:00.000Z',
  lastInvocationStartedAt: '2026-05-18T09:19:46.000Z',
  partialBatchCount: 41,
  scoredCount: 2022,
};

beforeEach(() => {
  mocks.dispatchReinvoke.mockReset();
  mocks.dispatchReinvoke.mockResolvedValue({ ok: true });
});

describe('transitionCursorToFinalizing (Phase 4p W1)', () => {
  it("stamps phase: 'finalizing' and bumps the reinvoke-attempt counters", () => {
    const out = transitionCursorToFinalizing(baseCursor);
    expect(out.phase).toBe('finalizing');
    expect(out.reinvokeAttempts).toBe(1);
    expect(out.lastReinvokeAt).toBeTypeOf('string');
    // Pure — original cursor is untouched.
    expect(baseCursor.phase).toBe('scanning');
    expect(baseCursor.reinvokeAttempts).toBeUndefined();
  });

  it('preserves existing reinvokeAttempts (mid-walk watchdog reinvokes already happened)', () => {
    const out = transitionCursorToFinalizing({ ...baseCursor, reinvokeAttempts: 2 });
    expect(out.reinvokeAttempts).toBe(3);
  });

  it('preserves all other cursor fields', () => {
    const out = transitionCursorToFinalizing(baseCursor);
    expect(out.nextTickerIndex).toBe(2037);
    expect(out.scoredCount).toBe(2022);
    expect(out.partialBatchCount).toBe(41);
    expect(out.invocationCount).toBe(3);
  });
});

describe('dispatchFinalizingReinvoke (Phase 4p W1)', () => {
  it('persists the finalizing cursor BEFORE dispatching the reinvoke', async () => {
    const { db, store } = makeMockDb();
    await writeScanCursor(db, 'run-x', baseCursor);
    // Track the order of events: cursor write must land before
    // dispatchReinvoke is called.
    const calls: string[] = [];
    mocks.dispatchReinvoke.mockImplementation(async () => {
      calls.push(`dispatch:phase=${store['scanRuns/run-x']?.cursor?.phase}`);
      return { ok: true };
    });

    const { cursor, dispatched } = await dispatchFinalizingReinvoke({
      db,
      runId: 'run-x',
      cursor: baseCursor,
      reinvokeUrl: 'https://example/.netlify/functions/scan-target-board-russell2k-background',
      ctx: { waitUntil: vi.fn() },
    });

    expect(dispatched.ok).toBe(true);
    expect(cursor.phase).toBe('finalizing');
    expect(store['scanRuns/run-x'].cursor.phase).toBe('finalizing');
    expect(calls[0]).toBe('dispatch:phase=finalizing');
  });

  it('stamps lastReinvokeError when the dispatch fetch fails', async () => {
    const { db, store } = makeMockDb();
    await writeScanCursor(db, 'run-x', baseCursor);
    mocks.dispatchReinvoke.mockResolvedValue({ ok: false, error: 'fetch_failed' });

    const { cursor, dispatched } = await dispatchFinalizingReinvoke({
      db,
      runId: 'run-x',
      cursor: baseCursor,
      reinvokeUrl: 'https://example/.netlify/functions/scan-target-board-russell2k-background',
      ctx: { waitUntil: vi.fn() },
    });

    expect(dispatched.ok).toBe(false);
    expect(cursor.lastReinvokeError).toBe('fetch_failed');
    expect(store['scanRuns/run-x'].cursor.lastReinvokeError).toBe('fetch_failed');
    // Phase is still finalizing — the failure doesn't roll it back; a
    // future invocation (manually re-fired or via the W3 stuck-run
    // sweep) can still pick up the terminal step.
    expect(cursor.phase).toBe('finalizing');
  });
});

describe('STALE_RUN_THRESHOLD_MS (Phase 4p W3)', () => {
  it('is longer than the Netlify 15-min background ceiling', () => {
    expect(STALE_RUN_THRESHOLD_MS).toBeGreaterThan(15 * 60_000);
  });
});

describe('recoverStuckRuns (Phase 4p W3)', () => {
  it('returns empty when nothing matches the prefix', async () => {
    const { db } = makeMockDb();
    const out = await recoverStuckRuns({
      db,
      runIdPrefix: 'target-board-russell2k-',
    });
    expect(out.recovered).toEqual([]);
    expect(out.inspected).toBe(0);
  });

  it("ignores runs whose status is not 'running' (already complete / already errored)", async () => {
    const { db } = makeMockDb({
      'scanRuns/target-board-russell2k-20260517-100000': {
        status: 'done',
        updatedAt: '2026-05-17T10:00:00.000Z',
        cursor: null,
      },
      'scanRuns/target-board-russell2k-20260517-110000': {
        status: 'error',
        updatedAt: '2026-05-17T11:00:00.000Z',
        cursor: null,
      },
    });
    const out = await recoverStuckRuns({
      db,
      runIdPrefix: 'target-board-russell2k-',
      now: Date.parse('2026-05-18T10:00:00.000Z'),
    });
    expect(out.recovered).toEqual([]);
    expect(out.inspected).toBe(2);
  });

  it('ignores fresh running runs (within the threshold)', async () => {
    const { db } = makeMockDb({
      'scanRuns/target-board-russell2k-20260518-090000': {
        status: 'running',
        updatedAt: '2026-05-18T09:55:00.000Z', // 5 min ago
        cursor: { ...baseCursor, phase: 'scanning' },
      },
    });
    const out = await recoverStuckRuns({
      db,
      runIdPrefix: 'target-board-russell2k-',
      now: Date.parse('2026-05-18T10:00:00.000Z'),
    });
    expect(out.recovered).toEqual([]);
  });

  it('marks a stale running run as error and clears its cursor (the Bug B zombie)', async () => {
    const { db, store } = makeMockDb({
      'scanRuns/target-board-russell2k-20260517-231327': {
        status: 'running',
        updatedAt: '2026-05-17T23:14:00.000Z', // 10+ hours ago
        cursor: { ...baseCursor, phase: 'scanning' },
      },
    });
    const out = await recoverStuckRuns({
      db,
      runIdPrefix: 'target-board-russell2k-',
      now: Date.parse('2026-05-18T10:00:00.000Z'),
    });
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0].runId).toBe('target-board-russell2k-20260517-231327');
    expect(out.recovered[0].reason).toMatch(/stale running/);

    const doc = store['scanRuns/target-board-russell2k-20260517-231327'];
    expect(doc.cursor).toBeNull();
    expect(doc.status).toBe('error');
  });

  it('records the phase of recovered runs so post-mortem distinguishes finalizing zombies', async () => {
    const { db } = makeMockDb({
      'scanRuns/target-board-russell2k-20260518-085232': {
        status: 'running',
        updatedAt: '2026-05-18T09:28:36.000Z', // matches the brief's frozen run
        cursor: {
          ...baseCursor,
          phase: 'finalizing',
          nextTickerIndex: 2037,
          totalTickers: 2037,
        },
      },
    });
    const out = await recoverStuckRuns({
      db,
      runIdPrefix: 'target-board-russell2k-',
      now: Date.parse('2026-05-18T10:00:00.000Z'),
    });
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0].phase).toBe('finalizing');
  });

  it('honors a custom threshold (so tests can pin the boundary)', async () => {
    const { db } = makeMockDb({
      'scanRuns/insider-russell2k-20260518-090000': {
        status: 'running',
        updatedAt: '2026-05-18T09:50:00.000Z', // 10 min ago
        cursor: { ...baseCursor, board: 'insider' },
      },
    });
    // With a tight 5-min threshold the run IS stale.
    const out = await recoverStuckRuns({
      db,
      runIdPrefix: 'insider-russell2k-',
      now: Date.parse('2026-05-18T10:00:00.000Z'),
      staleThresholdMs: 5 * 60_000,
    });
    expect(out.recovered).toHaveLength(1);
  });
});
