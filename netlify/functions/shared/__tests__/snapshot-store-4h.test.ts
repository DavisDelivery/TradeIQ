// Phase 4h W1/W2 — freshness-budget widening + retention pruning.
//
// Hermetic. Snapshot-store's pruneOldSnapshots uses where/orderBy/get +
// batched deletes; we mock those minimally. Freshness logic is pure.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeRuns: Array<{ id: string; data: any }> = [];
const batchOps: string[][] = [];

const queryChain = () => {
  let universeFilter: string | undefined;
  let dir: 'asc' | 'desc' = 'asc';

  const build = () => ({
    where: (field: string, op: string, val: any) => {
      if (field === 'universe' && op === '==') universeFilter = val;
      return build();
    },
    orderBy: (_f: string, d: 'asc' | 'desc' = 'asc') => {
      dir = d;
      return build();
    },
    get: async () => {
      let items = [...fakeRuns];
      if (universeFilter) items = items.filter((r) => r.data.universe === universeFilter);
      items.sort((a, b) =>
        dir === 'asc'
          ? a.data.generatedAt.localeCompare(b.data.generatedAt)
          : b.data.generatedAt.localeCompare(a.data.generatedAt),
      );
      return {
        empty: items.length === 0,
        size: items.length,
        docs: items.map((r) => ({
          id: r.id,
          data: () => r.data,
          ref: { id: r.id, _kind: 'runs', _ref: r },
        })),
      };
    },
  });
  return build();
};

vi.mock('../firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: (cn: string) => ({
      doc: (_dn: string) => ({
        collection: (_sub: string) => queryChain(),
      }),
    }),
    batch: () => {
      const pending: string[] = [];
      return {
        delete: (ref: any) => pending.push(ref.id),
        commit: async () => {
          batchOps.push([...pending]);
          // remove from fakeRuns
          for (const id of pending) {
            const idx = fakeRuns.findIndex((r) => r.id === id);
            if (idx >= 0) fakeRuns.splice(idx, 1);
          }
        },
      };
    },
  })),
}));

import {
  pruneOldSnapshots,
  FRESHNESS_BUDGETS_MS,
  isSnapshotFresh,
  snapshotAgeMs,
  type BoardSnapshot,
} from '../snapshot-store';

beforeEach(() => {
  fakeRuns.length = 0;
  batchOps.length = 0;
});

describe('FRESHNESS_BUDGETS_MS — Phase 4h target-board widening', () => {
  it('target-board budget is at least 26h to cover the nightly scan-gap', () => {
    expect(FRESHNESS_BUDGETS_MS['target-board']).toBeGreaterThanOrEqual(26 * 60 * 60_000);
  });

  it('isSnapshotFresh treats a 23h-old target-board snapshot as fresh', () => {
    const snap: BoardSnapshot = {
      modelVersion: 'v1',
      generatedAt: new Date(Date.now() - 23 * 60 * 60_000).toISOString(),
      scanDurationMs: 0,
      universeChecked: 0,
      results: [],
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS['target-board'],
    };
    expect(isSnapshotFresh(snap)).toBe(true);
  });

  it('isSnapshotFresh treats a 27h-old target-board snapshot as stale', () => {
    const snap: BoardSnapshot = {
      modelVersion: 'v1',
      generatedAt: new Date(Date.now() - 27 * 60 * 60_000).toISOString(),
      scanDurationMs: 0,
      universeChecked: 0,
      results: [],
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS['target-board'],
    };
    expect(isSnapshotFresh(snap)).toBe(false);
    expect(snapshotAgeMs(snap)).toBeGreaterThan(26 * 60 * 60_000);
  });
});

function makeRuns(n: number, universe: string = 'russell2k'): void {
  for (let i = 0; i < n; i++) {
    const day = String(i + 1).padStart(2, '0');
    fakeRuns.push({
      id: `${universe}-2026-05-${day}-2300`,
      data: {
        universe,
        generatedAt: `2026-05-${day}T23:00:00.000Z`,
      },
    });
  }
}

describe('pruneOldSnapshots', () => {
  it('keeps everything when count ≤ keep', async () => {
    makeRuns(5);
    const result = await pruneOldSnapshots('target-board', 'russell2k', 30);
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(5);
    expect(fakeRuns).toHaveLength(5);
  });

  it('keeps the 30 newest and deletes the rest', async () => {
    makeRuns(40);
    const result = await pruneOldSnapshots('target-board', 'russell2k', 30);
    expect(result.deleted).toBe(10);
    expect(result.kept).toBe(30);
    expect(fakeRuns).toHaveLength(30);
    // Verify the surviving 30 are the newest (highest day numbers).
    const survivingDays = fakeRuns
      .map((r) => parseInt(r.id.split('-').slice(-2, -1)[0], 10))
      .sort((a, b) => a - b);
    expect(survivingDays[0]).toBe(11); // day 11..40 survive (30 newest)
    expect(survivingDays[survivingDays.length - 1]).toBe(40);
  });

  it('only prunes the targeted universe (universe filter)', async () => {
    makeRuns(35, 'russell2k');
    makeRuns(35, 'sp500');
    const result = await pruneOldSnapshots('target-board', 'russell2k', 30);
    expect(result.deleted).toBe(5);
    const remainingByUniverse = fakeRuns.reduce<Record<string, number>>((acc, r) => {
      acc[r.data.universe] = (acc[r.data.universe] ?? 0) + 1;
      return acc;
    }, {});
    expect(remainingByUniverse.russell2k).toBe(30);
    expect(remainingByUniverse.sp500).toBe(35); // untouched
  });

  it('batches deletes in chunks ≤ 100 per commit', async () => {
    makeRuns(250);
    await pruneOldSnapshots('target-board', 'russell2k', 30);
    // 250 - 30 = 220 to delete; with CHUNK=100 that's 3 batches (100, 100, 20).
    expect(batchOps).toHaveLength(3);
    expect(batchOps[0]).toHaveLength(100);
    expect(batchOps[1]).toHaveLength(100);
    expect(batchOps[2]).toHaveLength(20);
  });
});
