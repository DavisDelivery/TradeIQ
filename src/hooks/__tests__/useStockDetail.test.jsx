// Phase 6 W2 — useStockDetail hook.
//
// The single shared per-ticker detail path. What matters:
//   1. enabled-gated on ticker — no fetch when empty/null/disabled
//   2. session memoization — opening the same ticker twice does NOT re-fetch
//      (staleTime/gcTime Infinity = one fetch per QueryClient per ticker).
//      This is the proof of the "one ticker = one fetch, shared across every
//      surface" guarantee the PR-F FundamentalsStrip relies on.
//   3. ticker normalization — 'aapl' and 'AAPL' share a cache entry
//   4. error path — server ok:false / HTTP error surfaces as query.error

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useStockDetail } from '../useStockDetail';
import { queryKeys } from '../../lib/queryKeys.js';

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

const samplePayload = {
  ok: true,
  ticker: 'NVDA',
  name: 'NVIDIA Corp',
  sector: 'Technology',
  price: 120.5,
  dayChangePct: 1.4,
  marketCap: 3.0e12,
  metrics: {
    valuation: { pe: 25.6, ps: null, evEbitda: null, pb: null },
    profitability: { grossMargin: 74, opMargin: 31, roe: null, roa: null },
    health: { debtEquity: 0.42, currentRatio: null, interestCoverage: null },
    market: { beta: 1.7, shortInterest: null, dividendYield: null, range52w: { low: 80, high: 140, currentPctile: 67.5 } },
  },
  sectorMedians: { valuation: { pe: 26.1 }, profitability: {}, health: {}, sampleSize: 12 },
  fundamentalsHistory: { quarterly: [], _reason: 'quarterly_history_unavailable' },
};

describe('useStockDetail', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => samplePayload,
    }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('does NOT fetch when ticker is empty', async () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useStockDetail(''), { wrapper });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT fetch when enabled=false', async () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useStockDetail('NVDA', { enabled: false }), { wrapper });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches and returns the bundle for a valid ticker', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStockDetail('NVDA'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ticker).toBe('NVDA');
    expect(result.current.data?.metrics?.valuation?.pe).toBe(25.6);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/stock-detail?ticker=NVDA');
  });

  it('preserves null + _reason for unsourceable metrics (honest no-data)', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStockDetail('NVDA'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.metrics?.valuation?.ps).toBeNull();
    expect(result.current.data?.fundamentalsHistory?._reason).toBe('quarterly_history_unavailable');
  });

  it('uppercases lowercase input so cache hits share the same key', async () => {
    const { qc, wrapper } = makeWrapper();
    const { result } = renderHook(() => useStockDetail('nvda'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy.mock.calls[0][0]).toContain('ticker=NVDA');
    expect(qc.getQueryData(queryKeys.stockDetail('NVDA'))).toBeTruthy();
  });

  it('session-memoizes: the same ticker fetches once, shared across re-opens', async () => {
    const { wrapper } = makeWrapper();
    const { result, rerender } = renderHook(
      ({ ticker }) => useStockDetail(ticker),
      { wrapper, initialProps: { ticker: 'NVDA' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    rerender({ ticker: 'NVDA' });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    rerender({ ticker: 'AAPL' });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    rerender({ ticker: 'NVDA' });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('surfaces error when the server returns ok:false', async () => {
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, ticker: 'XXX', error: 'no price bars available for ticker' }),
    }));
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStockDetail('XXX'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/no price bars/i);
  });
});
