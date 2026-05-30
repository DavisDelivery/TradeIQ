// Phase 6 PR-F — FundamentalsStrip tests.
//
// Pins:
//   1. Strip renders the five default metric pills with real values.
//   2. Honest no-data ("—") for null fields; never a fabricated zero.
//   3. Tap/click expands via the onExpand callback (the strip is the
//      tap-to-expand affordance into the full detail panel).
//   4. **Single shared fetch contract**: two strips on the same ticker
//      across the same QueryClient share ONE network call. Different
//      tickers → distinct fetches.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { FundamentalsStrip } from '../FundamentalsStrip.jsx';

const fullBody = {
  ok: true, ticker: 'AAPL',
  metrics: {
    valuation: { pe: 29.4, ps: 8.1, pb: null, evEbitda: 22.8, evToSales: null, pcf: null, pfcf: null, enterpriseValue: null, marketCap: 3.5e12 },
    profitability: { grossMargin: 44, opMargin: 31, netMargin: 24, roe: 153.5, roa: 28.2, eps: 1.64 },
    health: { debtEquity: 1.42, currentRatio: null, quickRatio: null, cashRatio: null, longTermDebt: null, interestCoverage: null },
    market: { beta: 1.05, dividendYield: null, freeCashFlow: null, range52w: null, shortInterest: null },
  },
};

function mountStrip(props = {}, body = fullBody) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: true, status: 200, json: async () => body }));
  return render(
    <QueryClientProvider client={qc}>
      <FundamentalsStrip ticker="AAPL" {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // jsdom doesn't ship IntersectionObserver; the strip falls through and
  // sets `inView=true` immediately when it's undefined. Make sure it stays
  // undefined so the eager-fetch path is exercised in tests.
  delete globalThis.IntersectionObserver;
});

afterEach(() => vi.restoreAllMocks());

describe('FundamentalsStrip', () => {
  it('renders all five default metric pills with real values', async () => {
    mountStrip();
    await waitFor(() => expect(screen.getByTestId('strip-marketCap-AAPL')).toBeInTheDocument());
    expect(screen.getByText('$3.50T')).toBeInTheDocument(); // marketCap
    expect(screen.getByText('29.4')).toBeInTheDocument();    // pe
    expect(screen.getByText('8.1')).toBeInTheDocument();      // ps
    expect(screen.getByText('153.5%')).toBeInTheDocument();   // roe
    expect(screen.getByText('1.42')).toBeInTheDocument();     // debtEquity
  });

  it('renders "—" for null fields, never a fabricated zero', async () => {
    const body = {
      ok: true, ticker: 'X',
      metrics: {
        valuation: { pe: null, ps: null, marketCap: null },
        profitability: { roe: null },
        health: { debtEquity: null },
        market: {},
      },
    };
    mountStrip({ ticker: 'X' }, body);
    await waitFor(() => expect(screen.getAllByText('—').length).toBe(5));
  });

  it('fires onExpand when clicked', async () => {
    const onExpand = vi.fn();
    mountStrip({ onExpand });
    await waitFor(() => expect(screen.getByTestId('fundamentals-strip-AAPL')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('fundamentals-strip-AAPL'));
    expect(onExpand).toHaveBeenCalledWith('AAPL');
  });

  it('shows an unobtrusive "no fundamentals" chip on fetch failure', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><FundamentalsStrip ticker="AAPL" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText(/no fundamentals/i)).toBeInTheDocument());
  });
});

describe('FundamentalsStrip — cross-surface dedup contract', () => {
  it('two strips on the same ticker share a SINGLE network fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true, status: 200, json: async () => fullBody,
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    render(
      <QueryClientProvider client={qc}>
        <FundamentalsStrip ticker="AAPL" />
        <FundamentalsStrip ticker="AAPL" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId('fundamentals-strip-AAPL').length).toBe(2));
    // Both strips rendered, but only one fetch went out.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatch(/ticker=AAPL/);
  });

  it('different tickers fan out into distinct fetches', async () => {
    const seen = new Set();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const ticker = new URL(String(u), 'http://x').searchParams.get('ticker');
      seen.add(ticker);
      return { ok: true, status: 200, json: async () => ({ ...fullBody, ticker }) };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    render(
      <QueryClientProvider client={qc}>
        <FundamentalsStrip ticker="AAPL" />
        <FundamentalsStrip ticker="NVDA" />
        <FundamentalsStrip ticker="MSFT" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    expect(Array.from(seen).sort()).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });
});
