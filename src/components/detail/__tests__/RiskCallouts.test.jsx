// Phase 6 PR-E — RiskCallouts smoke tests.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { RiskCallouts } from '../RiskCallouts.jsx';

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
      <RiskCallouts board={board} ticker={ticker} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('RiskCallouts', () => {
  it('renders the Williams callouts as a list when populated', async () => {
    renderWith({ board: 'williams', ticker: 'NVDA', body: {
      ok: true, ticker: 'NVDA',
      riskCallouts: [
        'If Williams %R climbs back above −20, the oversold-reversal leg is exhausted.',
        'If price closes below the 50-day EMA, the trend leg of the setup breaks.',
      ],
    } });
    await waitFor(() => expect(screen.getByTestId('risk-list')).toBeInTheDocument());
    const list = screen.getByTestId('risk-list');
    expect(list.children.length).toBe(2);
    expect(screen.getByText(/Williams %R climbs back above −20/)).toBeInTheDocument();
    expect(screen.getByText(/closes below the 50-day EMA/)).toBeInTheDocument();
  });

  it('renders the Lynch callouts as a list when populated', async () => {
    renderWith({ board: 'lynch', ticker: 'AAPL', body: {
      ok: true, ticker: 'AAPL',
      riskCallouts: [
        'If PEG expands above 2.0, the stock is no longer growth at a reasonable price.',
        'If EPS growth turns negative for two consecutive quarters, the fast-grower thesis breaks.',
      ],
    } });
    await waitFor(() => expect(screen.getByTestId('risk-list')).toBeInTheDocument());
    expect(screen.getByText(/PEG expands above 2.0/)).toBeInTheDocument();
  });

  it('shows the target-composite fallback (no per-component callouts)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <RiskCallouts board="target" ticker="MSFT" />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/no falsifiable per-component callouts/i)).toBeInTheDocument();
  });

  it('renders no-callouts state when the array is empty', async () => {
    renderWith({ board: 'williams', ticker: 'NVDA', body: { ok: true, ticker: 'NVDA', riskCallouts: [] } });
    await waitFor(() => expect(screen.getByText(/no callouts surfaced/i)).toBeInTheDocument());
  });
});
