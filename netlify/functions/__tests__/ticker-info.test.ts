// Phase 4j W2 — /api/ticker-info endpoint contract tests.
//
// Hermetic — the underlying getTickerInfo() is mocked. We're testing the
// HTTP shape (status, headers, body), not the cache/Polygon path
// (that's covered by ticker-reference.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTickerInfoMock = vi.fn();

vi.mock('../shared/ticker-reference', () => ({
  getTickerInfo: (...args: unknown[]) => getTickerInfoMock(...args),
}));

vi.mock('../shared/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { handler } from '../ticker-info';

function evt(qs: Record<string, string> = {}) {
  return {
    httpMethod: 'GET',
    queryStringParameters: qs,
    headers: {},
    body: null,
  } as any;
}

beforeEach(() => {
  getTickerInfoMock.mockReset();
});

describe('GET /api/ticker-info', () => {
  it('returns 400 when ticker is missing', async () => {
    const res = await handler(evt({}), {} as any, () => {});
    expect((res as any).statusCode).toBe(400);
    const body = JSON.parse((res as any).body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/ticker required/i);
    expect(getTickerInfoMock).not.toHaveBeenCalled();
  });

  it('uppercases the ticker before looking it up', async () => {
    getTickerInfoMock.mockResolvedValue({
      ticker: 'AAPL',
      name: 'Apple Inc.',
      description: 'desc',
      homepageUrl: null,
      logoUrl: null,
      iconUrl: null,
      employees: null,
      marketCap: null,
      listDate: null,
      industry: null,
    });
    const res = await handler(evt({ ticker: 'aapl' }), {} as any, () => {});
    expect(getTickerInfoMock).toHaveBeenCalledWith('AAPL');
    expect((res as any).statusCode).toBe(200);
  });

  it('returns the full info on a successful lookup', async () => {
    getTickerInfoMock.mockResolvedValue({
      ticker: 'AAPL',
      name: 'Apple Inc.',
      description: 'Apple designs and sells consumer electronics.',
      homepageUrl: 'https://www.apple.com',
      logoUrl: 'https://api.polygon.io/logo.svg?apiKey=k',
      iconUrl: null,
      employees: 164000,
      marketCap: 3000000000000,
      listDate: '1980-12-12',
      industry: 'ELECTRONIC COMPUTERS',
    });
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body.ok).toBe(true);
    expect(body.ticker).toBe('AAPL');
    expect(body.name).toBe('Apple Inc.');
    expect(body.description).toContain('Apple');
    expect(body.employees).toBe(164000);
    expect(body.marketCap).toBe(3000000000000);
    expect(body.listDate).toBe('1980-12-12');
    expect(body.industry).toBe('ELECTRONIC COMPUTERS');
    expect(body.logoUrl).toContain('apiKey=');
  });

  it('returns 404 when the ticker cannot be resolved at all', async () => {
    // Should only happen for a name-resolution failure, which is very
    // rare (even unknown tickers get a fallback ticker-as-name).
    getTickerInfoMock.mockResolvedValue(null);
    const res = await handler(evt({ ticker: 'NOPE' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(404);
    const body = JSON.parse((res as any).body);
    expect(body.ok).toBe(false);
    expect(body.ticker).toBe('NOPE');
  });

  it('returns 500 on an unexpected error', async () => {
    getTickerInfoMock.mockRejectedValue(new Error('firestore exploded'));
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(500);
    const body = JSON.parse((res as any).body);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('firestore exploded');
  });

  it('returns a graceful name-only payload for a Polygon-unknown ticker', async () => {
    // ticker-reference returns a name-only TickerInfo even when Polygon
    // has nothing. The endpoint passes it through as a 200 - the UI is
    // expected to render its own "description unavailable" empty state.
    getTickerInfoMock.mockResolvedValue({
      ticker: 'OBSCURE',
      name: 'OBSCURE',
      description: null,
      homepageUrl: null,
      logoUrl: null,
      iconUrl: null,
      employees: null,
      marketCap: null,
      listDate: null,
      industry: null,
    });
    const res = await handler(evt({ ticker: 'OBSCURE' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body.ok).toBe(true);
    expect(body.description).toBeNull();
    expect(body.industry).toBeNull();
  });

  it('sets a short browser cache header so repeat opens do not re-hit the function', async () => {
    getTickerInfoMock.mockResolvedValue({
      ticker: 'AAPL',
      name: 'Apple',
      description: null,
      homepageUrl: null,
      logoUrl: null,
      iconUrl: null,
      employees: null,
      marketCap: null,
      listDate: null,
      industry: null,
    });
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    const cc = (res as any).headers['Cache-Control'];
    expect(cc).toMatch(/max-age=/);
  });
});
