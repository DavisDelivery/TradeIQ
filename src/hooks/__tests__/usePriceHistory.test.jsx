// Phase 6 PR-C — usePriceHistory hook tests.
//
// Pins the single-shared-fetch contract: two consumers of the same
// (ticker, range) share exactly one network call across the QueryClient
// lifetime. Different ranges → distinct fetches. Different tickers →
// distinct fetches. Mirrors the discipline established by useStockDetail.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { usePriceHistory } from '../usePriceHistory.js';

function Consumer({ ticker, range }) {
  const q = usePriceHistory(ticker, range);
  return <div data-testid="state">{q.isLoading ? 'loading' : q.isError ? 'error' : q.data ? `ok:${q.data.bars?.length ?? 0}` : 'idle'}</div>;
}

function renderTwo({ a, b }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={qc}>
      <Consumer ticker={a.ticker} range={a.range} />
      <Consumer ticker={b.ticker} range={b.range} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('usePriceHistory', () => {
  it('two consumers of the same (ticker, range) share a single fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => ({
      ok: true, status: 200, json: async () => ({ ok: true, ticker: 'AAPL', range: '6M', bars: [{ date: '2026-01-01', open: 1, high: 1, low: 1, close: 1, volume: 1 }] }),
    }));
    const { findAllByTestId } = renderTwo({ a: { ticker: 'AAPL', range: '6M' }, b: { ticker: 'AAPL', range: '6M' } });
    const states = await findAllByTestId('state');
    await waitFor(() => states.forEach((s) => expect(s.textContent).toMatch(/^ok:/)));
    expect(spy).toHaveBeenCalledTimes(1);
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toMatch(/ticker=AAPL/);
    expect(urls[0]).toMatch(/range=6M/);
  });

  it('different ranges produce distinct fetches', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const range = new URL(String(u), 'http://x').searchParams.get('range');
      return { ok: true, status: 200, json: async () => ({ ok: true, ticker: 'AAPL', range, bars: [] }) };
    });
    renderTwo({ a: { ticker: 'AAPL', range: '1M' }, b: { ticker: 'AAPL', range: '1Y' } });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const ranges = spy.mock.calls.map((c) => new URL(String(c[0]), 'http://x').searchParams.get('range'));
    expect(ranges.sort()).toEqual(['1M', '1Y']);
  });

  it('different tickers produce distinct fetches', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const ticker = new URL(String(u), 'http://x').searchParams.get('ticker');
      return { ok: true, status: 200, json: async () => ({ ok: true, ticker, range: '6M', bars: [] }) };
    });
    renderTwo({ a: { ticker: 'AAPL', range: '6M' }, b: { ticker: 'NVDA', range: '6M' } });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('skips the fetch when ticker is empty', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    function Empty() { const q = usePriceHistory('', '6M'); return <span>{q.isLoading ? 'l' : 'i'}</span>; }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><Empty /></QueryClientProvider>);
    expect(spy).not.toHaveBeenCalled();
  });
});
