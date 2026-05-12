import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useStartBacktest } from '../useStartBacktest';
import { queryKeys } from '../../lib/queryKeys.js';

// Phase 4b-2 — mutation-hook tests.
//
// Three contracts:
//   1. Happy path: POST → 202 → mutation.data carries { ok, runId },
//      backtestRuns list query was invalidated.
//   2. 409 conflict: error.status === 409 and error.runId is set so
//      the launcher UI can deep-link to the existing run.
//   3. 400 validation: error.message is the server's validation
//      string, no runId.

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
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

const config = {
  universe: 'dow',
  startDate: '2018-01-01',
  endDate: '2018-04-01',
  rebalanceFrequency: 'monthly',
  board: 'prophet',
  portfolio: { topN: 10, weighting: 'equal', maxPositionPct: 0.1, maxSectorPct: 0.4, cashSleeve: 0.05, minComposite: 50 },
  costs: { slippageBps: { dow: 3 }, commission: 0 },
  initialCapital: 10000,
};

describe('useStartBacktest', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('happy path: POSTs to /api/backtest-runs, returns 202 with runId, invalidates list query', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ ok: true, runId: 'bt_test_001' }, { status: 202 }));
    const { qc, wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useStartBacktest(), { wrapper });
    result.current.mutate(config);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ ok: true, runId: 'bt_test_001' });

    // Fetch shape
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/backtest-runs/start');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(config);

    // List query invalidation fired
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.backtestRuns(20) });
  });

  it('409 conflict: error.status=409 + error.runId set so caller can deep-link', async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse(
        { ok: false, error: 'A backtest is already running (runId: bt_existing).', runId: 'bt_existing' },
        { status: 409 },
      ),
    );
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStartBacktest(), { wrapper });
    result.current.mutate(config);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toMatch(/already running/i);
    expect(result.current.error.status).toBe(409);
    expect(result.current.error.runId).toBe('bt_existing');
  });

  it('400 validation: error.message echoes server text, no runId', async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse(
        { ok: false, error: 'BacktestConfig: startDate 2017-06-01 is before 2018-01-01.' },
        { status: 400 },
      ),
    );
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStartBacktest(), { wrapper });
    result.current.mutate({ ...config, startDate: '2017-06-01' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toMatch(/before 2018-01-01/);
    expect(result.current.error.status).toBe(400);
    expect(result.current.error.runId).toBeUndefined();
  });

  it('non-JSON 500: surfaces a generic error rather than crashing on JSON.parse', async () => {
    // Build a non-JSON response (e.g. HTML error page from a gateway).
    fetchSpy.mockImplementation(async () => ({
      ok: false,
      status: 502,
      headers: { get: () => 'text/html' },
      text: async () => '<html><body>Bad Gateway</body></html>',
      json: async () => { throw new Error('not json'); },
    }));
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStartBacktest(), { wrapper });
    result.current.mutate(config);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toMatch(/HTTP 502/);
    expect(result.current.error.status).toBe(502);
  });
});
