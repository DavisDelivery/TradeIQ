import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useTargetBoard } from '../useTargetBoard';
import { queryKeys } from '../../lib/queryKeys';

// Hook integration tests are notoriously fragile per the brief; we keep
// these representative rather than exhaustive. The three behaviors that
// matter for every board hook in this app:
//
//   1. queryFn parses the response shape (validates) and returns it
//   2. forceRescan replaces cache via setQueryData (NOT refetch) — the
//      whole point of force-rescan is the user wanted THIS response, not
//      a refetch round-trip
//   3. error responses surface as `query.error` with a useful message

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,                 // tests want determinism
        staleTime: Infinity,           // tests don't want background refetches
      },
    },
  });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

const sampleResponse = {
  targets: [
    { ticker: 'AAPL', tier: 'A', score: 88, direction: 'long' },
    { ticker: 'MSFT', tier: 'B', score: 72, direction: 'long' },
  ],
  source: 'snapshot',
  generatedAt: '2026-05-08T20:00:00Z',
  universe: 'sp500',
  universeSize: 500,
  tickersScanned: 500,
  cached: true,
};

describe('useTargetBoard', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => sampleResponse,
    }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('happy path: fetches, validates, and returns target board data', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTargetBoard('sp500'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.targets).toHaveLength(2);
    expect(result.current.data?.universe).toBe('sp500');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/target-board');
    expect(fetchSpy.mock.calls[0][0]).toContain('universe=sp500');
  });

  it('forceRescan replaces cache via setQueryData and does NOT trigger a refetch', async () => {
    const { qc, wrapper } = makeWrapper();
    const { result } = renderHook(() => useTargetBoard('sp500'), { wrapper });

    // Wait for initial load (1 fetch)
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Force-rescan: returns a different payload, fetch fires once with
    // force=1, and the cache is replaced — but the hook itself doesn't
    // bounce through a refetch (no extra calls beyond the one inside
    // forceRescan).
    const freshPayload = { ...sampleResponse, generatedAt: '2026-05-08T21:00:00Z', cached: false };
    fetchSpy.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => freshPayload,
    }));

    await act(async () => {
      await result.current.forceRescan();
    });

    // Total fetches: initial load + the single force call. NO refetch.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toContain('force=1');

    // Cache contains the fresh payload
    const cached = qc.getQueryData(queryKeys.targetBoard('sp500'));
    expect(cached?.generatedAt).toBe('2026-05-08T21:00:00Z');
    expect(cached?.cached).toBe(false);
  });

  it('surfaces error from server JSON `error` field', async () => {
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: 'circuit_breaker_open' }),
    }));

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTargetBoard('sp500'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('circuit_breaker_open');
  });

  it('surfaces HTTP error status', async () => {
    // 500 (not 502/503/504) — fetchWithRetry only retries on 502/503/504,
    // so this gives us a single deterministic failure.
    fetchSpy.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTargetBoard('sp500'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain('500');
  });

  it('different universes use different cache entries', async () => {
    const { qc, wrapper } = makeWrapper();
    const { result, rerender } = renderHook(
      ({ universe }) => useTargetBoard(universe),
      { wrapper, initialProps: { universe: 'sp500' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ universe: 'ndx' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Two distinct cache keys; both populated. We verify cache state
    // (which is deterministic) rather than fetch call count, since
    // StrictMode's double-effect can vary the count between dev and
    // prod-mode runs.
    expect(qc.getQueryData(queryKeys.targetBoard('sp500'))).toBeDefined();
    expect(qc.getQueryData(queryKeys.targetBoard('ndx'))).toBeDefined();
    expect(fetchSpy.mock.calls.some((c) => c[0].includes('universe=sp500'))).toBe(true);
    expect(fetchSpy.mock.calls.some((c) => c[0].includes('universe=ndx'))).toBe(true);
  });
});
