import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock firebase-admin's getAdminDb to expose a controllable in-memory store.
const fakeRuns: Array<{ id: string; data: any }> = [];

const queryBuilder = () => {
  let universeFilter: string | undefined;
  let cutoffFilter: string | undefined;
  let order: 'asc' | 'desc' = 'asc';
  let limit = 100;
  let startAfterId: string | undefined;

  const build = () => ({
    where: (field: string, op: string, value: any) => {
      if (field === 'universe' && op === '==') universeFilter = value;
      if (field === 'generatedAt' && op === '<=') cutoffFilter = value;
      return build();
    },
    orderBy: (_field: string, dir: 'asc' | 'desc') => {
      order = dir;
      return build();
    },
    limit: (n: number) => {
      limit = n;
      return build();
    },
    // Wave 2D — snapshotBeforeDate now pages with startAfter(doc) while
    // skipping partial-status snapshots. Mirror Firestore's cursor
    // semantics: results strictly after the given doc in sort order.
    startAfter: (doc: { id: string }) => {
      startAfterId = doc.id;
      return build();
    },
    get: async () => {
      let items = [...fakeRuns];
      if (universeFilter) items = items.filter((r) => r.data.universe === universeFilter);
      if (cutoffFilter !== undefined) items = items.filter((r) => r.data.generatedAt <= cutoffFilter!);
      items.sort((a, b) =>
        order === 'asc'
          ? a.data.generatedAt.localeCompare(b.data.generatedAt)
          : b.data.generatedAt.localeCompare(a.data.generatedAt),
      );
      if (startAfterId !== undefined) {
        const idx = items.findIndex((r) => r.id === startAfterId);
        items = idx >= 0 ? items.slice(idx + 1) : items;
      }
      items = items.slice(0, limit);
      return {
        empty: items.length === 0,
        docs: items.map((r) => ({ id: r.id, data: () => r.data })),
      };
    },
  });

  return build();
};

vi.mock('../firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (_n: string) => ({
      doc: (_d: string) => ({
        collection: (_c: string) => queryBuilder(),
      }),
    }),
  }),
}));

import { snapshotBeforeDate, fieldAtDate } from '../snapshot-store';

beforeEach(() => {
  fakeRuns.length = 0;
});

function seed(
  generatedAt: string,
  results: any[],
  extra: Record<string, unknown> = {},
): void {
  fakeRuns.push({
    id: `sp500-${generatedAt.replace(/[-T:.Z]/g, '').slice(0, 12)}`,
    data: {
      universe: 'sp500',
      board: 'catalyst',
      modelVersion: 'test',
      generatedAt,
      scanDurationMs: 1,
      universeChecked: 1,
      results,
      freshnessBudgetMs: 1,
      ...extra,
    },
  });
}

