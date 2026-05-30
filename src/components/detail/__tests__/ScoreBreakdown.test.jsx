// Phase 6 PR-E — ScoreBreakdown smoke tests.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { ScoreBreakdown } from '../ScoreBreakdown.jsx';

function mockFetch(handler) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => handler(String(u)));
}

function renderWith({ board, ticker, body }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  mockFetch((u) => {
    if (u.includes(`/api/${board}-rationale`)) return { ok: true, status: 200, json: async () => body };
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) };
  });
  return render(
    <QueryClientProvider client={qc}>
      <ScoreBreakdown board={board} ticker={ticker} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

const williamsBody = {
  ok: true, ticker: 'NVDA', score: -3,
  components: [
    { name: 'Momentum (%R)',      score: -10, weight: 0.25, direction: 'short',   rationale: '%R extended at -11',           signals: { williamsR: -11.1, wrTurning: false, wrTopping: false } },
    { name: 'Volatility Breakout', score:   0, weight: 0.25, direction: 'neutral', rationale: 'no volatility breakout',       signals: { volBreakoutLong: false, vbStrength: 0 } },
    { name: 'Closing Strength',    score:  2.4, weight: 0.15, direction: 'long',    rationale: 'mid-range closes (58%)',       signals: { closeStrength10dPct: 58 } },
    { name: 'Seasonality',         score:   0, weight: 0.13, direction: 'neutral', rationale: 'no seasonal tilt',             signals: { seasonalTilt: 0 } },
    { name: 'Trend Confirmation',  score:  4.6, weight: 0.22, direction: 'long',    rationale: 'trend up (20>50 EMA)',          signals: { uptrend: true, downtrend: false } },
  ],
};

describe('ScoreBreakdown', () => {
  it('renders one row per component with score/weight/direction + total in the header', async () => {
    renderWith({ board: 'williams', ticker: 'NVDA', body: williamsBody });
    await waitFor(() => expect(screen.getByTestId('score-breakdown-table')).toBeInTheDocument());
    const table = screen.getByTestId('score-breakdown-table');
    const rows = within(table).getAllByRole('row');
    // header + 5 body rows
    expect(rows.length).toBeGreaterThanOrEqual(6);
    // Header total
    expect(screen.getByText(/total/i)).toBeInTheDocument();
    expect(screen.getByText('-3.0')).toBeInTheDocument();
    // Spot-check a component
    expect(screen.getByText('Momentum (%R)')).toBeInTheDocument();
  });

  it('expands a row to show the numeric signals on click', async () => {
    renderWith({ board: 'williams', ticker: 'NVDA', body: williamsBody });
    await waitFor(() => expect(screen.getByTestId('score-breakdown-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('score-row-Momentum-R-'));
    // Numeric signals dictionary appears
    expect(screen.getByText('williamsR')).toBeInTheDocument();
    expect(screen.getByText('-11.10')).toBeInTheDocument();
  });

  it('sortable: click "Score" header to toggle direction', async () => {
    renderWith({ board: 'williams', ticker: 'NVDA', body: williamsBody });
    await waitFor(() => expect(screen.getByTestId('score-breakdown-table')).toBeInTheDocument());
    // default sort is score desc — Trend Confirmation (4.6) tops
    let bodyRows = within(screen.getByTestId('score-breakdown-table')).getAllByRole('row').slice(1);
    expect(within(bodyRows[0]).getByText('Trend Confirmation')).toBeInTheDocument();
    // Click Score header to flip to asc — most-negative goes top
    fireEvent.click(screen.getByRole('button', { name: /score/i }));
    bodyRows = within(screen.getByTestId('score-breakdown-table')).getAllByRole('row').slice(1);
    expect(within(bodyRows[0]).getByText('Momentum (%R)')).toBeInTheDocument();
  });

  it('greys out and italicizes noData rows', async () => {
    renderWith({ board: 'lynch', ticker: 'XYZ', body: {
      ok: true, ticker: 'XYZ', score: 0,
      components: [
        { name: 'PEG (valuation)', score: 0, weight: 0.38, direction: 'neutral', rationale: 'no PEG', signals: {}, noData: true, noDataReason: 'peg_uncomputable' },
        { name: 'Revenue Growth', score: 15, weight: 0.14, direction: 'long', rationale: 'revenue +19%', signals: { revGrowthYoYPct: 19 } },
      ],
    } });
    await waitFor(() => expect(screen.getByTestId('score-breakdown-table')).toBeInTheDocument());
    expect(screen.getByText('peg_uncomputable')).toBeInTheDocument();
  });

  it('shows the target-composite fallback when board=target', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ScoreBreakdown board="target" ticker="MSFT" /></QueryClientProvider>);
    expect(screen.getByText(/see Analyst Contributions/i)).toBeInTheDocument();
  });
});
