// Phase 6 PR-C — DetailPriceChart smoke tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { DetailPriceChart } from '../DetailPriceChart.jsx';

function makeBars(n = 30, start = 100) {
  const out = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    c = c * (1 + (i % 5 === 0 ? -0.01 : 0.008));
    const date = new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10);
    out.push({ date, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1_000_000 });
  }
  return out;
}

function renderChart(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={qc}>
      <DetailPriceChart {...props} />
    </QueryClientProvider>,
  );
}

function mockFetch(handler) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    return handler(u);
  });
}

describe('DetailPriceChart', () => {
  let fetchSpy;
  afterEach(() => { fetchSpy?.mockRestore(); });

  it('renders the price chart with the default 6M window', async () => {
    fetchSpy = mockFetch((u) => {
      expect(u).toContain('range=6M');
      return { ok: true, status: 200, json: async () => ({ ok: true, ticker: 'AAPL', range: '6M', bars: makeBars() }) };
    });
    renderChart({ ticker: 'AAPL' });
    await waitFor(() => expect(screen.getByText('Price Chart')).toBeInTheDocument());
    // Range toggles render
    for (const r of ['1M', '3M', '6M', '1Y', '5Y']) {
      expect(screen.getByRole('tab', { name: r })).toBeInTheDocument();
    }
    // 6M tab is selected
    expect(screen.getByRole('tab', { name: '6M' })).toHaveAttribute('aria-selected', 'true');
  });

  it('switching the range fires a new fetch with the new range param', async () => {
    let lastUrl = '';
    fetchSpy = mockFetch((u) => {
      lastUrl = u;
      const range = new URL(u, 'http://x').searchParams.get('range') ?? '6M';
      return { ok: true, status: 200, json: async () => ({ ok: true, ticker: 'AAPL', range, bars: makeBars() }) };
    });
    renderChart({ ticker: 'AAPL' });
    await waitFor(() => expect(lastUrl).toContain('range=6M'));
    fireEvent.click(screen.getByRole('tab', { name: '1Y' }));
    await waitFor(() => expect(lastUrl).toContain('range=1Y'));
    fireEvent.click(screen.getByRole('tab', { name: '5Y' }));
    await waitFor(() => expect(lastUrl).toContain('range=5Y'));
  });

  it('shows an explicit no-data state when bars[] is empty', async () => {
    fetchSpy = mockFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, ticker: 'AAPL', range: '6M', bars: [] }) }));
    renderChart({ ticker: 'AAPL' });
    await waitFor(() => expect(screen.getByText(/no bars in this window/i)).toBeInTheDocument());
  });

  it('shows an explicit error state with retry on failure', async () => {
    fetchSpy = mockFetch(() => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }));
    renderChart({ ticker: 'AAPL' });
    await waitFor(() => expect(screen.getByText(/couldn't load bars/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
