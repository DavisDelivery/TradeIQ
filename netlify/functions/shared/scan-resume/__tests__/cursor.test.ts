// Phase 4h W1 — scan cursor contract tests.
//
// Hermetic — a tiny mock Firestore wraps a single docDb so the cursor
// read/write/clear path can be pinned without touching real Firestore.

import { describe, it, expect } from 'vitest';
import {
  readScanCursor,
  writeScanCursor,
  clearScanCursor,
  appendPartialBatch,
  readAllPartialBatches,
  deletePartialBatches,
  type ScanCursor,
} from '../cursor';

type DocPath = string; // "collection/doc" or "collection/doc/sub/subdoc"

function makeMockDb(initial: Record<DocPath, unknown> = {}) {
  const store: Record<DocPath, any> = { ...initial };
  const writes: Array<{ path: DocPath; payload: any; merge: boolean }> = [];
  const deletes: DocPath[] = [];

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
        deletes.push(path);
        delete store[path];
      },
      collection: (sub: string) => collection(`${path}/${sub}`),
    };
  }

  function collection(prefix: string) {
    return {
      doc: (id: string) => doc(`${prefix}/${id}`),
      orderBy: () => ({
        get: async () => {
          const docs = Object.keys(store)
            .filter((p) => p.startsWith(`${prefix}/`) && p.split('/').length === prefix.split('/').length + 1)
            .sort()
            .map((p) => ({ id: p.split('/').slice(-1)[0], data: () => store[p], ref: { path: p } }));
          return { empty: docs.length === 0, docs, size: docs.length };
        },
      }),
      get: async () => {
        const docs = Object.keys(store)
          .filter((p) => p.startsWith(`${prefix}/`) && p.split('/').length === prefix.split('/').length + 1)
          .map((p) => ({ id: p.split('/').slice(-1)[0], data: () => store[p], ref: { path: p } }));
        return { empty: docs.length === 0, docs, size: docs.length };
      },
    };
  }

  const db = {
    collection: (cn: string) => collection(cn),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        delete: (ref: { path: string }) => {
          ops.push(() => {
            deletes.push(ref.path);
            delete store[ref.path];
          });
        },
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
  };

  return { db: db as any, store, writes, deletes };
}

const baseCursor: ScanCursor = {
  universe: 'russell2k',
  board: 'target-board',
  status: 'running',
  nextTickerIndex: 0,
  totalTickers: 2000,
  invocationCount: 1,
  startedAt: '2026-05-17T23:00:00.000Z',
  lastInvocationStartedAt: '2026-05-17T23:00:00.000Z',
  partialBatchCount: 0,
  scoredCount: 0,
};

describe('readScanCursor', () => {
  it('returns null when doc does not exist', async () => {
    const { db } = makeMockDb();
    expect(await readScanCursor(db, 'run-x')).toBeNull();
  });

  it('returns null when doc exists but has no cursor field', async () => {
    const { db } = makeMockDb({ 'scanRuns/run-x': { runId: 'run-x' } });
    expect(await readScanCursor(db, 'run-x')).toBeNull();
  });

  it('returns null when cursor field is null (terminal write)', async () => {
    const { db } = makeMockDb({ 'scanRuns/run-x': { cursor: null, status: 'done' } });
    expect(await readScanCursor(db, 'run-x')).toBeNull();
  });

  it('returns the parsed cursor when present', async () => {
    const { db } = makeMockDb({ 'scanRuns/run-x': { cursor: baseCursor } });
    expect(await readScanCursor(db, 'run-x')).toEqual(baseCursor);
  });
});

