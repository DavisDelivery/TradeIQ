import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useBacktestRuns } from '../useBacktestRuns';
import { useBacktestRun } from '../useBacktestRun';

// Phase 4b hook tests. Same shape as useTargetBoard tests — representative
// behavior, not exhaustive. Three things matter:
//
//   1. queryFn fetches the right URL and unwraps the payload
//   2. error responses surface as `query.error` with a useful message
//   3. useBacktestRun only fires when runId is truthy (enabled gate)

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

// Build a Response-shaped object that hooks expecting `headers.get('content-type')`
// can consume. Mocking the whole Headers class is overkill for tests.
function jsonResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const sampleListPayload = {
  ok: true,
  runs: [
    {
      runId: 'bt_a',
      config: { universe: 'dow', board: 'prophet', rebalanceFrequency: 'monthly' },
      status: 'complete',
      completedAt: '2026-05-11T16:00:00.000Z',
      metrics: { totalReturnPct: 7.3, sharpe: 0.224, tradeCount: 350 },
      universeSurvivorshipCorrected: { universe: 'dow', corrected: true, coverageThrough: '2018-01-31' },
      benchmark: { ticker: 'SPY', totalReturnPct: 12.4 },
      warnings: [],
    },
    {
      runId: 'bt_b',
      config: { universe: 'sp500', board: 'prophet', rebalanceFrequency: 'monthly' },
      status: 'complete',
      completedAt: '2026-05-10T16:00:00.000Z',
      metrics: { totalReturnPct: 12.5, sharpe: 0.7, tradeCount: 200 },
      universeSurvivorshipCorrected: { universe: 'sp500', corrected: false, coverageThrough: null },
      benchmark: null,
      warnings: ['sp500 universe is uncorrected'],
    },
  ],
  generatedAt: '2026-05-11T20:00:00.000Z',
};

describe('useBacktestRuns', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(sampleListPayload),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('happy path: fetches the list endpoint and returns runs in payload order', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRuns(20), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.runs).toHaveLength(2);
    expect(result.current.data?.runs[0].runId).toBe('bt_a');
    expect(result.current.data?.runs[1].universeSurvivorshipCorrected.corrected).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/backtest-runs?limit=20');
  });

  it('passes the limit param through to the URL', async () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useBacktestRuns(5), { wrapper });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/backtest-runs?limit=5');
  });

  it('returns an empty runs array when the endpoint omits the field', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ ok: true, generatedAt: '2026-05-11T20:00:00.000Z' }));
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRuns(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.runs).toEqual([]);
  });

  it('surfaces a 500 from the server as a hook error', async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ error: 'firestore_unavailable' }, { status: 500 }),
    );
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRuns(20), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('firestore_unavailable');
  });
});

const sampleDetailPayload = {
  ok: true,
  run: {
    runId: 'bt_a',
    config: { universe: 'dow', board: 'prophet' },
    status: 'complete',
    metrics: { totalReturnPct: 7.3 },
    universeSurvivorshipCorrected: { universe: 'dow', corrected: true, coverageThrough: '2018-01-31' },
    warnings: [],
    benchmark: null,
  },
  dailyEquity: [
    { date: '2020-01-01', value: 100000 },
    { date: '2020-01-02', value: 100500 },
  ],
  trades: [{ rebalanceDate: '2020-01-01', ticker: 'AAPL' }],
  attribution: [{ rebalanceDate: '2020-01-01', ticker: 'AAPL', layers: { momentum: 70 } }],
  mlTrainingCount: 12,
  generatedAt: '2026-05-11T20:00:00.000Z',
};

describe('useBacktestRun', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(sampleDetailPayload),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('does NOT fetch when runId is falsy', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRun(null), { wrapper });
    // Synchronous-ish: with retry off and no fetch, status stays 'pending'
    // and isLoading is false because the query is disabled.
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches the detail endpoint when runId is set and unwraps subcollections', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRun('bt_a'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.run.runId).toBe('bt_a');
    expect(result.current.data?.dailyEquity).toHaveLength(2);
    expect(result.current.data?.trades).toHaveLength(1);
    expect(result.current.data?.attribution).toHaveLength(1);
    expect(result.current.data?.mlTrainingCount).toBe(12);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/backtest-runs/bt_a');
  });

  it('URL-encodes the runId', async () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useBacktestRun('bt with spaces'), { wrapper });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/backtest-runs/bt%20with%20spaces');
  });

  it('surfaces 404 from the server as a hook error', async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ error: 'run not found' }, { status: 404 }),
    );
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRun('bt_missing'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('run not found');
  });
});

// Phase 4b-2 — poll-while-incomplete behavior added to useBacktestRun.
//
// The refetchInterval callback inspects query.state.data?.run?.status
// and returns 5000 for pending/running, false otherwise. We verify the
// transition by varying the mocked status across successive fetches and
// using vitest's fake timers to advance the 5-second interval.

describe('useBacktestRun polling', () => {
  let fetchSpy;
  const statusSequence = []; // pop values as the hook re-fetches
  beforeEach(() => {
    statusSequence.length = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const status = statusSequence.shift() ?? 'complete';
      return jsonResponse({
        ok: true,
        run: { runId: 'bt_poll', status },
        dailyEquity: [],
        trades: [],
        attribution: [],
        mlTrainingCount: 0,
      });
    });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('refetches every ~5s while status is pending or running, stops on complete', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    statusSequence.push('pending', 'running', 'complete');
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRun('bt_poll'), { wrapper });

    // First fetch: status=pending
    await waitFor(() => expect(result.current.data?.run.status).toBe('pending'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance 5s → triggers second fetch (running). Wrap in act() because
    // TanStack's internal refetch fires a React state update; without
    // act() React warns even though the assertion below settles on the
    // post-update value correctly.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await waitFor(() => expect(result.current.data?.run.status).toBe('running'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Advance 5s → triggers third fetch (complete)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await waitFor(() => expect(result.current.data?.run.status).toBe('complete'));
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Advance 30s → polling should be OFF now. No more fetches.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does NOT poll a terminal-state run (status=complete on first fetch)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    statusSequence.push('complete');
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRun('bt_done'), { wrapper });
    await waitFor(() => expect(result.current.data?.run.status).toBe('complete'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
