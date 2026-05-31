// Phase 6 PR-G — useStockDetailsFanout: cross-consumer dedup contract.
//
// Pins that the fan-out shares query keys with useStockDetail so two
// surfaces of the same ticker (e.g. a row's FundamentalsStrip AND the
// board's sortable fundamentals columns derived from the fan-out) share
// ONE network call. Different tickers fan out cleanly.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useStockDetailsFanout } from '../useStockDetailsFanout.js';
import { FundamentalsStrip } from '../../components/detail/FundamentalsStrip.jsx';

const body = (ticker) => ({
  ok: true, ticker,
  metrics: {
    valuation: { pe: 29.4, ps: 8.1, pb: null, evEbitda: null, marketCap: 3.5e12 },
    profitability: { roe: 1.5, roa: null, grossMargin: 44, opMargin: 31, netMargin: 24, eps: 1.64 },
    health: { debtEquity: 1.42 },
    market: {},
  },
});

function Probe({ tickers }) {
  const { metricsByTicker } = useStockDetailsFanout(tickers);
  return <pre data-testid="metrics">{JSON.stringify(metricsByTicker, null, 0)}</pre>;
}

afterEach(() => vi.restoreAllMocks());

describe('useStockDetailsFanout', () => {
  it('fans out distinct fetches per ticker', async () => {
    const seen = new Set();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const t = new URL(String(u), 'http://x').searchParams.get('ticker');
      seen.add(t);
      return { ok: true, status: 200, json: async () => body(t) };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    render(
      <QueryClientProvider client={qc}>
        <Probe tickers={['AAPL', 'NVDA', 'MSFT']} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    expect(Array.from(seen).sort()).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('shares a single fetch with FundamentalsStrip for the same ticker', async () => {
    delete globalThis.IntersectionObserver; // FundamentalsStrip falls through to eager fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true, status: 200, json: async () => body('AAPL'),
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    render(
      <QueryClientProvider client={qc}>
        <Probe tickers={['AAPL']} />
        <FundamentalsStrip ticker="AAPL" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  it('de-dupes and uppercases input tickers', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const t = new URL(String(u), 'http://x').searchParams.get('ticker');
      return { ok: true, status: 200, json: async () => body(t) };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Probe tickers={['aapl', 'AAPL', ' aapl ', 'nvda']} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const tickers = spy.mock.calls.map((c) => new URL(String(c[0]), 'http://x').searchParams.get('ticker'));
    expect(tickers.sort()).toEqual(['AAPL', 'NVDA']);
  });
});
