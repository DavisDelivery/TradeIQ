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
import { useStockDetailsFanout, FANOUT_EAGER_ROWS } from '../useStockDetailsFanout.js';
import { FundamentalsStrip } from '../../components/detail/FundamentalsStrip.jsx';

// Handler-realistic fixture: stock-detail.ts emits metrics.profitability
// uniformly PERCENT-scaled (roe 1.535 fraction → 153.5). The old fixture's
// roe: 1.5 contradicted KeyMetricsPanel's 153.5 for the same hypothetical
// company (code-review-2026-06 M3 fixture reconciliation).
const body = (ticker) => ({
  ok: true, ticker,
  metrics: {
    valuation: { pe: 29.4, ps: 8.1, pb: null, evEbitda: null, marketCap: 3.5e12 },
    profitability: { roe: 153.5, roa: 28.2, grossMargin: 44, opMargin: 31, netMargin: 24, eps: 1.64 },
    health: { debtEquity: 1.42 },
    market: {},
  },
});

function Probe({ tickers, options }) {
  const { metricsByTicker } = useStockDetailsFanout(tickers, options);
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

  // code-review-2026-06 M6 — the fan-out must not fire one /api/stock-detail
  // per visible row on board load (50 rows × ~10 server-side providers).
  // Eager fetches are capped; rows beyond the cap stay lazy (they are filled
  // by FundamentalsStrip's in-viewport fetch via the shared query key, or by
  // lifting the cap when the user sorts on a fan-out column).
  it('caps eager fetches at eagerCount; remaining tickers stay lazy', async () => {
    const seen = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const t = new URL(String(u), 'http://x').searchParams.get('ticker');
      seen.push(t);
      return { ok: true, status: 200, json: async () => body(t) };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    render(
      <QueryClientProvider client={qc}>
        <Probe tickers={['AAPL', 'NVDA', 'MSFT', 'AMZN', 'GOOG']} options={{ eagerCount: 2 }} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    // Give any stray queries a beat to fire before pinning the count.
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['AAPL', 'NVDA']); // first N in row order only
  });

  it('defaults the eager cap to FANOUT_EAGER_ROWS', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const t = new URL(String(u), 'http://x').searchParams.get('ticker');
      return { ok: true, status: 200, json: async () => body(t) };
    });
    const tickers = Array.from({ length: FANOUT_EAGER_ROWS + 10 }, (_, i) => `T${i}`);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    render(
      <QueryClientProvider client={qc}>
        <Probe tickers={tickers} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(FANOUT_EAGER_ROWS));
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).toHaveBeenCalledTimes(FANOUT_EAGER_ROWS);
  });

  it('beyond-cap tickers still surface data already in the shared cache', async () => {
    // A row past the eager cap whose detail was fetched elsewhere (e.g. its
    // FundamentalsStrip scrolled into view) must light up in
    // metricsByTicker without its own fetch.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const t = new URL(String(u), 'http://x').searchParams.get('ticker');
      return { ok: true, status: 200, json: async () => body(t) };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    // Pre-populate MSFT as if FundamentalsStrip had fetched it.
    qc.setQueryData(['tradeiq', 'stockDetail', 'MSFT'], body('MSFT'));
    const { getByTestId } = render(
      <QueryClientProvider client={qc}>
        <Probe tickers={['AAPL', 'NVDA', 'MSFT']} options={{ eagerCount: 1 }} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const map = JSON.parse(getByTestId('metrics').textContent);
      expect(Object.keys(map).sort()).toEqual(['AAPL', 'MSFT']);
    });
    // Only AAPL actually hit the network.
    expect(spy).toHaveBeenCalledTimes(1);
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
