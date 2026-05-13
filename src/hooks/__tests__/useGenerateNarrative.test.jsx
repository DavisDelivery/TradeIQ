// Tests for the useGenerateNarrative mutation hook (4c-1 W3).
//
// Contract:
//   1. On success, the mutation calls /api/prophet-narrate and patches every
//      cached prophet query that contains the ticker, so a re-render shows
//      the narrative inline without a refetch.
//   2. On 429, error.message === 'rate_limit' so the UI can surface a
//      distinct message.
//   3. On 500, error.message is the server's error code (e.g.
//      'narration_unavailable').

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useGenerateNarrative } from '../useGenerateNarrative.js';
import { queryKeys } from '../../lib/queryKeys.js';

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

const pick = {
  ticker: 'AAPL',
  composite: 75,
  layers: { momentum: { score: 80, pass: true, details: {} } },
  conviction: 'HIGH',
  flags: [],
};

describe('useGenerateNarrative', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('POSTs to /api/prophet-narrate and returns the narrative on success', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ok: true, ticker: 'AAPL', narrative: 'Big move ahead.', cached: false }),
    );

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useGenerateNarrative(), { wrapper });

    let mutationResult;
    await act(async () => {
      mutationResult = await result.current.mutateAsync(pick);
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/prophet-narrate');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.ticker).toBe('AAPL');
    expect(body.composite).toBe(75);

    expect(mutationResult).toMatchObject({
      ticker: 'AAPL',
      narrative: 'Big move ahead.',
      cached: false,
    });
  });

  it('patches every prophet query in the cache after success', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ok: true, ticker: 'AAPL', narrative: 'New thesis.', cached: false }),
    );

    const { qc, wrapper } = makeWrapper();

    // Seed two prophet queries with overlapping picks
    qc.setQueryData(queryKeys.prophet('largecap', 'all'), {
      picks: [
        { ticker: 'AAPL', narrative: null, composite: 75 },
        { ticker: 'MSFT', narrative: null, composite: 70 },
      ],
    });
    qc.setQueryData(queryKeys.prophet('all', 'all'), {
      picks: [
        { ticker: 'AAPL', narrative: null, composite: 76 },
        { ticker: 'GOOG', narrative: null, composite: 65 },
      ],
    });

    const { result } = renderHook(() => useGenerateNarrative(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(pick);
    });

    const largecap = qc.getQueryData(queryKeys.prophet('largecap', 'all'));
    const all = qc.getQueryData(queryKeys.prophet('all', 'all'));

    expect(largecap.picks.find((p) => p.ticker === 'AAPL').narrative).toBe('New thesis.');
    expect(largecap.picks.find((p) => p.ticker === 'MSFT').narrative).toBeNull();

    expect(all.picks.find((p) => p.ticker === 'AAPL').narrative).toBe('New thesis.');
    expect(all.picks.find((p) => p.ticker === 'GOOG').narrative).toBeNull();
  });

  it('surfaces rate_limit on 429', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: 'rate_limit' }, { status: 429 }),
    );

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useGenerateNarrative(), { wrapper });

    await act(async () => {
      try {
        await result.current.mutateAsync(pick);
      } catch {
        // expected
      }
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toBe('rate_limit');
  });

  it('surfaces the server error code on 500', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: 'narration_unavailable' }, { status: 500 }),
    );

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useGenerateNarrative(), { wrapper });

    await act(async () => {
      try {
        await result.current.mutateAsync(pick);
      } catch {
        // expected
      }
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toBe('narration_unavailable');
  });
});
