import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock firebase-admin's getAdminDb to expose a controllable in-memory store.
const fakeRuns: Array<{ id: string; data: any }> = [];

const queryBuilder = () => {
  let universeFilter: string | undefined;
  let cutoffFilter: string | undefined;
  let order: 'asc' | 'desc' = 'asc';
  let limit = 100;

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
    get: async () => {
      let items = [...fakeRuns];
      if (universeFilter) items = items.filter((r) => r.data.universe === universeFilter);
      if (cutoffFilter !== undefined) items = items.filter((r) => r.data.generatedAt <= cutoffFilter!);
      items.sort((a, b) =>
        order === 'asc'
          ? a.data.generatedAt.localeCompare(b.data.generatedAt)
          : b.data.generatedAt.localeCompare(a.data.generatedAt),
      );
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

function seed(generatedAt: string, results: any[]): void {
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
