// Phase 4e-1 — GET /api/prophet-portfolio handler tests.
//
// Mocks Firestore state so we can verify:
//   - empty state returns ok:true with empty arrays
//   - populated state returns metrics consistent with the curve
//   - non-GET methods return 405
//   - unknown universe returns 400

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stub = {
  state: null as any,
  swaps: [] as any[],
  curve: [] as any[],
};

vi.mock('../shared/prophet-portfolio/state', () => ({
  getPortfolioState: vi.fn(async () => stub.state),
  listRecentSwaps: vi.fn(async () => stub.swaps),
  listEquityCurve: vi.fn(async () => stub.curve),
}));

vi.mock('../shared/logger', () => ({
  logger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  },
}));

import { computeWindowMetrics, handler } from '../prophet-portfolio';

function makeEvent(overrides: Partial<{
  method: string;
  universe?: string;
}> = {}) {
  return {
    httpMethod: overrides.method ?? 'GET',
    queryStringParameters: overrides.universe
      ? { universe: overrides.universe }
      : {},
    rawUrl: 'https://test/api/prophet-portfolio',
    headers: {},
  } as any;
}

beforeEach(() => {
  stub.state = null;
  stub.swaps = [];
  stub.curve = [];
});

describe('GET /api/prophet-portfolio — empty state', () => {
  it('returns ok:true with null state and empty arrays', async () => {
    const res = await handler(makeEvent(), {} as any, () => {});
    const body = JSON.parse((res as any).body);
    expect((res as any).statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.state).toBeNull();
    expect(body.swaps).toEqual([]);
    expect(body.equityCurve).toEqual([]);
    expect(body.metrics.sinceInception.portfolioReturnPct).toBe(0);
  });
});

describe('GET /api/prophet-portfolio — populated state', () => {
  it('returns metrics computed from the equity curve', async () => {
    stub.state = {
      universe: 'largecap',
      asOfDate: '2024-06-01',
      cash: 0,
      equity: 110_000,
      positions: [],
      lastRebalanceAt: '2024-01-01T21:00:00Z',
      updatedAt: '2024-06-01T21:00:00Z',
    };
    stub.curve = [];
    for (let i = 0; i < 30; i++) {
      const date = new Date(2024, 0, i + 1).toISOString().slice(0, 10);
      const equity = 100_000 + i * 100;
      const spy = 500 + i * 0.5;
      stub.curve.push({
        date,
        equity,
        cash: 0,
        holdingsValue: equity,
        dailyReturn: 0,
        spyClose: spy,
        qqqClose: null,
        iwfClose: null,
      });
    }
    const res = await handler(makeEvent({ universe: 'largecap' }), {} as any, () => {});
    const body = JSON.parse((res as any).body);
    expect(body.ok).toBe(true);
    expect(body.metrics.sinceInception.portfolioReturnPct).toBeCloseTo(2.9, 1);
    // SPY went 500 → 514.5; ~2.9% as well
    expect(body.metrics.sinceInception.spyReturnPct).toBeCloseTo(2.9, 1);
    expect(body.metrics.sinceInception.excessReturnPct).toBeCloseTo(0, 1);
  });
});

describe('GET /api/prophet-portfolio — method + universe validation', () => {
  it('rejects POST with 405', async () => {
    const res = await handler(makeEvent({ method: 'POST' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(405);
  });

  it('rejects unknown universe with 400', async () => {
    const res = await handler(
      makeEvent({ universe: 'bogus' }),
      {} as any,
      () => {},
    );
    expect((res as any).statusCode).toBe(400);
  });

  it('accepts russell2k universe (forward-compatible)', async () => {
    const res = await handler(
      makeEvent({ universe: 'russell2k' }),
      {} as any,
      () => {},
    );
    expect((res as any).statusCode).toBe(200);
  });
});

describe('computeWindowMetrics', () => {
  it('returns zero metrics for empty curve', () => {
    expect(computeWindowMetrics([]).portfolioReturnPct).toBe(0);
  });

  it('reports excess vs SPY when portfolio outperforms', () => {
    const curve = [
      { date: '2024-01-01', equity: 100_000, cash: 0, holdingsValue: 100_000, dailyReturn: 0, spyClose: 500, qqqClose: null, iwfClose: null },
      { date: '2024-01-02', equity: 110_000, cash: 0, holdingsValue: 110_000, dailyReturn: 0.1, spyClose: 505, qqqClose: null, iwfClose: null },
    ];
    const m = computeWindowMetrics(curve);
    expect(m.portfolioReturnPct).toBeCloseTo(10, 2);
    expect(m.spyReturnPct).toBeCloseTo(1, 2);
    expect(m.excessReturnPct).toBeCloseTo(9, 2);
  });
});