describe('snapshotBeforeDate', () => {
  it('returns null when no snapshot exists', async () => {
    const out = await snapshotBeforeDate('catalyst', 'sp500', '2024-01-01');
    expect(out).toBeNull();
  });

  it('returns the latest snapshot ≤ asOfDate', async () => {
    seed('2024-01-15T12:00:00.000Z', [{ ticker: 'NVDA' }]);
    seed('2024-03-15T12:00:00.000Z', [{ ticker: 'AAPL' }]);
    seed('2024-06-15T12:00:00.000Z', [{ ticker: 'MSFT' }]);

    const out = await snapshotBeforeDate('catalyst', 'sp500', '2024-04-01');
    expect(out).not.toBeNull();
    expect((out!.results as any[])[0].ticker).toBe('AAPL');
  });

  it('respects end-of-day inclusive semantics', async () => {
    seed('2024-06-30T23:59:59.000Z', [{ ticker: 'EOD' }]);
    seed('2024-07-01T00:00:00.000Z', [{ ticker: 'NEXT' }]);

    const out = await snapshotBeforeDate('catalyst', 'sp500', '2024-06-30');
    expect(out).not.toBeNull();
    expect((out!.results as any[])[0].ticker).toBe('EOD');
  });

  it('returns null when all snapshots are after asOfDate', async () => {
    seed('2025-01-15T12:00:00.000Z', [{ ticker: 'NVDA' }]);
    const out = await snapshotBeforeDate('catalyst', 'sp500', '2024-01-01');
    expect(out).toBeNull();
  });

  // Wave 2D (M3) — partial-status snapshots are written to runs/ for
  // diagnostics but never promoted; PIT reads must honor the same canon.
  it('skips a partial-status snapshot and returns the prior non-partial one', async () => {
    seed('2024-03-15T12:00:00.000Z', [{ ticker: 'GOOD' }], { status: 'complete' });
    seed('2024-03-20T12:00:00.000Z', [{ ticker: 'JUNK' }], { status: 'partial' });

    const out = await snapshotBeforeDate('catalyst', 'sp500', '2024-04-01');
    expect(out).not.toBeNull();
    expect((out!.results as any[])[0].ticker).toBe('GOOD');
  });

  it('still returns degraded complete snapshots (promotion publishes those)', async () => {
    seed('2024-03-15T12:00:00.000Z', [{ ticker: 'DEGRADED' }], {
      status: 'complete',
      degraded: true,
      degradedReason: 'degraded: 2/10 calls failed',
    });
    const out = await snapshotBeforeDate('catalyst', 'sp500', '2024-04-01');
    expect(out).not.toBeNull();
    expect((out!.results as any[])[0].ticker).toBe('DEGRADED');
  });

  it('treats legacy snapshots without a status field as canonical', async () => {
    seed('2024-03-15T12:00:00.000Z', [{ ticker: 'LEGACY' }]); // no status
    const out = await snapshotBeforeDate('catalyst', 'sp500', '2024-04-01');
    expect(out).not.toBeNull();
    expect((out!.results as any[])[0].ticker).toBe('LEGACY');
  });

  it('returns null when only partial snapshots exist before asOfDate', async () => {
    seed('2024-03-15T12:00:00.000Z', [{ ticker: 'JUNK1' }], { status: 'partial' });
    seed('2024-03-20T12:00:00.000Z', [{ ticker: 'JUNK2' }], { status: 'partial' });
    const out = await snapshotBeforeDate('catalyst', 'sp500', '2024-04-01');
    expect(out).toBeNull();
  });

  it('pages past a long run of partials to find an older complete snapshot', async () => {
    // 12 partials (more than one page of 10) newer than the lone complete.
    seed('2024-03-01T12:00:00.000Z', [{ ticker: 'OLD_GOOD' }], { status: 'complete' });
    for (let i = 0; i < 12; i++) {
      const day = String(2 + i).padStart(2, '0');
      seed(`2024-03-${day}T13:00:00.000Z`, [{ ticker: `P${i}` }], { status: 'partial' });
    }
    const out = await snapshotBeforeDate('catalyst', 'sp500', '2024-04-01');
    expect(out).not.toBeNull();
    expect((out!.results as any[])[0].ticker).toBe('OLD_GOOD');
  });
});

describe('fieldAtDate', () => {
  it('returns null when no snapshot exists', async () => {
    const out = await fieldAtDate('catalyst', 'sp500', 'NVDA', 'recommendation', '2024-01-01');
    expect(out).toBeNull();
  });

  it('returns the field value from the latest snapshot ≤ asOfDate', async () => {
    seed('2024-03-15T12:00:00.000Z', [
      { ticker: 'NVDA', recommendation: { strongBuy: 10, buy: 20 } },
      { ticker: 'AAPL', recommendation: { strongBuy: 8, buy: 15 } },
    ]);

    const out = await fieldAtDate<{ strongBuy: number; buy: number }>(
      'catalyst',
      'sp500',
      'NVDA',
      'recommendation',
      '2024-04-01',
    );
    expect(out).not.toBeNull();
    expect(out!.strongBuy).toBe(10);
  });

  it('returns null when ticker missing from snapshot', async () => {
    seed('2024-03-15T12:00:00.000Z', [{ ticker: 'NVDA', recommendation: { buy: 20 } }]);
    const out = await fieldAtDate('catalyst', 'sp500', 'AAPL', 'recommendation', '2024-04-01');
    expect(out).toBeNull();
  });

  it('returns null when field missing on found row', async () => {
    seed('2024-03-15T12:00:00.000Z', [{ ticker: 'NVDA' }]);
    const out = await fieldAtDate('catalyst', 'sp500', 'NVDA', 'recommendation', '2024-04-01');
    expect(out).toBeNull();
  });
});
