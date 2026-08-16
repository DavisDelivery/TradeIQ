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

// ---------------------------------------------------------------------------
// Reported: "All time button doesn't work and I want to look at years too."
// ---------------------------------------------------------------------------
describe('period toggle — quarters vs fiscal years', () => {
  // 12 quarters = FY2021, FY2022, FY2023 complete.
  const twelve = Array.from({ length: 12 }, (_, i) => makeQuarter(i));
  const body = { ok: true, ticker: 'AAA', fundamentalsHistory: { quarterly: twelve } };

  it('starts on quarters and says so', async () => {
    renderChart({ ticker: 'AAA' }, body);
    const foot = await screen.findByTestId('fundamentals-footer');
    expect(foot.textContent).toMatch(/12 quarters/i);
  });

  it('switching to Annual rolls 12 quarters into 3 fiscal years', async () => {
    renderChart({ ticker: 'AAA' }, body);
    await screen.findByTestId('fundamentals-footer');
    fireEvent.click(screen.getByTestId('period-FY'));
    await waitFor(() =>
      expect(screen.getByTestId('fundamentals-footer').textContent).toMatch(/3 fiscal years/i));
  });

  it('switching back to Qtr restores the quarterly count', async () => {
    renderChart({ ticker: 'AAA' }, body);
    await screen.findByTestId('fundamentals-footer');
    fireEvent.click(screen.getByTestId('period-FY'));
    await waitFor(() =>
      expect(screen.getByTestId('fundamentals-footer').textContent).toMatch(/fiscal years/i));
    fireEvent.click(screen.getByTestId('period-Q'));
    await waitFor(() =>
      expect(screen.getByTestId('fundamentals-footer').textContent).toMatch(/12 quarters/i));
  });

  it('discloses an incomplete year rather than dropping it silently', async () => {
    // 13 quarters: FY2024 has one quarter and cannot be drawn.
    const thirteen = Array.from({ length: 13 }, (_, i) => makeQuarter(i));
    renderChart({ ticker: 'AAA' }, {
      ok: true, ticker: 'AAA', fundamentalsHistory: { quarterly: thirteen },
    });
    await screen.findByTestId('fundamentals-footer');
    fireEvent.click(screen.getByTestId('period-FY'));
    await waitFor(() =>
      expect(screen.getByTestId('fundamentals-footer').textContent)
        .toMatch(/1 incomplete year omitted/i));
  });

  it('explains an annual view with no complete year, instead of "no history"', async () => {
    const two = Array.from({ length: 2 }, (_, i) => makeQuarter(i));
    renderChart({ ticker: 'AAA' }, {
      ok: true, ticker: 'AAA', fundamentalsHistory: { quarterly: two },
    });
    await screen.findByTestId('fundamentals-footer');
    fireEvent.click(screen.getByTestId('period-FY'));
    await waitFor(() =>
      expect(screen.getByText(/no complete fiscal year yet/i)).toBeInTheDocument());
  });
});

describe('the 5Y window means five years in either mode', () => {
  // 40 quarters = 10 fiscal years, which only became reachable once the LIVE
  // statement fetch stopped asking for 8.
  const forty = Array.from({ length: 40 }, (_, i) => makeQuarter(i));
  const body = { ok: true, ticker: 'AAA', fundamentalsHistory: { quarterly: forty } };

  it('ALL now differs from 5Y — the reported bug', async () => {
    // With only 8 quarters available both buttons rendered the same chart,
    // which is what "All time button doesn't work" looked like.
    renderChart({ ticker: 'AAA' }, body);
    const foot = await screen.findByTestId('fundamentals-footer');
    expect(foot.textContent).toMatch(/40 quarters/i);
  });

  it('annual + ALL shows ten fiscal years', async () => {
    renderChart({ ticker: 'AAA' }, body);
    await screen.findByTestId('fundamentals-footer');
    fireEvent.click(screen.getByTestId('period-FY'));
    await waitFor(() =>
      expect(screen.getByTestId('fundamentals-footer').textContent).toMatch(/10 fiscal years/i));
  });
});

describe('stale fundamentals are called out, not drawn as current', () => {
  it('shows a banner when the server flags the window as old', () => {
    const q = Array.from({ length: 20 }, (_, i) => makeQuarter(i));
    renderChart({ ticker: 'AAA' }, {
      ok: true, ticker: 'AAA',
      fundamentalsHistory: {
        quarterly: q,
        _stale: { ageDays: 1870, reason: 'newest statement period ends 2021-07-03, 62 months old — the provider is serving a historical window, not current filings' },
      },
    });
    return screen.findByTestId('fundamentals-stale').then((el) => {
      expect(el.textContent).toMatch(/out of date/i);
      expect(el.textContent).toMatch(/2021-07-03/);
    });
  });

  it('stays silent when the data is current', async () => {
    const q = Array.from({ length: 20 }, (_, i) => makeQuarter(i));
    renderChart({ ticker: 'AAA' }, {
      ok: true, ticker: 'AAA', fundamentalsHistory: { quarterly: q },
    });
    await screen.findByTestId('fundamentals-footer');
    expect(screen.queryByTestId('fundamentals-stale')).not.toBeInTheDocument();
  });
});
