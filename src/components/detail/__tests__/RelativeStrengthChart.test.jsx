// Phase 6 PR-C — RelativeStrengthChart smoke tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { RelativeStrengthChart } from '../RelativeStrengthChart.jsx';

function makeSeries(n = 60, drift = 0.05) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2025, 5, i + 1)).toISOString().slice(0, 10);
    out.push({ date: d, cumulativeOutperformancePct: drift * i });
  }
  return out;
}

function renderChart(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={qc}>
      <RelativeStrengthChart {...props} />
    </QueryClientProvider>,
  );
}

function mockFetch(handler) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => handler(String(url)));
}

describe('RelativeStrengthChart', () => {
  let fetchSpy;
  afterEach(() => { fetchSpy?.mockRestore(); });

  it('renders both vsSpy and vsSector series with the sector ETF label', async () => {
    fetchSpy = mockFetch(() => ({
      ok: true, status: 200,
      json: async () => ({
        ok: true, ticker: 'AAPL', name: 'Apple Inc.', sector: 'Technology',
        relativeStrength: {
          vsSpy: makeSeries(120, 0.04),
          vsSector: makeSeries(120, 0.02),
          sectorEtf: 'XLK',
        },
      }),
    }));
    renderChart({ ticker: 'AAPL' });
    await waitFor(() => expect(screen.getByText('Relative Strength')).toBeInTheDocument());
    // Latest-value summary line in the header carries both labels.
    await waitFor(() => expect(screen.getByText(/vs SPY/i)).toBeInTheDocument());
    expect(screen.getByText(/vs XLK/i)).toBeInTheDocument();
  });

  it('renders a no-data state with the _reason from the bundle', async () => {
    fetchSpy = mockFetch(() => ({
      ok: true, status: 200,
      json: async () => ({
        ok: true, ticker: 'AAPL',
        relativeStrength: { vsSpy: [], vsSector: [], sectorEtf: null, _reason: 'insufficient_overlap' },
      }),
    }));
    renderChart({ ticker: 'AAPL' });
    await waitFor(() => expect(screen.getByText(/insufficient_overlap/)).toBeInTheDocument());
  });

  it('hides the sector line when sectorEtf is null but still shows vsSpy', async () => {
    fetchSpy = mockFetch(() => ({
      ok: true, status: 200,
      json: async () => ({
        ok: true, ticker: 'X', relativeStrength: {
          vsSpy: makeSeries(60, 0.03), vsSector: [], sectorEtf: null,
        },
      }),
    }));
    renderChart({ ticker: 'X' });
    await waitFor(() => expect(screen.getByText(/vs SPY/i)).toBeInTheDocument());
    expect(screen.queryByText(/vs XLK/i)).not.toBeInTheDocument();
  });
});
