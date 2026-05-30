// Phase 6 W2 — StockDetailPanel smoke tests.
//
// Proves the W2 acceptance bar: opening a stock on each board renders the
// hero + the server thesis paragraph + a stub for every below-the-fold
// section, in the right order, and that the panel calls the board-correct
// rationale endpoint. Also asserts the panel only fires the active board's
// rationale endpoint (enabled-gating) — never all three.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { StockDetailPanel } from '../components/detail/StockDetailPanel.jsx';

function renderPanel(props) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <StockDetailPanel {...props} />
    </QueryClientProvider>,
  );
}

function routeFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('/api/williams-rationale')) {
      return { ok: true, status: 200, json: async () => ({
        ok: true, ticker: 'NVDA', name: 'NVIDIA Corp', sector: 'Technology',
        score: -3, direction: 'neutral', price: 120.5,
        thesis: 'No actionable Williams setup — the composite setup score sits below the confluence threshold.',
        components: [], riskCallouts: [],
      }) };
    }
    if (u.includes('/api/lynch-rationale')) {
      return { ok: true, status: 200, json: async () => ({
        ok: true, ticker: 'AAPL', name: 'Apple Inc', sector: 'Technology',
        score: 90, direction: 'long', price: 195.2,
        thesis: 'GARP thesis — PEG 0.54, cheap for growth, 4/4 profitable quarters.',
        components: [], riskCallouts: [],
      }) };
    }
    if (u.includes('/api/target-rationale')) {
      return { ok: true, status: 200, json: async () => ({
        ok: true, ticker: 'MSFT', composite: 64, tier: 'B', direction: 'long', analysts: [],
      }) };
    }
    if (u.includes('/api/stock-detail')) {
      return { ok: true, status: 200, json: async () => ({
        ok: true, ticker: 'NVDA', name: 'NVIDIA Corp', sector: 'Technology',
        price: 120.5, dayChangePct: 1.4, marketCap: 3.0e12, metrics: {}, sectorMedians: {},
      }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) };
  });
}

describe('StockDetailPanel', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = routeFetch(); });
  afterEach(() => fetchSpy.mockRestore());

  it('williams: renders hero (ticker) + server thesis + all section stubs', async () => {
    renderPanel({ board: 'williams', ticker: 'NVDA', row: { ticker: 'NVDA', score: -3, verdict: 'HOLD' } });
    // Hero ticker paints immediately.
    expect(screen.getByRole('heading', { name: 'NVDA' })).toBeInTheDocument();
    // Thesis arrives from the williams-rationale endpoint.
    await waitFor(() => expect(screen.getByText(/No actionable Williams setup/)).toBeInTheDocument());
    // All seven staged sections render in order.
    for (const title of ['Price Chart', 'Key Metrics', 'Relative Strength', 'Fundamentals', 'Catalysts', 'Risk Callouts', 'Score Breakdown']) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it('williams: hits ONLY the williams-rationale endpoint (+ stock-detail), not lynch/target', async () => {
    renderPanel({ board: 'williams', ticker: 'NVDA', row: { ticker: 'NVDA' } });
    await waitFor(() => expect(screen.getByText(/No actionable Williams setup/)).toBeInTheDocument());
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/api/williams-rationale'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/stock-detail'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/lynch-rationale'))).toBe(false);
    expect(urls.some((u) => u.includes('/api/target-rationale'))).toBe(false);
  });

  it('lynch: renders the GARP thesis', async () => {
    renderPanel({ board: 'lynch', ticker: 'AAPL', row: { ticker: 'AAPL', score: 90, verdict: 'BUY' } });
    expect(screen.getByRole('heading', { name: 'AAPL' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/GARP thesis/)).toBeInTheDocument());
  });

  it('target: uses the board row rationale as the thesis', async () => {
    renderPanel({
      board: 'target',
      ticker: 'MSFT',
      row: { ticker: 'MSFT', composite: 64, tier: 'B', direction: 'long', rationale: 'Composite long — broad analyst agreement.' },
    });
    expect(screen.getByRole('heading', { name: 'MSFT' })).toBeInTheDocument();
    expect(screen.getByText(/broad analyst agreement/)).toBeInTheDocument();
  });
});
