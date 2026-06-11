// Phase 6 W1 — /api/lynch-rationale endpoint contract tests.
//
// Providers are mocked; the real runLynch + component decomposition + thesis +
// risk-callout generators run.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getFundamentalsMock = vi.fn();
const getEarningsHistoryMock = vi.fn();
const getPreviousCloseMock = vi.fn();
vi.mock('../shared/data-provider', () => ({
  getFundamentals: (...a: unknown[]) => getFundamentalsMock(...a),
  getEarningsHistory: (...a: unknown[]) => getEarningsHistoryMock(...a),
  getPreviousClose: (...a: unknown[]) => getPreviousCloseMock(...a),
}));

vi.mock('../shared/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { handler } from '../lynch-rationale';

function evt(qs: Record<string, string> = {}) {
  return { httpMethod: 'GET', queryStringParameters: qs, headers: {}, body: null } as any;
}

function strongFundamentals() {
  return {
    ticker: 'AAPL',
    ttmEps: 6.0,
    epsGrowthYoY: 0.25,
    // Wave 4C (review M5): the endpoint now feeds runLynch the TTM-on-TTM
    // growth rate, not the single-quarter YoY rate.
    epsGrowthTTM: 0.25,
    revenueGrowthYoY: 0.2,
    debtToEquity: 0.25,
    operatingMargin: 0.3,
  };
}

beforeEach(() => {
  getFundamentalsMock.mockReset();
  getEarningsHistoryMock.mockReset();
  getPreviousCloseMock.mockReset();
  getEarningsHistoryMock.mockResolvedValue([]);
  getPreviousCloseMock.mockResolvedValue(null);
});

describe('GET /api/lynch-rationale', () => {
  it('returns 400 when ticker is missing', async () => {
    const res = await handler(evt({}), {} as any, () => {});
    expect((res as any).statusCode).toBe(400);
  });

  it('returns 404 when neither fundamentals nor earnings are available', async () => {
    getFundamentalsMock.mockResolvedValue(null);
    getEarningsHistoryMock.mockResolvedValue([]);
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(404);
    const body = JSON.parse((res as any).body);
    expect(body.error).toMatch(/no fundamentals/i);
  });

  it('returns components + thesis + risk callouts for a strong GARP name', async () => {
    getFundamentalsMock.mockResolvedValue(strongFundamentals());
    getPreviousCloseMock.mockResolvedValue({ t: 0, o: 90, h: 92, l: 89, c: 90, v: 1 });
    getEarningsHistoryMock.mockResolvedValue([
      { period: '2025-12-31', announceDate: '2026-01-30', epsActual: 2.4, epsEstimate: 2.2 },
      { period: '2025-09-30', announceDate: '2025-10-30', epsActual: 1.6, epsEstimate: 1.5 },
      { period: '2025-06-30', announceDate: '2025-07-30', epsActual: 1.4, epsEstimate: 1.3 },
      { period: '2025-03-31', announceDate: '2025-04-30', epsActual: 1.5, epsEstimate: 1.4 },
    ]);
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);

    expect(body.ok).toBe(true);
    expect(body.components).toHaveLength(5);
    expect(typeof body.thesis).toBe('string');
    expect(body.riskCallouts.length).toBeGreaterThan(0);
    // PEG component should be present and favorable (cheap/reasonable).
    const peg = body.components.find((c: any) => c.name.startsWith('PEG'));
    expect(peg).toBeTruthy();
    expect(peg.signals.peg).toBeGreaterThan(0);
  });

  it('marks components no-data when fundamentals are absent but earnings exist', async () => {
    getFundamentalsMock.mockResolvedValue(null);
    getEarningsHistoryMock.mockResolvedValue([
      { period: '2025-12-31', announceDate: '2026-01-30', epsActual: 2.4, epsEstimate: 2.2 },
      { period: '2025-09-30', announceDate: '2025-10-30', epsActual: 1.6, epsEstimate: 1.5 },
      { period: '2025-06-30', announceDate: '2025-07-30', epsActual: 1.4, epsEstimate: 1.3 },
      { period: '2025-03-31', announceDate: '2025-04-30', epsActual: 1.5, epsEstimate: 1.4 },
    ]);
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    const peg = body.components.find((c: any) => c.name.startsWith('PEG'));
    expect(peg.noData).toBe(true);
    expect(peg.noDataReason).toBeTruthy();
    // Earnings-quality component should still have data (from earnings history).
    const earn = body.components.find((c: any) => c.name === 'Earnings Quality');
    expect(earn.noData).toBeFalsy();
  });

  it('sets a short browser cache header', async () => {
    getFundamentalsMock.mockResolvedValue(strongFundamentals());
    getPreviousCloseMock.mockResolvedValue({ t: 0, o: 90, h: 92, l: 89, c: 90, v: 1 });
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).headers['Cache-Control']).toMatch(/max-age=/);
  });
});
