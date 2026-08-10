// PROFILE-1 W2.2 + W2.3 — KeyMetricsPanel as scannable rows.
//
// This file replaced the PR-E tile-grid spec. Three old assertions were
// deliberately inverted, and each inversion is the point of the change:
//   - group names Liquidity/Leverage/Market -> Balance sheet/Trading/Dividend
//   - only the first chunk renders until "Show all"
//   - "no data" is never printed; missing rows are hidden and named once
// The margin-unit pin (code-review-2026-06 M3) is preserved verbatim: it
// guards a real regression, not a layout choice.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { KeyMetricsPanel, favorability, partitionRows, fmtValue } from '../KeyMetricsPanel.jsx';

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

// metrics.profitability ratios are uniformly PERCENT-scaled by the handler.
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

describe('chunked rows', () => {
  it('shows only the first chunk until Show all', async () => {
    renderPanel(fullMetrics);
    await waitFor(() => expect(screen.getByText('Valuation')).toBeInTheDocument());
    expect(screen.queryByText('Profitability')).not.toBeInTheDocument();
    expect(screen.getByTestId('key-metrics-show-all')).toBeInTheDocument();
  });

  it('expands to every chunk on Show all', async () => {
    renderPanel(fullMetrics);
    await waitFor(() => expect(screen.getByText('Valuation')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('key-metrics-show-all'));

    for (const chunk of ['Valuation', 'Profitability', 'Balance sheet', 'Trading', 'Dividend']) {
      expect(screen.getByText(chunk), chunk).toBeInTheDocument();
    }
    expect(screen.getByText('29.4')).toBeInTheDocument();   // pe
    expect(screen.getByText('153.5%')).toBeInTheDocument(); // roe
    expect(screen.getByText('0.87')).toBeInTheDocument();   // currentRatio
    expect(screen.getByText('1.05')).toBeInTheDocument();   // beta
  });

  it('renders values with tabular-nums so the column aligns', async () => {
    renderPanel(fullMetrics);
    await waitFor(() => expect(screen.getByText('29.4')).toBeInTheDocument());
    expect(screen.getByText('29.4').className).toMatch(/tabular-nums/);
  });
});

// code-review-2026-06 M3 — margin-unit pin. A fraction input of 0.44 at the
// provider becomes 44 at the handler and must render "44.0%", not "0.4%".
describe('margin units', () => {
  it('renders percent-scale margins as percentages (44 -> "44.0%")', async () => {
    renderPanel(fullMetrics);
    await waitFor(() => expect(screen.getByText('Valuation')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('key-metrics-show-all'));
    expect(screen.getByText('44.0%')).toBeInTheDocument();  // grossMargin
    expect(screen.getByText('31.0%')).toBeInTheDocument();  // opMargin
    expect(screen.queryByText('0.4%')).not.toBeInTheDocument(); // pre-fix symptom
    expect(screen.getByText(/sector: 55.0%/)).toBeInTheDocument();
  });

  it('shows sector-median context where a median exists', async () => {
    renderPanel(fullMetrics);
    await waitFor(() => expect(screen.getByText(/sector: 26.1/)).toBeInTheDocument());
    expect(screen.getByText(/sector median · n=12/)).toBeInTheDocument();
  });
});

describe('nulls are hidden, not shouted', () => {
  const partial = {
    ok: true, ticker: 'AAPL',
    metrics: {
      valuation: { pe: 29.4, pb: null, ps: null, evEbitda: null, evToSales: null, pcf: null, pfcf: null, enterpriseValue: null, marketCap: null },
      profitability: { grossMargin: null, opMargin: null, roe: null, roa: null, netMargin: null, eps: null },
      health: { debtEquity: null, currentRatio: null, quickRatio: null, cashRatio: null, longTermDebt: null, interestCoverage: null },
      market: { beta: null, shortInterest: null, dividendYield: null, freeCashFlow: null, range52w: null },
      _reason: 'fundamentals_unavailable',
    },
    sectorMedians: { valuation: { pe: null }, profitability: {}, health: {}, sampleSize: 0 },
  };

  it('never prints the words "no data"', async () => {
    // The old spec asserted more than TEN of these. Fifteen identical
    // placeholders are fifteen rows of noise carrying no information.
    renderPanel(partial);
    await waitFor(() => expect(screen.getByText('fundamentals_unavailable')).toBeInTheDocument());
    expect(screen.queryAllByText('no data')).toHaveLength(0);
  });

  it('names the unreported metrics once, quietly, after expanding', async () => {
    renderPanel(partial);
    await waitFor(() => expect(screen.getByText('fundamentals_unavailable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('key-metrics-show-all'));
    const note = screen.getByTestId('key-metrics-missing');
    expect(note.textContent).toMatch(/^Not reported:/);
    expect(note.textContent).toMatch(/P\/B/);
    expect(note.textContent).toMatch(/Beta/);
  });

  it('keeps the _reason banner for a whole-group failure', async () => {
    renderPanel(partial);
    await waitFor(() => expect(screen.getByText('fundamentals_unavailable')).toBeInTheDocument());
  });

  it('hides the Dividend chunk entirely for a non-payer', async () => {
    const nonPayer = JSON.parse(JSON.stringify(fullMetrics));
    nonPayer.metrics.market.dividendYield = null;
    renderPanel(nonPayer);
    await waitFor(() => expect(screen.getByText('Valuation')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('key-metrics-show-all'));
    expect(screen.queryByText('Dividend')).not.toBeInTheDocument();
  });

  it('renders _degraded last, when present', async () => {
    const degraded = { ...fullMetrics, _degraded: ['finnhub', 'polygon'] };
    renderPanel(degraded);
    await waitFor(() => expect(screen.getByText('Valuation')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('key-metrics-show-all'));
    expect(screen.getByTestId('key-metrics-degraded').textContent).toMatch(/finnhub, polygon/);
  });
});

describe('no valuation metric renders a good/bad verdict', () => {
  it('gives P/E no favourability even when it beats the sector median', () => {
    // The old panel had P/E as dir:'lower' and painted a cheap stock emerald.
    // A low P/E is not good news; it is the price of a set of expectations.
    expect(favorability('pe', 12, 26.1)).toBe('none');
    expect(favorability('pe', 90, 26.1)).toBe('none');
  });

  it('gives beta and dividend yield no favourability', () => {
    expect(favorability('beta', 0.4, 1.0)).toBe('none');
    expect(favorability('dividendYield', 0.09, 0.02)).toBe('none');
  });

  it('DOES rank a margin against its median', () => {
    expect(favorability('grossMargin', 70, 55)).toBe('favorable');
    expect(favorability('grossMargin', 30, 55)).toBe('unfavorable');
    expect(favorability('grossMargin', 56, 55)).toBe('neutral'); // inside 5%
  });

  it('treats a band metric by its band, not by the median', () => {
    expect(favorability('currentRatio', 2.0, 0.5)).toBe('favorable');   // inside 1.2-3
    expect(favorability('currentRatio', 0.4, 0.5)).toBe('unfavorable'); // below band
    expect(favorability('currentRatio', 9.0, 0.5)).toBe('unfavorable'); // idle capital
  });

  it('renders no dot for a metric with no median', () => {
    expect(favorability('grossMargin', 70, null)).toBe('none');
  });
});

describe('helpers', () => {
  it('partitionRows splits present from missing by label', () => {
    const { present, missing } = partitionRows(
      [{ label: 'A', path: 'x.a' }, { label: 'B', path: 'x.b' }],
      { x: { a: 1, b: null } },
    );
    expect(present.map((p) => p.label)).toEqual(['A']);
    expect(missing).toEqual(['B']);
  });

  it('treats non-finite as missing rather than rendering NaN', () => {
    const { present, missing } = partitionRows(
      [{ label: 'A', path: 'x.a' }],
      { x: { a: Number.NaN } },
    );
    expect(present).toHaveLength(0);
    expect(missing).toEqual(['A']);
  });

  it('fmtValue returns null for unusable input', () => {
    for (const bad of [null, undefined, Number.NaN, Infinity]) {
      expect(fmtValue(bad, 'num1')).toBeNull();
    }
  });
});

describe('failure', () => {
  it('shows an error + retry on fetch failure', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><KeyMetricsPanel ticker="AAPL" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText(/couldn't load metrics/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
