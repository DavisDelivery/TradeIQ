// Phase 4q W1 — /api/target-rationale endpoint contract tests.
//
// Hermetic — every provider call inside runAnalystsForTicker is mocked
// to null/empty, which yields no-data sub-scores for the providers and
// data-driven scores for the analysts that work off bars only
// (technical, sector-rotation, flow). What we are pinning here is the
// HTTP shape:
//   - per-analyst row carries rationale + signals (incl. _noData/_reason)
//   - thin AnalystContribution weight lands on the row
//   - 400 / 404 / 500 paths
// Scoring math itself is covered by analyst-runner-composite.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/data-provider', () => ({
  getDailyBars: vi.fn(async () => []),
  getFundamentals: vi.fn(async () => null),
  getNews: vi.fn(async () => []),
  getUpcomingEarnings: vi.fn(async () => null),
  getEarningsHistory: vi.fn(async () => []),
}));

vi.mock('../shared/insider-provider', () => ({
  getInsiderActivity: vi.fn(async () => null),
}));

vi.mock('../shared/patent-provider', () => ({
  getPatentActivity: vi.fn(async () => null),
}));

vi.mock('../shared/political-provider', () => ({
  getPoliticalActivity: vi.fn(async () => null),
}));

vi.mock('../shared/govcontracts-provider', () => ({
  getGovContractActivity: vi.fn(async () => null),
}));

vi.mock('../shared/regime', () => ({
  computeRegime: vi.fn(async () => null),
  regimeToMacroBias: vi.fn(() => 0),
}));

vi.mock('../shared/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

const fetchBarCacheMock = vi.fn();
const runAnalystsForTickerMock = vi.fn();
vi.mock('../shared/analyst-runner', () => ({
  fetchBarCache: (...args: unknown[]) => fetchBarCacheMock(...args),
  runAnalystsForTicker: (...args: unknown[]) => runAnalystsForTickerMock(...args),
}));

import { handler } from '../target-rationale';

function evt(qs: Record<string, string> = {}) {
  return {
    httpMethod: 'GET',
    queryStringParameters: qs,
    headers: {},
    body: null,
  } as any;
}

function fixtureRunResult() {
  // Mirrors a real runAnalystsForTicker() return: full per-analyst
  // AnalystOutput on `analysts`, thin AnalystContribution[] on
  // `target.analystContributions`.
  const analysts = {
    'technical-analyst': {
      score: 72,
      direction: 'long' as const,
      confidence: 0.6,
      rationale: 'uptrend intact, +4% 20d',
      signals: { ema20: 105, ema50: 100, roc20Pct: 4.2 },
    },
    'earnings-analyst': {
      score: 50,
      direction: 'neutral' as const,
      confidence: 0,
      rationale: 'no earnings catalyst',
      signals: { _noData: true, _reason: 'no_actionable_data', beats4q: 0 },
    },
    'insider-analyst': {
      score: 50,
      direction: 'neutral' as const,
      confidence: 0,
      rationale: 'insider data unavailable',
      signals: { _noData: true, _reason: 'no_data' },
    },
  };
  return {
    target: {
      ticker: 'NVDA',
      composite: 64,
      tier: 'B' as const,
      direction: 'long' as const,
      price: 500.5,
      priceChangePct: 1.2,
      rationale: 'Net long: 1 analyst aligned bullish.',
      analystContributions: [
        { analyst: 'technical-analyst', score: 72, direction: 'long' as const, weight: 0.45 },
        { analyst: 'earnings-analyst', score: 50, direction: 'neutral' as const, weight: 0 },
        { analyst: 'insider-analyst', score: 50, direction: 'neutral' as const, weight: 0 },
      ],
      topSignals: [],
      conflictLevel: 'none' as const,
      scoredAt: '2026-05-19T12:00:00.000Z',
      scoredAnalysts: ['technical-analyst'],
      noDataAnalysts: ['earnings-analyst', 'insider-analyst'],
      companyName: 'NVIDIA',
      sector: 'Technology',
    },
    analysts,
  };
}

beforeEach(() => {
  fetchBarCacheMock.mockReset();
  runAnalystsForTickerMock.mockReset();
  fetchBarCacheMock.mockResolvedValue({});
});

describe('GET /api/target-rationale', () => {
  it('returns 400 when ticker is missing', async () => {
    const res = await handler(evt({}), {} as any, () => {});
    expect((res as any).statusCode).toBe(400);
    const body = JSON.parse((res as any).body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/ticker required/i);
    expect(runAnalystsForTickerMock).not.toHaveBeenCalled();
  });

  it('uppercases ticker before recomputing', async () => {
    runAnalystsForTickerMock.mockResolvedValue(fixtureRunResult());
    await handler(evt({ ticker: 'nvda' }), {} as any, () => {});
    expect(runAnalystsForTickerMock).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: 'NVDA' }),
    );
  });

  it('returns 404 when bars are missing (runAnalystsForTicker → null)', async () => {
    runAnalystsForTickerMock.mockResolvedValue({ target: null, analysts: {} });
    const res = await handler(evt({ ticker: 'NVDA' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(404);
    const body = JSON.parse((res as any).body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no bars/i);
  });

  it('returns 500 on an unexpected error', async () => {
    runAnalystsForTickerMock.mockRejectedValue(new Error('provider exploded'));
    const res = await handler(evt({ ticker: 'NVDA' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(500);
    const body = JSON.parse((res as any).body);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('provider exploded');
  });

  it('returns per-analyst rationale + signals on a successful recompute', async () => {
    runAnalystsForTickerMock.mockResolvedValue(fixtureRunResult());
    const res = await handler(evt({ ticker: 'NVDA' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);

    expect(body.ok).toBe(true);
    expect(body.ticker).toBe('NVDA');
    expect(body.composite).toBe(64);
    expect(body.tier).toBe('B');
    expect(body.modelVersion).toBeTruthy();
    expect(Array.isArray(body.analysts)).toBe(true);
    expect(body.analysts).toHaveLength(3);

    // Every row carries score / direction / weight / rationale / signals.
    const tech = body.analysts.find((r: any) => r.analyst === 'technical-analyst');
    expect(tech).toBeTruthy();
    expect(tech.score).toBe(72);
    expect(tech.direction).toBe('long');
    expect(tech.weight).toBe(0.45);
    expect(tech.rationale).toBe('uptrend intact, +4% 20d');
    expect(tech.signals).toMatchObject({ ema20: 105, roc20Pct: 4.2 });
  });

  it('preserves _noData + _reason markers on no-data analyst rows', async () => {
    runAnalystsForTickerMock.mockResolvedValue(fixtureRunResult());
    const res = await handler(evt({ ticker: 'NVDA' }), {} as any, () => {});
    const body = JSON.parse((res as any).body);

    const earn = body.analysts.find((r: any) => r.analyst === 'earnings-analyst');
    expect(earn.signals._noData).toBe(true);
    expect(earn.signals._reason).toBe('no_actionable_data');
    expect(earn.rationale).toBe('no earnings catalyst');
    expect(earn.weight).toBe(0); // composeWeights rescaled it away

    const ins = body.analysts.find((r: any) => r.analyst === 'insider-analyst');
    expect(ins.signals._noData).toBe(true);
    expect(ins.signals._reason).toBe('no_data');
  });

  it('sets a short browser cache header', async () => {
    runAnalystsForTickerMock.mockResolvedValue(fixtureRunResult());
    const res = await handler(evt({ ticker: 'NVDA' }), {} as any, () => {});
    const cc = (res as any).headers['Cache-Control'];
    expect(cc).toMatch(/max-age=/);
  });
});
