// Phase 4f-finish — minimal-fetcher tests for
// polygon-options-snapshot.ts. Hermetic: mocks global fetch with
// fixture Polygon responses; never hits the network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOptionsSnapshot } from '../polygon-options-snapshot';

const ORIG_KEY = process.env.POLYGON_API_KEY;

beforeEach(() => {
  process.env.POLYGON_API_KEY = 'test_key';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIG_KEY == null) delete process.env.POLYGON_API_KEY;
  else process.env.POLYGON_API_KEY = ORIG_KEY;
});

function fixtureResponse(rows: any[], nextUrl?: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results: rows, next_url: nextUrl }),
  } as unknown as Response;
}

function errResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

describe('getOptionsSnapshot', () => {
  it('parses snapshot rows into an OptionsTickWindow with open interest', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fixtureResponse([
        {
          details: { strike_price: 200, expiration_date: '2026-06-19', contract_type: 'call' },
          open_interest: 5000,
          day: { volume: 1200, vwap: 3.5, close: 3.6 },
          last_trade: { sip_timestamp: 1_700_000_000_000_000_000, price: 3.6, size: 100 },
          last_quote: { bid: 3.55, ask: 3.65 },
        },
        {
          details: { strike_price: 210, expiration_date: '2026-06-19', contract_type: 'put' },
          open_interest: 2200,
          day: { volume: 300, vwap: 4.1, close: 4.2 },
        },
      ]),
    );

    const res = await getOptionsSnapshot('NVDA');
    expect(res.window.openInterest.length).toBe(2);
    expect(res.window.openInterest[0].strike).toBe(200);
    expect(res.window.openInterest[0].side).toBe('C');
    expect(res.window.openInterest[0].openInterestToday).toBe(5000);
    // Bootstrap: prevOi defaults to today so no spike.
    expect(res.window.openInterest[0].openInterestPrev).toBe(5000);
    // Only the first row had last_trade; trades length should be 1.
    expect(res.window.trades.length).toBe(1);
    expect(res.window.trades[0].side).toBe('C');
    expect(res.window.trades[0].strike).toBe(200);
    expect(res.oiToday['2026-06-19|200|C']).toBe(5000);
    expect(res.oiToday['2026-06-19|210|P']).toBe(2200);
    expect(res.warnings).toEqual([]);
  });

  it('uses provided prevOiByKey for the openInterestPrev field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fixtureResponse([
        {
          details: { strike_price: 200, expiration_date: '2026-06-19', contract_type: 'call' },
          open_interest: 9000,
        },
      ]),
    );

    const prevOi = { '2026-06-19|200|C': 5000 };
    const res = await getOptionsSnapshot('NVDA', prevOi);
    expect(res.window.openInterest[0].openInterestPrev).toBe(5000);
    expect(res.window.openInterest[0].openInterestToday).toBe(9000);
    // 80% increase — should register as an OI spike downstream.
  });

  it('skips rows missing required fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fixtureResponse([
        { details: { strike_price: 200, expiration_date: '2026-06-19', contract_type: 'call' }, open_interest: 100 },
        { details: { strike_price: 210 /* expiration missing */, contract_type: 'put' }, open_interest: 50 },
        { details: { strike_price: 220, expiration_date: '2026-06-19', contract_type: 'call' } /* OI missing */ },
        { details: { expiration_date: '2026-06-19', contract_type: 'put' }, open_interest: 60 }, // strike missing
        { details: { strike_price: 230, expiration_date: '2026-06-19' /* type missing */ }, open_interest: 70 },
      ]),
    );

    const res = await getOptionsSnapshot('AAPL');
    expect(res.window.openInterest.length).toBe(1);
    expect(res.window.openInterest[0].strike).toBe(200);
  });

  it('returns a warning on HTTP error and surfaces an empty window', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errResponse(429));
    const res = await getOptionsSnapshot('AMD');
    expect(res.window.openInterest).toEqual([]);
    expect(res.window.trades).toEqual([]);
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toMatch(/AMD: HTTP 429/);
  });

  it('paginates via next_url and stops at maxPages', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        fixtureResponse(
          [
            {
              details: { strike_price: 100, expiration_date: '2026-06-19', contract_type: 'call' },
              open_interest: 10,
            },
          ],
          'https://api.polygon.io/v3/snapshot/options/X?cursor=p2',
        ),
      )
      .mockResolvedValueOnce(
        fixtureResponse([
          {
            details: { strike_price: 110, expiration_date: '2026-06-19', contract_type: 'call' },
            open_interest: 20,
          },
        ]),
      );

    const res = await getOptionsSnapshot('X', {}, /* maxPages */ 5);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(res.window.openInterest.length).toBe(2);
    expect(res.pagesFetched).toBe(2);
  });

  it('throws if POLYGON_API_KEY is not set', async () => {
    delete process.env.POLYGON_API_KEY;
    await expect(getOptionsSnapshot('AAPL')).rejects.toThrow(/POLYGON_API_KEY/);
  });
});
