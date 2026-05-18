// Phase 4l W2 — runInsiderScanBatch unit tests.
//
// Verifies the batch entry point used by `scan-insider-russell2k-background.ts`:
// universe slicing by startIdx + batchSize, row construction from mocked
// Finnhub txs, and optional price enrichment via Polygon.
//
// Networking is mocked; nothing leaves the test process.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInsiderTx: vi.fn(),
  getInsiderTxStatus: vi.fn(),
  getPreviousClose: vi.fn(),
  lookupRole: vi.fn(),
}));

vi.mock('../data-provider', async () => {
  const actual = await vi.importActual<any>('../data-provider');
  return {
    ...actual,
    getFinnhubInsiderTransactions: mocks.getInsiderTx,
    getFinnhubInsiderTransactionsWithStatus: mocks.getInsiderTxStatus,
    getPreviousClose: mocks.getPreviousClose,
  };
});

vi.mock('../edgar-roles', () => ({
  lookupInsiderRole: mocks.lookupRole,
}));

// Stub the universe to a deterministic set for testing slicing.
vi.mock('../universe', async () => {
  const stub = [
    { ticker: 'T0000', name: 'T0000', sector: 'Tech', indices: ['russell2k'] },
    { ticker: 'T0001', name: 'T0001', sector: 'Tech', indices: ['russell2k'] },
    { ticker: 'T0002', name: 'T0002', sector: 'Tech', indices: ['russell2k'] },
    { ticker: 'T0003', name: 'T0003', sector: 'Tech', indices: ['russell2k'] },
    { ticker: 'T0004', name: 'T0004', sector: 'Tech', indices: ['russell2k'] },
  ];
  return {
    UNIVERSE: stub,
    inIndex: (tag: string) => stub.filter((s) => s.indices.includes(tag)),
  };
});

import { runInsiderScanBatch, resolveInsiderUniverse } from '../scan-insider';

beforeEach(() => {
  mocks.getInsiderTx.mockReset();
  mocks.getInsiderTxStatus.mockReset();
  mocks.getPreviousClose.mockReset();
  mocks.lookupRole.mockReset();
  // Default: status-aware shim just wraps the plain getInsiderTx mock so
  // legacy tests calling `mocks.getInsiderTx.mockImplementation(...)` still
  // drive the new code path.
  mocks.getInsiderTxStatus.mockImplementation(async (ticker: string, daysBack: number) => {
    const data = await mocks.getInsiderTx(ticker, daysBack);
    return { data, rateLimited: false, rateLimitExhausted: false };
  });
});

function buyTx(name: string, dollars: number, daysAgo: number) {
  const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  return {
    name,
    change: 100,
    transactionPrice: dollars / 100,
    transactionDate: date,
    filingDate: date,
    transactionCode: 'P',
    isDerivative: false,
  };
}

describe('runInsiderScanBatch (Phase 4l W2)', () => {
  it('slices the universe by startIdx and batchSize', async () => {
    mocks.getInsiderTx.mockImplementation(async (ticker: string) => [
      buyTx(`Insider-${ticker}`, 50_000, 10),
    ]);

    const r = await runInsiderScanBatch({
      universe: 'russell2k',
      windowDays: 180,
      startIdx: 2,
      batchSize: 2,
    });

    expect(r.tickersConsumed).toBe(2);
    expect(r.rows.map((row) => row.ticker)).toEqual(['T0002', 'T0003']);
  });

  it('returns empty rows when no insider activity in window', async () => {
    mocks.getInsiderTx.mockResolvedValue([]);
    const r = await runInsiderScanBatch({
      universe: 'russell2k',
      windowDays: 180,
      startIdx: 0,
      batchSize: 3,
    });
    expect(r.rows).toEqual([]);
    expect(r.tickersConsumed).toBe(3);
  });

  it('builds row with buy aggregation and topBuyer', async () => {
    mocks.getInsiderTx.mockImplementation(async (ticker: string) => {
      if (ticker !== 'T0000') return [];
      return [
        buyTx('Big Buyer', 200_000, 3),
        buyTx('Small Buyer', 25_000, 10),
      ];
    });

    const r = await runInsiderScanBatch({
      universe: 'russell2k',
      windowDays: 180,
      startIdx: 0,
      batchSize: 3,
    });

    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.ticker).toBe('T0000');
    expect(row.buyDollars).toBe(225_000);
    expect(row.buyerCount).toBe(2);
    expect(row.topBuyer?.name).toBe('Big Buyer');
    expect(row.price).toBeNull(); // enrichPrice off
  });

  it('enrichPrice=true attaches Polygon previous close', async () => {
    mocks.getInsiderTx.mockImplementation(async (ticker: string) =>
      ticker === 'T0000' ? [buyTx('A', 50_000, 5)] : [],
    );
    mocks.getPreviousClose.mockImplementation(async (ticker: string) => {
      if (ticker === 'T0000') return { t: 0, o: 0, h: 0, l: 0, c: 42.37, v: 0 };
      return null;
    });

    const r = await runInsiderScanBatch({
      universe: 'russell2k',
      windowDays: 180,
      startIdx: 0,
      batchSize: 5,
      enrichPrice: true,
    });

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].price).toBe(42.37);
  });

  it('price enrichment failure leaves price: null without throwing', async () => {
    mocks.getInsiderTx.mockImplementation(async (ticker: string) =>
      ticker === 'T0000' ? [buyTx('A', 50_000, 5)] : [],
    );
    mocks.getPreviousClose.mockRejectedValue(new Error('Polygon hiccup'));

    const r = await runInsiderScanBatch({
      universe: 'russell2k',
      windowDays: 180,
      startIdx: 0,
      batchSize: 5,
      enrichPrice: true,
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].price).toBeNull();
  });

  it('enrichRoles=true upgrades topBuyer.role from EDGAR lookup', async () => {
    mocks.getInsiderTx.mockImplementation(async (ticker: string) =>
      ticker === 'T0000' ? [buyTx('Big Buyer', 100_000, 3)] : [],
    );
    mocks.lookupRole.mockResolvedValue('Chief Executive Officer');

    const r = await runInsiderScanBatch({
      universe: 'russell2k',
      windowDays: 180,
      startIdx: 0,
      batchSize: 5,
      enrichRoles: true,
    });

    expect(r.rows[0].topBuyer?.role).toBe('Chief Executive Officer');
  });

  it('resolveInsiderUniverse returns the stub universe tickers in order', () => {
    expect(resolveInsiderUniverse('russell2k')).toEqual([
      'T0000', 'T0001', 'T0002', 'T0003', 'T0004',
    ]);
  });
});
