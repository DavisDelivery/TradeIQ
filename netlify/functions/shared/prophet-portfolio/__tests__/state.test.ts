// Phase 4e-1 — Portfolio state CRUD round-trip tests.
//
// Uses an in-memory Firestore mock keyed by full path. Mirrors the
// pattern in snapshot-store-pit.test.ts so the mock supports nested
// collections, where/orderBy/limit, and set + merge.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: Map<string, any> = new Map();

interface DocSnap {
  exists: boolean;
  data: () => any;
  id: string;
}

function makeCollectionRef(prefix: string): any {
  return {
    doc: (id: string) => makeDocRef(`${prefix}/${id}`),
    where: (field: string, op: string, value: any) =>
      makeQueryRef(prefix, [{ field, op, value }], null, null),
    orderBy: (field: string, dir: 'asc' | 'desc' = 'asc') =>
      makeQueryRef(prefix, [], { field, dir }, null),
    limit: (n: number) => makeQueryRef(prefix, [], null, n),
  };
}

function makeDocRef(path: string): any {
  return {
    set: async (data: any, options?: { merge?: boolean }) => {
      if (options?.merge) {
        const existing = store.get(path) ?? {};
        store.set(path, { ...existing, ...data });
      } else {
        store.set(path, data);
      }
    },
    get: async (): Promise<DocSnap> => {
      const data = store.get(path);
      const id = path.split('/').pop() ?? '';
      return {
        exists: data !== undefined,
        data: () => data,
        id,
      };
    },
    collection: (name: string) => makeCollectionRef(`${path}/${name}`),
  };
}

function makeQueryRef(
  prefix: string,
  filters: Array<{ field: string; op: string; value: any }>,
  order: { field: string; dir: 'asc' | 'desc' } | null,
  limit: number | null,
): any {
  const ref = {
    where: (field: string, op: string, value: any) =>
      makeQueryRef(prefix, [...filters, { field, op, value }], order, limit),
    orderBy: (field: string, dir: 'asc' | 'desc' = 'asc') =>
      makeQueryRef(prefix, filters, { field, dir }, limit),
    limit: (n: number) => makeQueryRef(prefix, filters, order, n),
    get: async () => {
      const items: Array<{ id: string; data: any }> = [];
      for (const [key, data] of store.entries()) {
        if (!key.startsWith(`${prefix}/`)) continue;
        // Only direct children (no further '/')
        const tail = key.slice(prefix.length + 1);
        if (tail.includes('/')) continue;
        let ok = true;
        for (const f of filters) {
          const v = (data as any)?.[f.field];
          if (f.op === '<=' && !(v <= f.value)) ok = false;
          else if (f.op === '>=' && !(v >= f.value)) ok = false;
          else if (f.op === '==' && !(v === f.value)) ok = false;
        }
        if (!ok) continue;
        items.push({ id: tail, data });
      }
      if (order) {
        items.sort((a, b) => {
          const av = a.data?.[order.field];
          const bv = b.data?.[order.field];
          if (av === bv) return 0;
          const cmp = av < bv ? -1 : 1;
          return order.dir === 'asc' ? cmp : -cmp;
        });
      }
      const sliced = limit != null ? items.slice(0, limit) : items;
      return {
        empty: sliced.length === 0,
        docs: sliced.map((r) => ({ id: r.id, data: () => r.data })),
      };
    },
  };
  return ref;
}

vi.mock('../../firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (top: string) => makeCollectionRef(top),
  }),
}));

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => ({ _seconds: 1_700_000_000, _nanoseconds: 0 }) },
}));

import {
  appendEquityCurvePoint,
  getPortfolioConfig,
  getPortfolioState,
  listDecisionLogRowsOlderThan,
  listEquityCurve,
  listRecentSwaps,
  recordSwap,
  updateDecisionLogForwardReturns,
  writeDecisionLogRow,
  writePortfolioConfig,
  writePortfolioState,
} from '../state';
import type {
  DecisionLogRow,
  EquityCurvePoint,
  PortfolioConfig,
  PortfolioState,
  SwapEvent,
} from '../types';

const SAMPLE_CONFIG: PortfolioConfig = {
  universe: 'largecap',
  startDate: '2024-01-08',
  startCapital: 100_000,
  positionCount: 10,
  minHoldDays: 30,
  maxSwapsPerRebalance: 3,
  sectorCap: 4,
  slippageBps: 10,
  minComposite: 50,
  candidatePool: 15,
  version: 'v1',
};

const SAMPLE_STATE: PortfolioState = {
  universe: 'largecap',
  asOfDate: '2024-01-08',
  cash: 0,
  equity: 100_005.05,
  positions: [
    {
      ticker: 'AAPL',
      shares: 55,
      entryDate: '2024-01-02',
      entryPrice: 180.5,
      currentPrice: 181.91,
      marketValue: 10_005.05,
      weight: 0.1,
      sector: 'Technology',
    },
  ],
  lastRebalanceAt: '2024-01-08T21:00:00.000Z',
  updatedAt: '2024-01-08T21:00:01.234Z',
};

beforeEach(() => {
  store.clear();
});

describe('config CRUD', () => {
  it('round-trips a PortfolioConfig', async () => {
    await writePortfolioConfig('largecap', SAMPLE_CONFIG);
    const got = await getPortfolioConfig('largecap');
    expect(got).not.toBeNull();
    expect(got!.positionCount).toBe(10);
    expect(got!.minHoldDays).toBe(30);
    expect(got!.version).toBe('v1');
  });

  it('returns null when no config exists', async () => {
    const got = await getPortfolioConfig('largecap');
    expect(got).toBeNull();
  });
});

