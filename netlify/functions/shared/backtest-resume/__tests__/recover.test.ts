import { describe, it, expect, vi } from 'vitest';
import {
  recoverStuckBacktestRuns,
  STALE_RUN_THRESHOLD_MS,
  MAX_RECOVERY_ATTEMPTS,
} from '../recover';
import type { BacktestCursor } from '../cursor';

// Lightweight in-memory Firestore shim covering only the operations the
// recovery sweep uses: `.collection(c).orderBy(f,'desc').limit(n).get()`
// and `.collection(c).doc(id).set(patch, {merge: true})`.
//
// Recorded mutations live on `writes` so tests can assert the patches.
type Doc = { id: string; data: Record<string, unknown> };
interface FakeDbState {
  collection: string;
  docs: Doc[];
  writes: Array<{ collection: string; docId: string; patch: Record<string, unknown>; merge: boolean }>;
}

function makeFakeDb(initial: { collection: string; docs: Doc[] }): {
  db: any;
  state: FakeDbState;
} {
  const state: FakeDbState = {
    collection: initial.collection,
    docs: [...initial.docs],
    writes: [],
  };
  const collectionApi = (name: string) => {
    if (name !== state.collection) {
      throw new Error(`unexpected collection: ${name}`);
    }
    return {
      orderBy: (_field: string, _dir: string) => ({
        limit: (_n: number) => ({
          get: async () => ({
            docs: state.docs.map((d) => ({
              id: d.id,
              data: () => d.data,
            })),
          }),
        }),
      }),
      doc: (docId: string) => ({
        set: async (patch: Record<string, unknown>, opts?: { merge?: boolean }) => {
          state.writes.push({
            collection: name,
            docId,
            patch,
            merge: !!opts?.merge,
          });
          // Mutate the in-memory doc so subsequent reads see the change.
          const doc = state.docs.find((d) => d.id === docId);
          if (doc) {
            for (const [k, v] of Object.entries(patch)) {
              if (k === 'cursor' && v && typeof v === 'object') {
                // Shallow-merge cursor.
                doc.data.cursor = { ...(doc.data.cursor as object ?? {}), ...v };
              } else {
                doc.data[k] = v;
              }
            }
          }
        },
      }),
    };
  };
  const db: any = {
    collection: collectionApi,
  };
  return { db, state };
}

const COLLECTION = 'portfolioBacktests';
const ORIGIN = 'https://example.test';
const FN_PATH = '/.netlify/functions/run-portfolio-backtest-background';

function staleRunningDoc(id: string, idleMs: number, overrides: Partial<BacktestCursor<unknown>> & { window?: string } = {}): Doc {
  const { window = 'rolling-2024', ...cursorOverrides } = overrides;
  const lastInvAt = new Date(Date.now() - idleMs).toISOString();
  return {
    id,
    data: {
      window,
      status: 'running',
      startedAt: new Date(Date.now() - idleMs - 60_000).toISOString(),
      cursor: {
        nextRebalanceIndex: 5,
        totalRebalances: 12,
        lastInvocationStartedAt: lastInvAt,
        invocationCount: 2,
        state: { foo: 'bar' },
        cumulativeMetrics: { tradeCount: 3, mlTrainingCount: 0 },
        ...cursorOverrides,
      },
    },
  };
}

