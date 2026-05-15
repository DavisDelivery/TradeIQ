import { describe, it, expect, vi } from 'vitest';
import { readCursor, writeCursor, clearCursor, type BacktestCursor } from '../cursor';

// Hermetic — mock the Firestore admin SDK so the cursor module's
// read/write contracts are pinned without touching Firestore.

function makeMockDb(opts: {
  docData?: Record<string, unknown> | null;
  docExists?: boolean;
}): {
  db: any;
  setCalls: Array<{ collection: string; doc: string; payload: any; merge: boolean }>;
  getCalls: Array<{ collection: string; doc: string }>;
} {
  const { docData = null, docExists = true } = opts;
  const setCalls: Array<{ collection: string; doc: string; payload: any; merge: boolean }> = [];
  const getCalls: Array<{ collection: string; doc: string }> = [];
  const db = {
    collection: (cn: string) => ({
      doc: (dn: string) => ({
        get: async () => {
          getCalls.push({ collection: cn, doc: dn });
          return {
            exists: docExists,
            data: () => docData ?? undefined,
          };
        },
        set: async (payload: any, options?: { merge?: boolean }) => {
          setCalls.push({ collection: cn, doc: dn, payload, merge: !!options?.merge });
        },
      }),
    }),
  };
  return { db, setCalls, getCalls };
}

interface SampleState {
  cash: number;
  positions: string[];
}

const sampleCursor: BacktestCursor<SampleState> = {
  nextRebalanceIndex: 8,
  totalRebalances: 84,
  lastInvocationStartedAt: '2026-05-15T14:00:00.000Z',
  invocationCount: 2,
  state: { cash: 50_000, positions: ['AAPL', 'MSFT'] },
  cumulativeMetrics: { tradeCount: 16, mlTrainingCount: 80 },
};

describe('readCursor', () => {
  it('returns null when doc does not exist', async () => {
    const { db } = makeMockDb({ docExists: false });
    const cursor = await readCursor<SampleState>(db, 'portfolioBacktests', 'pb-x');
    expect(cursor).toBeNull();
  });

  it('returns null when doc exists but has no cursor field', async () => {
    const { db } = makeMockDb({ docData: { runId: 'pb-x', status: 'pending' } });
    const cursor = await readCursor<SampleState>(db, 'portfolioBacktests', 'pb-x');
    expect(cursor).toBeNull();
  });

  it('returns null when cursor field is explicitly null (terminal write)', async () => {
    const { db } = makeMockDb({ docData: { runId: 'pb-x', status: 'done', cursor: null } });
    const cursor = await readCursor<SampleState>(db, 'portfolioBacktests', 'pb-x');
    expect(cursor).toBeNull();
  });

  it('returns the parsed cursor when present', async () => {
    const { db, getCalls } = makeMockDb({
      docData: { runId: 'pb-x', status: 'running', cursor: sampleCursor },
    });
    const cursor = await readCursor<SampleState>(db, 'portfolioBacktests', 'pb-x');
    expect(cursor).toEqual(sampleCursor);
    expect(getCalls).toEqual([{ collection: 'portfolioBacktests', doc: 'pb-x' }]);
  });
});

describe('writeCursor', () => {
  it('merge-writes the cursor with an updatedAt stamp', async () => {
    const { db, setCalls } = makeMockDb({});
    await writeCursor(db, 'portfolioBacktests', 'pb-x', sampleCursor);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].collection).toBe('portfolioBacktests');
    expect(setCalls[0].doc).toBe('pb-x');
    expect(setCalls[0].merge).toBe(true);
    expect(setCalls[0].payload.cursor).toEqual(sampleCursor);
    expect(typeof setCalls[0].payload.updatedAt).toBe('string');
  });
});

describe('clearCursor', () => {
  it('merge-writes cursor: null on terminal flip', async () => {
    const { db, setCalls } = makeMockDb({});
    await clearCursor(db, 'backtestRuns', 'bt_xyz');
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].collection).toBe('backtestRuns');
    expect(setCalls[0].doc).toBe('bt_xyz');
    expect(setCalls[0].merge).toBe(true);
    expect(setCalls[0].payload.cursor).toBeNull();
  });
});

describe('roundtrip', () => {
  it('writes a cursor then reads back the same shape', async () => {
    let stored: Record<string, unknown> = {};
    const db: any = {
      collection: (cn: string) => ({
        doc: (dn: string) => ({
          get: async () => ({ exists: true, data: () => stored }),
          set: async (payload: any, options?: { merge?: boolean }) => {
            void cn;
            void dn;
            void options;
            stored = { ...stored, ...payload };
          },
        }),
      }),
    };
    await writeCursor(db, 'portfolioBacktests', 'pb-x', sampleCursor);
    const read = await readCursor(db, 'portfolioBacktests', 'pb-x');
    expect(read).toEqual(sampleCursor);
  });
});
