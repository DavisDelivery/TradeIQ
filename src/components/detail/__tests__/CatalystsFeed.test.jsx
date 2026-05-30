// Phase 6 PR-E — CatalystsFeed smoke tests.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { CatalystsFeed } from '../CatalystsFeed.jsx';

function renderFeed(body) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: true, status: 200, json: async () => body }));
  return render(
    <QueryClientProvider client={qc}>
      <CatalystsFeed ticker="AAPL" />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

const fullCatalysts = {
  ok: true, ticker: 'AAPL',
  catalysts: {
    lastEarnings: { date: '2026-02-15', epsActual: 2.4, epsEstimate: 2.2, surprisePct: 9.1, priceReactionPct: 1.8 },
    nextEarnings: { date: '2026-06-15', daysUntil: 28, epsEstimate: 2.5 },
    news: [
      { headline: 'AAPL launches new product', source: 'Reuters', date: '2026-05-29', url: 'https://example.com/a', sentiment: null },
      { headline: 'Quarterly results beat', source: 'Bloomberg', date: '2026-05-20', url: 'https://example.com/b', sentiment: null },
    ],
    insider: {
      net90dDollarVolume: -8_400_000,
      last: { role: 'CFO', action: 'sell', dollarValue: 1_200_000, date: '2026-02-01' },
    },
    upcomingEvents: [
      { type: 'earnings', date: '2026-06-15', description: 'Next earnings — Street EPS est 2.50' },
    ],
  },
};

describe('CatalystsFeed', () => {
  it('renders earnings + insider + news + upcoming sections with real data', async () => {
    renderFeed(fullCatalysts);
    // Wait for fetch to settle — subsection labels only render after detail bundle resolves
    await waitFor(() => expect(screen.getByText('Earnings')).toBeInTheDocument());
    expect(screen.getByText(/Last · 2026-02-15/)).toBeInTheDocument();
    expect(screen.getByText(/surprise \+9.1%/)).toBeInTheDocument();
    expect(screen.getByText(/Next · 2026-06-15/)).toBeInTheDocument();
    expect(screen.getByText('in 28d')).toBeInTheDocument();
    expect(screen.getByText(/Street EPS est \$2.50/)).toBeInTheDocument();
    // Insider
    expect(screen.getByText('Insider activity (90d)')).toBeInTheDocument();
    expect(screen.getByText(/−\$8.4M net/)).toBeInTheDocument();
    expect(screen.getByText(/CFO · sell/)).toBeInTheDocument();
    // News
    expect(screen.getByText('News (last 30d)')).toBeInTheDocument();
    const newsList = screen.getByTestId('news-list');
    expect(newsList.children.length).toBe(2);
    expect(screen.getByText(/AAPL launches new product/)).toBeInTheDocument();
    // Upcoming
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText(/Street EPS est 2.50/)).toBeInTheDocument();
  });

  it('renders no-data subsection labels when individual catalysts are missing', async () => {
    renderFeed({
      ok: true, ticker: 'X',
      catalysts: {
        lastEarnings: null, nextEarnings: null, news: [], insider: null, upcomingEvents: [],
      },
    });
    await waitFor(() => expect(screen.getByText(/no earnings data/i)).toBeInTheDocument());
    expect(screen.getByText(/no insider data/i)).toBeInTheDocument();
    expect(screen.getByText(/no news in window/i)).toBeInTheDocument();
    // Upcoming subsection is hidden entirely when the array is empty
    expect(screen.queryByText('Upcoming')).not.toBeInTheDocument();
  });
});