describe('recoverStuckBacktestRuns', () => {
  it('resumes a stuck running run by re-dispatching the reinvoke', async () => {
    const { db, state } = makeFakeDb({
      collection: COLLECTION,
      docs: [staleRunningDoc('pb-stuck-1', 35 * 60_000)],
    });
    const dispatch = vi.fn().mockResolvedValue({ ok: true, attempts: 1, lastStatus: 202 });

    const result = await recoverStuckBacktestRuns({
      db, collection: COLLECTION, origin: ORIGIN, functionPath: FN_PATH, dispatch,
    });

    expect(result.inspected).toBe(1);
    expect(result.resumed).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.resumed[0]).toMatchObject({
      runId: 'pb-stuck-1',
      window: 'rolling-2024',
      action: 'resumed',
      recoveryAttempts: 1,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [url, runId, _ctx, extra] = dispatch.mock.calls[0];
    expect(url).toBe(`${ORIGIN}${FN_PATH}`);
    expect(runId).toBe('pb-stuck-1');
    expect(extra).toEqual({ window: 'rolling-2024' });
    // recoveryAttempts written to cursor
    const cursorWrite = state.writes.find((w) => w.docId === 'pb-stuck-1' && 'cursor' in w.patch);
    expect(cursorWrite).toBeDefined();
    expect((cursorWrite!.patch.cursor as any).recoveryAttempts).toBe(1);
  });

  it('skips a recently-active running run (below stale threshold)', async () => {
    const { db, state } = makeFakeDb({
      collection: COLLECTION,
      docs: [staleRunningDoc('pb-fresh', 5 * 60_000)], // 5 min idle, well under 30 min
    });
    const dispatch = vi.fn().mockResolvedValue({ ok: true, attempts: 1, lastStatus: 202 });

    const result = await recoverStuckBacktestRuns({
      db, collection: COLLECTION, origin: ORIGIN, functionPath: FN_PATH, dispatch,
    });

    expect(result.inspected).toBe(1);
    expect(result.resumed).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(0);
  });

  it('ignores non-running statuses (done, pending, failed)', async () => {
    const docs: Doc[] = [
      { ...staleRunningDoc('pb-done', 60 * 60_000), data: { ...staleRunningDoc('pb-done', 60 * 60_000).data, status: 'done' } },
      { ...staleRunningDoc('pb-pending', 60 * 60_000), data: { ...staleRunningDoc('pb-pending', 60 * 60_000).data, status: 'pending' } },
      { ...staleRunningDoc('pb-failed', 60 * 60_000), data: { ...staleRunningDoc('pb-failed', 60 * 60_000).data, status: 'failed' } },
    ];
    const { db } = makeFakeDb({ collection: COLLECTION, docs });
    const dispatch = vi.fn();

    const result = await recoverStuckBacktestRuns({
      db, collection: COLLECTION, origin: ORIGIN, functionPath: FN_PATH, dispatch,
    });

    expect(result.resumed).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('ignores running docs with no cursor (nothing to resume from)', async () => {
    const doc = staleRunningDoc('pb-no-cursor', 60 * 60_000);
    doc.data.cursor = null;
    const { db } = makeFakeDb({ collection: COLLECTION, docs: [doc] });
    const dispatch = vi.fn();

    const result = await recoverStuckBacktestRuns({
      db, collection: COLLECTION, origin: ORIGIN, functionPath: FN_PATH, dispatch,
    });

    expect(result.resumed).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails a run when recovery attempts have reached the cap', async () => {
    const stuck = staleRunningDoc('pb-doomed', 60 * 60_000, {
      recoveryAttempts: MAX_RECOVERY_ATTEMPTS,
    });
    const { db, state } = makeFakeDb({ collection: COLLECTION, docs: [stuck] });
    const dispatch = vi.fn();

    const result = await recoverStuckBacktestRuns({
      db, collection: COLLECTION, origin: ORIGIN, functionPath: FN_PATH, dispatch,
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      runId: 'pb-doomed',
      action: 'failed',
      recoveryAttempts: MAX_RECOVERY_ATTEMPTS,
    });
    expect(dispatch).not.toHaveBeenCalled();
    // Doc was patched to status: failed + cursor cleared.
    const fail = state.writes.find((w) => (w.patch as any).status === 'failed');
    expect(fail).toBeDefined();
    expect((fail!.patch as any).cursor).toBeNull();
  });

  it('records a skipped run when the resume dispatch itself fails', async () => {
    const { db, state } = makeFakeDb({
      collection: COLLECTION,
      docs: [staleRunningDoc('pb-throttle', 35 * 60_000)],
    });
    const dispatch = vi.fn().mockResolvedValue({
      ok: false, attempts: 4, lastStatus: 429, error: 'HTTP 429',
    });

    const result = await recoverStuckBacktestRuns({
      db, collection: COLLECTION, origin: ORIGIN, functionPath: FN_PATH, dispatch,
    });

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      runId: 'pb-throttle',
      action: 'skipped',
      dispatchOk: false,
      dispatchError: 'HTTP 429',
    });
    // recoveryAttempts still incremented so the cap eventually trips.
    const cursorWrites = state.writes.filter((w) => 'cursor' in w.patch);
    const lastCursor = cursorWrites[cursorWrites.length - 1].patch.cursor as any;
    expect(lastCursor.recoveryAttempts).toBe(1);
    expect(lastCursor.lastReinvokeError).toBe('HTTP 429');
  });

  it('handles a mixed batch (one resume, one fail-by-cap, one skip-fresh)', async () => {
    const docs: Doc[] = [
      staleRunningDoc('pb-resume', 40 * 60_000, { window: 'rolling-2020' }),
      staleRunningDoc('pb-cap', 60 * 60_000, {
        window: 'rolling-2021',
        recoveryAttempts: MAX_RECOVERY_ATTEMPTS,
      }),
      staleRunningDoc('pb-fresh', 2 * 60_000, { window: 'rolling-2022' }),
    ];
    const { db } = makeFakeDb({ collection: COLLECTION, docs });
    const dispatch = vi.fn().mockResolvedValue({ ok: true, attempts: 1, lastStatus: 202 });

    const result = await recoverStuckBacktestRuns({
      db, collection: COLLECTION, origin: ORIGIN, functionPath: FN_PATH, dispatch,
    });

    expect(result.inspected).toBe(3);
    expect(result.resumed.map((r) => r.runId)).toEqual(['pb-resume']);
    expect(result.failed.map((r) => r.runId)).toEqual(['pb-cap']);
    expect(result.skipped).toHaveLength(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('respects an injected `now` for the staleness check', async () => {
    const fixedNow = Date.now();
    const docs: Doc[] = [
      // 20 min ago by real clock — but if `now` is set 50 min in the
      // future, the doc looks 70 min stale.
      staleRunningDoc('pb-future-stale', 20 * 60_000),
    ];
    const { db } = makeFakeDb({ collection: COLLECTION, docs });
    const dispatch = vi.fn().mockResolvedValue({ ok: true, attempts: 1, lastStatus: 202 });

    const result = await recoverStuckBacktestRuns({
      db, collection: COLLECTION, origin: ORIGIN, functionPath: FN_PATH, dispatch,
      now: fixedNow + 50 * 60_000,
    });
    expect(result.resumed).toHaveLength(1);
  });

  it('respects a custom staleThresholdMs override', async () => {
    const docs: Doc[] = [staleRunningDoc('pb-only-10min', 10 * 60_000)];
    const { db } = makeFakeDb({ collection: COLLECTION, docs });
    const dispatch = vi.fn().mockResolvedValue({ ok: true, attempts: 1, lastStatus: 202 });

    // Default 30 min would skip; 5 min override picks it up.
    const result = await recoverStuckBacktestRuns({
      db, collection: COLLECTION, origin: ORIGIN, functionPath: FN_PATH, dispatch,
      staleThresholdMs: 5 * 60_000,
    });
    expect(result.resumed).toHaveLength(1);
  });

  it('exports a 30-minute default threshold and a 3-attempt default cap', () => {
    expect(STALE_RUN_THRESHOLD_MS).toBe(30 * 60_000);
    expect(MAX_RECOVERY_ATTEMPTS).toBe(3);
  });
});
