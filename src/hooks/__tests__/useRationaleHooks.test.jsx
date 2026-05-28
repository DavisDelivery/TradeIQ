// Phase 6 W2 — useWilliamsRationale / useLynchRationale hooks + the shared
// cross-surface dedupe guarantee.
//
// The two rationale hooks mirror useTargetRationale (proven separately). Here
// we assert each hits its own endpoint, normalizes the ticker, and surfaces
// errors — plus the load-bearing guarantee for the whole "fundamentals on
// every surface" workstream: two independent consumers of the SAME ticker
// against ONE QueryClient produce exactly ONE network fetch (no per-tab /
// per-surface duplicate fetching).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useWilliamsRationale } from '../useWilliamsRationale';
import { useLynchRationale } from '../useLynchRationale';
import { useStockDetail } from '../useStockDetail';

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

describe('useWilliamsRationale', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ticker: 'NVDA', score: -3, direction: 'neutral', thesis: 'No actionable Williams setup.', components: [], riskCallouts: [] }),
    }));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('hits /api/williams-rationale and returns the thesis', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useWilliamsRationale('nvda'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/williams-rationale?ticker=NVDA');
    expect(result.current.data?.thesis).toMatch(/Williams/);
  });

  it('does NOT fetch when disabled', async () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useWilliamsRationale('NVDA', { enabled: false }), { wrapper });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useLynchRationale', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ticker: 'AAPL', score: 90, direction: 'long', thesis: 'GARP thesis.', components: [], riskCallouts: [] }),
    }));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('hits /api/lynch-rationale and returns the thesis', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useLynchRationale('AAPL'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/lynch-rationale?ticker=AAPL');
    expect(result.current.data?.thesis).toMatch(/GARP/);
  });

  it('surfaces HTTP error status', async () => {
    fetchSpy.mockImplementation(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useLynchRationale('XXX'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain('404');
  });
});

describe('shared fundamentals path — no duplicate per-surface fetches', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ticker: 'NVDA', metrics: {}, sectorMedians: {} }),
    }));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('two consumers of the same ticker share ONE fetch', async () => {
    const { wrapper } = makeWrapper();
    // Two independent components (simulating two surfaces) requesting the same
    // ticker's detail through the shared hook against one QueryClient.
    const a = renderHook(() => useStockDetail('NVDA'), { wrapper });
    const b = renderHook(() => useStockDetail('NVDA'), { wrapper });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
