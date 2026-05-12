import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useBacktestRuns } from '../useBacktestRuns.js';
import { useBacktestRun } from '../useBacktestRun.js';

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
      },
    },
  });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

const sampleListResponse = {
  ok: true,
  count: 2,
  runs: [
    {
      runId: 'bt_2026_a',
      config: { universe: 'dow', cadence: 'monthly' },
      metrics: { totalReturn: 0.0730, sharpe: 0.224, trades: 350 },
      universeSurvivorshipCorrected: { universe: 'dow', corrected: true },
      completedAt: '2026-05-11T15:57:22Z',
      status: 'complete',
      warnings: [],
    },
    {
      runId: 'bt_2026_b',
      config: { universe: 'sp500', cadence: 'monthly' },
      metrics: { totalReturn: 0.05, sharpe: 0.18, trades: 280 },
      universeSurvivorshipCorrected: { universe: 'sp500', corrected: false },
      completedAt: '2026-05-10T15:00:00Z',
      status: 'complete',
      warnings: [],
    },
  ],
};

const sampleDetailResponse = {
  ok: true,
  run: {
    runId: 'bt_2026_a',
    config: { universe: 'dow', cadence: 'monthly' },
    metrics: { totalReturn: 0.0730, sharpe: 0.224, trades: 350 },
    universeSurvivorshipCorrected: { universe: 'dow', corrected: true },
  },
  dailyEquity: [{ date: '2018-01-01', value: 100000 }],
  trades: [],
  tradesTruncated: false,
  attribution: [],
  mlTrainingCount: 0,
};

describe('useBacktestRuns', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => sampleListResponse,
    }));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('fetches /api/backtest-runs and returns the response', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRuns(20), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.runs).toHaveLength(2);
    expect(result.current.data.runs[0].runId).toBe('bt_2026_a');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/backtest-runs?limit=20',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('surfaces HTTP errors via the error field', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'Firestore unavailable' }),
    });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRuns(20), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(String(result.current.error?.message)).toContain('Firestore unavailable');
  });
});

describe('useBacktestRun', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => sampleDetailResponse,
    }));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('fetches /api/backtest-runs/:runId when runId is set', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRun('bt_2026_a'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.run.runId).toBe('bt_2026_a');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/backtest-runs/bt_2026_a',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('does not fetch when runId is null/falsy', () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRun(null), { wrapper });
    expect(result.current.isFetching).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces 404 with a readable error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: 'run not found' }),
    });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBacktestRun('nonexistent'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(String(result.current.error?.message)).toContain('run not found');
  });
});