describe('writeScanCursor', () => {
  it('merge-writes cursor onto the run doc, preserving other fields', async () => {
    const { db, store } = makeMockDb({
      'scanRuns/run-x': { otherField: 'preserved' },
    });
    await writeScanCursor(db, 'run-x', baseCursor);
    expect(store['scanRuns/run-x']).toEqual(
      expect.objectContaining({ otherField: 'preserved', cursor: baseCursor }),
    );
    expect(store['scanRuns/run-x'].updatedAt).toBeTypeOf('string');
  });

  it('round-trips: write then read', async () => {
    const { db } = makeMockDb();
    await writeScanCursor(db, 'run-x', baseCursor);
    expect(await readScanCursor(db, 'run-x')).toEqual(baseCursor);
  });

  it('advances cursor across batches', async () => {
    const { db } = makeMockDb();
    await writeScanCursor(db, 'run-x', baseCursor);
    const next = { ...baseCursor, nextTickerIndex: 50, scoredCount: 47, partialBatchCount: 1 };
    await writeScanCursor(db, 'run-x', next);
    expect(await readScanCursor(db, 'run-x')).toEqual(next);
  });
});

describe('clearScanCursor', () => {
  it('nulls the cursor and stamps the terminal status', async () => {
    const { db, store } = makeMockDb({
      'scanRuns/run-x': { cursor: baseCursor, status: 'running' },
    });
    await clearScanCursor(db, 'run-x', 'done');
    expect(store['scanRuns/run-x'].cursor).toBeNull();
    expect(store['scanRuns/run-x'].status).toBe('done');
    expect(await readScanCursor(db, 'run-x')).toBeNull();
  });

  it('uses default status "done" when none provided', async () => {
    const { db, store } = makeMockDb({ 'scanRuns/run-x': { cursor: baseCursor } });
    await clearScanCursor(db, 'run-x');
    expect(store['scanRuns/run-x'].status).toBe('done');
  });
});

describe('appendPartialBatch + readAllPartialBatches', () => {
  it('writes nothing when rows is empty', async () => {
    const { db, store } = makeMockDb();
    await appendPartialBatch(db, 'run-x', 0, []);
    expect(Object.keys(store)).toHaveLength(0);
  });

  it('writes a zero-padded batch doc and round-trips via readAll', async () => {
    const { db } = makeMockDb();
    await appendPartialBatch(db, 'run-x', 0, [{ ticker: 'AAA', composite: 80 }]);
    await appendPartialBatch(db, 'run-x', 1, [{ ticker: 'BBB', composite: 70 }]);
    const all = await readAllPartialBatches<{ ticker: string; composite: number }>(db, 'run-x');
    expect(all).toEqual([
      { ticker: 'AAA', composite: 80 },
      { ticker: 'BBB', composite: 70 },
    ]);
  });

  it('preserves batch ordering by batchIndex (lexicographic via zero-pad)', async () => {
    const { db } = makeMockDb();
    // Write out of order to confirm the orderBy('batchIndex') sort.
    await appendPartialBatch(db, 'run-x', 2, [{ ticker: 'C' }]);
    await appendPartialBatch(db, 'run-x', 0, [{ ticker: 'A' }]);
    await appendPartialBatch(db, 'run-x', 1, [{ ticker: 'B' }]);
    const all = await readAllPartialBatches<{ ticker: string }>(db, 'run-x');
    expect(all.map((r) => r.ticker)).toEqual(['A', 'B', 'C']);
  });
});

describe('deletePartialBatches', () => {
  it('deletes every partial doc and returns the count', async () => {
    const { db, store } = makeMockDb();
    await appendPartialBatch(db, 'run-x', 0, [{ t: 'A' }]);
    await appendPartialBatch(db, 'run-x', 1, [{ t: 'B' }]);
    await appendPartialBatch(db, 'run-x', 2, [{ t: 'C' }]);
    const { deleted } = await deletePartialBatches(db, 'run-x');
    expect(deleted).toBe(3);
    const remaining = Object.keys(store).filter((p) => p.includes('/partial/'));
    expect(remaining).toEqual([]);
  });

  it('returns 0 when no partial docs exist', async () => {
    const { db } = makeMockDb();
    const { deleted } = await deletePartialBatches(db, 'run-x');
    expect(deleted).toBe(0);
  });
});
