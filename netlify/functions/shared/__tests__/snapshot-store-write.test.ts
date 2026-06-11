// Wave 2D — writeSnapshot promotion discipline.
//
// Pins two rules of the `_latest` pointer:
//   1. Phase 6 PR-H partial-safe write: status:'partial' snapshots land
//      in runs/ but never promote.
//   2. Wave 2D (M4) promotion-race guard: scans overlap in production
//      (30-min russell crons vs ~15-min sieve runs; manual trigger vs
//      the 22:00 cron). A scan that STARTED earlier but FINISHED later
//      must not move _latest backwards — inside the transaction the
//      current pointer is read and the new snapshot only promotes when
//      its generatedAt is strictly newer.
//
// Hermetic: getAdminDb is mocked with an in-memory transaction store.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({
  runs: new Map<string, any>(),
  latest: new Map<string, any>(),
}));

vi.mock('../firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (_root: string) => ({
      doc: (_board: string) => ({
        collection: (sub: string) => ({
          doc: (id: string) => ({ _sub: sub, _id: id }),
        }),
      }),
    }),
    runTransaction: async (fn: (tx: any) => Promise<void>) => {
      const mapFor = (ref: any) => (ref._sub === '_latest' ? store.latest : store.runs);
      const tx = {
        get: async (ref: any) => {
          const data = mapFor(ref).get(ref._id);
          return { exists: data !== undefined, data: () => data };
        },
        set: (ref: any, data: any) => {
          mapFor(ref).set(ref._id, data);
        },
      };
      await fn(tx);
    },
  }),
}));

import { writeSnapshot, type BoardSnapshot } from '../snapshot-store';

beforeEach(() => {
  store.runs.clear();
  store.latest.clear();
});

function snapshot(opts: {
  generatedAt: string;
  status?: 'complete' | 'partial';
  results?: any[];
}): BoardSnapshot {
  return {
    modelVersion: 'test-model',
    generatedAt: opts.generatedAt,
    scanDurationMs: 1000,
    universeChecked: 500,
    results: opts.results ?? [{ ticker: 'NVDA' }],
    freshnessBudgetMs: 26 * 60 * 60_000,
    status: opts.status,
  };
}

describe('writeSnapshot — partial-safe write (PR-H)', () => {
  it('promotes a complete snapshot when no pointer exists', async () => {
    const r = await writeSnapshot('prophet', 'largecap', snapshot({
      generatedAt: '2026-06-10T22:05:00.000Z',
      status: 'complete',
    }));
    expect(r.promotedToLatest).toBe(true);
    expect(store.latest.get('largecap')).toMatchObject({
      snapshotId: r.snapshotId,
      generatedAt: '2026-06-10T22:05:00.000Z',
    });
    expect(store.runs.get(r.snapshotId)).toBeDefined();
  });

  it('writes a partial snapshot to runs/ but never promotes it', async () => {
    const r = await writeSnapshot('prophet', 'largecap', snapshot({
      generatedAt: '2026-06-10T22:05:00.000Z',
      status: 'partial',
    }));
    expect(r.promotedToLatest).toBe(false);
    expect(store.latest.has('largecap')).toBe(false);
    expect(store.runs.get(r.snapshotId)).toMatchObject({ status: 'partial' });
  });
});

describe('writeSnapshot — promotion-race guard (Wave 2D M4)', () => {
  it('an older-but-slower scan does NOT overwrite a newer promoted snapshot', async () => {
    // A newer scan already promoted...
    const newer = await writeSnapshot('prophet', 'russell2k', snapshot({
      generatedAt: '2026-06-10T18:30:00.000Z',
      status: 'complete',
    }));
    expect(newer.promotedToLatest).toBe(true);

    // ...then a scan that started earlier finishes later and writes an
    // OLDER generatedAt. It must land in runs/ but leave the pointer alone.
    const older = await writeSnapshot('prophet', 'russell2k', snapshot({
      generatedAt: '2026-06-10T18:00:00.000Z',
      status: 'complete',
      results: [{ ticker: 'STALE' }],
    }));
    expect(older.promotedToLatest).toBe(false);
    expect(store.latest.get('russell2k')).toMatchObject({
      snapshotId: newer.snapshotId,
      generatedAt: '2026-06-10T18:30:00.000Z',
    });
    // The losing run is still preserved for diagnostics/history.
    expect(store.runs.get(older.snapshotId)).toBeDefined();
  });

  it('does not re-promote on an equal generatedAt (idempotent retry)', async () => {
    const first = await writeSnapshot('prophet', 'russell2k', snapshot({
      generatedAt: '2026-06-10T18:30:00.000Z',
      status: 'complete',
    }));
    expect(first.promotedToLatest).toBe(true);
    const retry = await writeSnapshot('prophet', 'russell2k', snapshot({
      generatedAt: '2026-06-10T18:30:00.000Z',
      status: 'complete',
    }));
    expect(retry.promotedToLatest).toBe(false);
    expect(store.latest.get('russell2k')).toMatchObject({ snapshotId: first.snapshotId });
  });

  it('a strictly newer complete snapshot still promotes over the pointer', async () => {
    await writeSnapshot('prophet', 'russell2k', snapshot({
      generatedAt: '2026-06-10T18:00:00.000Z',
      status: 'complete',
    }));
    const newer = await writeSnapshot('prophet', 'russell2k', snapshot({
      generatedAt: '2026-06-10T18:30:00.000Z',
      status: 'complete',
    }));
    expect(newer.promotedToLatest).toBe(true);
    expect(store.latest.get('russell2k')).toMatchObject({
      snapshotId: newer.snapshotId,
      generatedAt: '2026-06-10T18:30:00.000Z',
    });
  });

  it('legacy snapshots without status still promote when strictly newer', async () => {
    const r = await writeSnapshot('insider', 'sp500', snapshot({
      generatedAt: '2026-06-10T21:30:00.000Z',
    }));
    expect(r.promotedToLatest).toBe(true);
  });
});
