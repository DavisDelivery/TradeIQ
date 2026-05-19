// Phase 4q — useTargetRationale hook.
//
// What matters for this hook:
//   1. enabled-gated on ticker — does NOT fetch when ticker is empty/null
//   2. session memoization — opening the same ticker twice does NOT
//      re-fetch (staleTime: Infinity + gcTime: Infinity = a single
//      fetch per QueryClient lifetime per ticker)
//   3. ticker normalization — lowercase / whitespace coerces to uppercase
//      so 'aapl' and 'AAPL' share a cache entry
//   4. error path — server `ok: false` / HTTP error surfaces as
//      query.error so the UI can render its retry state

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useTargetRationale } from '../useTargetRationale';
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
  composite: 64,
  tier: 'B',
  direction: 'long',
  scoredAt: '2026-05-19T12:00:00.000Z',
  modelVersion: 'v1',
  analysts: [
    {
      analyst: 'technical-analyst',
      score: 72,
      direction: 'long',
      weight: 0.5,
      confidence: 0.6,
      rationale: 'uptrend intact',
      signals: { ema20: 100 },
    },
  ],
};

describe('useTargetRationale', () => {
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
    renderHook(() => useTargetRationale(''), { wrapper });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT fetch when enabled=false', async () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useTargetRationale('NVDA', { enabled: false }), { wrapper });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches and returns the payload for a valid ticker', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTargetRationale('NVDA'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ticker).toBe('NVDA');
    expect(result.current.data?.analysts).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/target-rationale?ticker=NVDA');
  });

  it('uppercases lowercase input so cache hits share the same key', async () => {
    const { qc, wrapper } = makeWrapper();
    const { result } = renderHook(() => useTargetRationale('nvda'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchSpy.mock.calls[0][0]).toContain('ticker=NVDA');
    // Cache landed under the canonical key.
    expect(qc.getQueryData(queryKeys.targetRationale('NVDA'))).toBeTruthy();
  });

  it('session-memoizes: the same ticker fetches once per session', async () => {
    const { wrapper } = makeWrapper();
    const { result, rerender } = renderHook(
      ({ ticker }) => useTargetRationale(ticker),
      { wrapper, initialProps: { ticker: 'NVDA' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Re-render with the same ticker — no extra fetch.
    rerender({ ticker: 'NVDA' });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Re-render with a different ticker — one new fetch.
    rerender({ ticker: 'AAPL' });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    // Back to NVDA — still no extra fetch (gcTime: Infinity).
    rerender({ ticker: 'NVDA' });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('surfaces error when the server returns ok: false', async () => {
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, ticker: 'XXX', error: 'no bars available' }),
    }));
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTargetRationale('XXX'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/no bars/i);
  });

  it('surfaces HTTP error status', async () => {
    fetchSpy.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTargetRationale('NVDA'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain('500');
  });
});
