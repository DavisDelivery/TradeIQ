// Phase 6 PR-D — FundamentalsChart smoke tests.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { FundamentalsChart } from '../FundamentalsChart.jsx';

function makeQuarter(i, overrides = {}) {
  return {
    period: `Q${(i % 4) + 1} ${2021 + Math.floor(i / 4)}`,
    endDate: `${2021 + Math.floor(i / 4)}-${String(((i % 4) + 1) * 3).padStart(2, '0')}-30`,
    filingDate: null, fiscalQuarter: (i % 4) + 1, fiscalYear: 2021 + Math.floor(i / 4),
    revenue: 1_000_000_000 * (1 + i * 0.05),
    eps: 1 + i * 0.05,
    grossMargin: 40 + (i % 5),
    opMargin: 20 + (i % 3),
    netMargin: 15 + (i % 4),
    freeCashFlow: 100_000_000 * (1 + i * 0.04),
    debtToEquity: 0.4 + (i * 0.01),
    ...overrides,
  };
}

function renderChart(props, body) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true, status: 200, json: async () => body,
  }));
  const r = render(
    <QueryClientProvider client={qc}>
      <FundamentalsChart {...props} />
    </QueryClientProvider>,
  );
  return { ...r, spy };
}

afterEach(() => vi.restoreAllMocks());

describe('FundamentalsChart', () => {
  it('renders the Revenue tab by default with the quarterly footer', async () => {
    const quarterly = Array.from({ length: 20 }, (_, i) => makeQuarter(i));
    renderChart({ ticker: 'AAPL' }, { ok: true, ticker: 'AAPL', fundamentalsHistory: { quarterly } });
    await waitFor(() => expect(screen.getByText('Fundamentals')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Revenue' })).toHaveAttribute('aria-selected', 'true');
    // Footer shows quarter count + range
    await waitFor(() => expect(screen.getByText(/20 quarters/)).toBeInTheDocument());
  });

  it('exposes every brief-listed series as a tab', async () => {
    const quarterly = Array.from({ length: 8 }, (_, i) => makeQuarter(i));
    renderChart({ ticker: 'AAPL' }, { ok: true, ticker: 'AAPL', fundamentalsHistory: { quarterly } });
    await waitFor(() => expect(screen.getByText('Fundamentals')).toBeInTheDocument());
    for (const t of ['Revenue', 'EPS', 'Margins', 'FCF', 'D/E']) {
      expect(screen.getByRole('tab', { name: t })).toBeInTheDocument();
    }
  });

  it('switching to Margins selects the new tab', async () => {
    const quarterly = Array.from({ length: 8 }, (_, i) => makeQuarter(i));
    renderChart({ ticker: 'AAPL' }, { ok: true, ticker: 'AAPL', fundamentalsHistory: { quarterly } });
    await waitFor(() => expect(screen.getByText('Fundamentals')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Margins' }));
    expect(screen.getByRole('tab', { name: 'Margins' })).toHaveAttribute('aria-selected', 'true');
  });

  it('range toggle 5Y → All shows more quarters when available', async () => {
    const quarterly = Array.from({ length: 40 }, (_, i) => makeQuarter(i));
    renderChart({ ticker: 'AAPL' }, { ok: true, ticker: 'AAPL', fundamentalsHistory: { quarterly } });
    await waitFor(() => expect(screen.getByText(/40 quarters/)).toBeInTheDocument());
    // 5Y is the default range — chart slices to 20.
    expect(screen.getByRole('tab', { name: '5Y' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows "no data in this window" when every value in the active series is null', async () => {
    const quarterly = Array.from({ length: 4 }, (_, i) => makeQuarter(i, { freeCashFlow: null }));
    renderChart({ ticker: 'AAPL' }, { ok: true, ticker: 'AAPL', fundamentalsHistory: { quarterly } });
    await waitFor(() => expect(screen.getByText('Fundamentals')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'FCF' }));
    await waitFor(() => expect(screen.getByText(/no fcf data in this window/i)).toBeInTheDocument());
  });

  it('surfaces _reason when quarterly history is empty', async () => {
    renderChart({ ticker: 'AAPL' }, { ok: true, ticker: 'AAPL', fundamentalsHistory: { quarterly: [], _reason: 'quarterly_history_unavailable' } });
    await waitFor(() => expect(screen.getByText(/quarterly_history_unavailable/i)).toBeInTheDocument());
  });

  it('renders error state + retry on fetch failure', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><FundamentalsChart ticker="AAPL" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText(/couldn't load detail bundle/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