describe('state CRUD', () => {
  it('round-trips PortfolioState with positions intact', async () => {
    await writePortfolioState('largecap', SAMPLE_STATE);
    const got = await getPortfolioState('largecap');
    expect(got).not.toBeNull();
    expect(got!.positions).toHaveLength(1);
    expect(got!.positions[0].ticker).toBe('AAPL');
    expect(got!.asOfDate).toBe('2024-01-08');
  });

  it('preserves numeric precision on shares + prices', async () => {
    const state: PortfolioState = {
      ...SAMPLE_STATE,
      positions: [
        {
          ...SAMPLE_STATE.positions[0],
          shares: 12.345678,
          entryPrice: 99.123456,
        },
      ],
    };
    await writePortfolioState('largecap', state);
    const got = await getPortfolioState('largecap');
    expect(got!.positions[0].shares).toBe(12.345678);
    expect(got!.positions[0].entryPrice).toBe(99.123456);
  });

  it('returns null when no state exists', async () => {
    const got = await getPortfolioState('largecap');
    expect(got).toBeNull();
  });

  it('isolates state by universe', async () => {
    await writePortfolioState('largecap', SAMPLE_STATE);
    const russell = await getPortfolioState('russell2k');
    expect(russell).toBeNull();
  });
});

describe('swaps', () => {
  function sampleSwap(asOfDate: string, hhmm: string): Omit<SwapEvent, 'swapId'> {
    return {
      timestamp: `${asOfDate}T${hhmm}:00.000Z`,
      asOfDate,
      out: [],
      in: [],
      candidatesConsidered: 15,
      swapsApplied: 0,
      snapshotId: `largecap-${asOfDate.replace(/-/g, '')}-2100`,
      notes: '',
      signalId: 'composite-v1',
    };
  }

  it('records a swap and returns the swapId', async () => {
    const id = await recordSwap('largecap', sampleSwap('2024-01-08', '21:00'));
    expect(id).toBe('2024-01-08-2100');
  });

  it('listRecentSwaps returns newest first', async () => {
    await recordSwap('largecap', sampleSwap('2024-01-08', '21:00'));
    await recordSwap('largecap', sampleSwap('2024-01-15', '21:00'));
    await recordSwap('largecap', sampleSwap('2024-01-22', '21:00'));
    const list = await listRecentSwaps('largecap', 10);
    expect(list).toHaveLength(3);
    expect(list[0].asOfDate).toBe('2024-01-22');
    expect(list[2].asOfDate).toBe('2024-01-08');
  });
});

describe('equity curve', () => {
  function pt(date: string, equity: number): EquityCurvePoint {
    return {
      date,
      equity,
      cash: 0,
      holdingsValue: equity,
      dailyReturn: 0,
      spyClose: 500,
      qqqClose: 400,
      iwfClose: 250,
    };
  }

  it('appends and reads back equity curve points in date order', async () => {
    await appendEquityCurvePoint('largecap', pt('2024-01-08', 100_000));
    await appendEquityCurvePoint('largecap', pt('2024-01-09', 100_500));
    await appendEquityCurvePoint('largecap', pt('2024-01-10', 100_300));
    const curve = await listEquityCurve('largecap', 100);
    expect(curve).toHaveLength(3);
    expect(curve[0].date).toBe('2024-01-08');
    expect(curve[2].date).toBe('2024-01-10');
  });

  it('honors the limit (newest N, returned ascending)', async () => {
    for (let i = 1; i <= 5; i++) {
      await appendEquityCurvePoint('largecap', pt(`2024-01-0${i}`, 100_000 + i));
    }
    const curve = await listEquityCurve('largecap', 2);
    expect(curve).toHaveLength(2);
    expect(curve[0].date).toBe('2024-01-04');
    expect(curve[1].date).toBe('2024-01-05');
  });
});

describe('decisionLog', () => {
  function row(ticker: string, decisionDate: string): DecisionLogRow {
    return {
      decisionDate,
      ticker,
      action: 'ADD',
      composite: 75,
      layers: { fundamental: { score: 80, pass: true } },
      regime: 'risk_on',
      signalId: 'composite-v1',
    };
  }

  it('round-trips a decision row', async () => {
    await writeDecisionLogRow('largecap', row('AAPL', '2024-01-08'));
    const rows = await listDecisionLogRowsOlderThan('largecap', '2024-01-08', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].ticker).toBe('AAPL');
  });

  it('updateDecisionLogForwardReturns merges without dropping the row', async () => {
    await writeDecisionLogRow('largecap', row('AAPL', '2024-01-08'));
    await updateDecisionLogForwardReturns('largecap', 'AAPL', '2024-01-08', {
      forwardReturn30d: 0.045,
    });
    const rows = await listDecisionLogRowsOlderThan('largecap', '2024-01-08', 10);
    expect(rows[0].forwardReturn30d).toBeCloseTo(0.045);
    expect(rows[0].action).toBe('ADD');
  });

  it('listDecisionLogRowsOlderThan respects cutoff', async () => {
    await writeDecisionLogRow('largecap', row('AAPL', '2024-01-08'));
    await writeDecisionLogRow('largecap', row('MSFT', '2024-02-08'));
    const olderThanJan = await listDecisionLogRowsOlderThan('largecap', '2024-01-15', 10);
    expect(olderThanJan).toHaveLength(1);
    expect(olderThanJan[0].ticker).toBe('AAPL');
  });
});
