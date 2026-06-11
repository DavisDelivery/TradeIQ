// Phase 6 PR-E — KeyMetricsPanel smoke tests.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { KeyMetricsPanel } from '../KeyMetricsPanel.jsx';

function renderPanel(body, props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: true, status: 200, json: async () => body }));
  return render(
    <QueryClientProvider client={qc}>
      <KeyMetricsPanel ticker="AAPL" {...props} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

// Fixture derived from what stock-detail.ts ACTUALLY emits (post
// code-review-2026-06 M3 fix): metrics.profitability ratios are uniformly
// PERCENT-scaled. The handler ×100s data-provider's fractional group, so
// grossMargin 0.44 → 44, opMargin 0.31 → 31, netMargin 0.24 → 24,
// roe 1.535 → 153.5, roa 0.282 → 28.2. (The pre-fix handler leaked
// gross/op margin through as fractions; this fixture pins the percent
// contract the UI's pct1 formatter assumes.)
const fullMetrics = {
  ok: true, ticker: 'AAPL',
  metrics: {
    valuation: { pe: 29.4, pb: 49.9, ps: 8.1, evEbitda: 22.8, evToSales: 9.6, pcf: 28.5, pfcf: 30.2, enterpriseValue: 3.59e12, marketCap: 3.5e12 },
    profitability: { grossMargin: 44, opMargin: 31, netMargin: 24, roe: 153.5, roa: 28.2, eps: 1.64 },
    health: { debtEquity: 1.42, currentRatio: 0.87, quickRatio: 0.84, cashRatio: 0.37, longTermDebt: 85.7e9, interestCoverage: null },
    market: { beta: 1.05, shortInterest: null, dividendYield: 0.0043, freeCashFlow: 108e9, range52w: { low: 195, high: 315, currentPctile: 97.5 } },
  },
  sectorMedians: {
    valuation: { pe: 26.1, ps: null, evEbitda: null, pb: null },
    profitability: { grossMargin: 55, opMargin: 22.4, roe: null, roa: null, netMargin: null, eps: null },
    health: { debtEquity: 0.8, currentRatio: null, interestCoverage: null },
    sampleSize: 12,
  },
};

describe('KeyMetricsPanel', () => {
  it('renders every metric group with at least one populated value', async () => {
    renderPanel(fullMetrics);
    // wait for fetch to settle — group headers appear only post-load
    await waitFor(() => expect(screen.getByText('Valuation')).toBeInTheDocument());
    for (const group of ['Valuation', 'Profitability', 'Liquidity', 'Leverage', 'Market']) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }
    // Spot-check populated values from PR-E pass-through fields
    expect(screen.getByText('29.4')).toBeInTheDocument();         // pe (num1)
    expect(screen.getByText('8.1')).toBeInTheDocument();           // ps (num1)
    expect(screen.getByText('22.8')).toBeInTheDocument();          // evEbitda (num1)
    expect(screen.getByText('153.5%')).toBeInTheDocument();        // roe (pct1)
    expect(screen.getByText('24.0%')).toBeInTheDocument();         // netMargin (pct1)
    expect(screen.getByText('0.87')).toBeInTheDocument();          // currentRatio (num2)
    expect(screen.getByText('1.05')).toBeInTheDocument();          // beta (num2)
  });

  // code-review-2026-06 M3 — margin-unit pin. A fraction input of 0.44 at
  // the provider becomes 44 at the handler and must render "44.0%", not
  // "0.4%". The favorability dot now compares percent vs percent (44 vs
  // sector 55 → genuinely unfavorable, not unit-mismatch unfavorable).
  it('renders percent-scale margins as percentages (44 → "44.0%")', async () => {
    renderPanel(fullMetrics);
    await waitFor(() => expect(screen.getByText('44.0%')).toBeInTheDocument()); // grossMargin
    expect(screen.getByText('31.0%')).toBeInTheDocument(); // opMargin
    expect(screen.queryByText('0.4%')).not.toBeInTheDocument(); // the pre-fix fraction symptom
    // sector medians render in the same (percent) unit next to the value
    expect(screen.getByText(/sector: 55.0%/)).toBeInTheDocument();
  });

  it('shows sector-median context where the median is available', async () => {
    renderPanel(fullMetrics);
    await waitFor(() => expect(screen.getByText(/sector: 26.1/)).toBeInTheDocument());
    expect(screen.getByText(/sector median · n=12/)).toBeInTheDocument();
  });

  it('renders "no data" for metrics that come back null (no fabricated zeros)', async () => {
    const partial = {
      ok: true, ticker: 'AAPL',
      metrics: {
        valuation: { pe: null, pb: null, ps: null, evEbitda: null, evToSales: null, pcf: null, pfcf: null, enterpriseValue: null, marketCap: null },
        profitability: { grossMargin: null, opMargin: null, roe: null, roa: null, netMargin: null, eps: null },
        health: { debtEquity: null, currentRatio: null, quickRatio: null, cashRatio: null, longTermDebt: null, interestCoverage: null },
        market: { beta: null, shortInterest: null, dividendYield: null, freeCashFlow: null, range52w: null },
        _reason: 'fundamentals_unavailable',
      },
      sectorMedians: { valuation: { pe: null }, profitability: {}, health: {}, sampleSize: 0 },
    };
    renderPanel(partial);
    await waitFor(() => expect(screen.getByText('fundamentals_unavailable')).toBeInTheDocument());
    expect(screen.getAllByText('no data').length).toBeGreaterThan(10);
  });

  it('shows an error + retry on fetch failure', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><KeyMetricsPanel ticker="AAPL" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText(/couldn't load metrics/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
