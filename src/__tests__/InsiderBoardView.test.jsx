// Phase 4l W3 — InsiderBoardView default-to-buyers + Buyers/Sellers/All toggle
// + column sortability.
//
// Verifies: tab opens defaulted to net buyers (filter + sort); toggle flips
// the visible set; column headers sort by their field (ticker, $bought, $sold,
// net, buyer count, price); Price column renders Polygon close.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockUseInsider = vi.fn();

vi.mock('../hooks/useInsider.js', () => ({
  useInsider: (...args) => mockUseInsider(...args),
}));

vi.mock('../components/FreshnessPill.jsx', () => ({
  FreshnessPill: () => <div data-testid="freshness-pill" />,
}));

import { InsiderBoardView } from '../InsiderBoardView.jsx';

function makeRow({ ticker, buy = 0, sell = 0, net = buy - sell, price = 100, buyerCount = 1 }) {
  return {
    ticker,
    buyDollars: buy,
    awardDollars: 0,
    sellDollars: sell,
    netDollars: net,
    buyerCount,
    totalBuys: buy > 0 ? 1 : 0,
    totalAwards: 0,
    totalSells: sell > 0 ? 1 : 0,
    topBuyer: buy > 0 ? { name: `Insider-${ticker}`, role: 'CEO', dollars: buy } : null,
    latestFilingDate: '2026-05-01',
    daysSinceLatest: 5,
    price,
    filings: [],
  };
}

function renderWith(rows) {
  mockUseInsider.mockReturnValue({
    data: {
      rows,
      universeChecked: 2245,
      windowDays: 90,
      generatedAt: '2026-05-17T12:00:00.000Z',
      source: 'snapshot-aggregate',
    },
    error: null,
    isLoading: false,
    isFetching: false,
    forceRescan: vi.fn(),
  });

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <InsiderBoardView universe="all" />
    </QueryClientProvider>,
  );
}

function getBodyTickers() {
  const tbody = document.querySelector('tbody');
  if (!tbody) return [];
  // Each top-level row uses font-serif on its ticker cell.
  return Array.from(tbody.querySelectorAll('td.font-serif')).map((td) => td.textContent?.trim());
}

beforeEach(() => {
  // Reset URL so prior tests' state doesn't bleed.
  window.history.replaceState({}, '', '/');
  mockUseInsider.mockReset();
});

describe('InsiderBoardView (Phase 4l W3)', () => {
  it('opens defaulted to net buyers — only positive-net rows visible', () => {
    renderWith([
      makeRow({ ticker: 'AAA', buy: 100_000, net: 100_000 }),
      makeRow({ ticker: 'BBB', sell: 200_000, net: -200_000 }),
      makeRow({ ticker: 'CCC', net: 0 }),
      makeRow({ ticker: 'DDD', buy: 50_000, net: 50_000 }),
    ]);

    const tickers = getBodyTickers();
    expect(tickers).toContain('AAA');
    expect(tickers).toContain('DDD');
    expect(tickers).not.toContain('BBB');
    expect(tickers).not.toContain('CCC');
  });

  it('default Buyers view is sorted by netDollars descending', () => {
    renderWith([
      makeRow({ ticker: 'SMALL', net: 10_000 }),
      makeRow({ ticker: 'BIG', net: 500_000 }),
      makeRow({ ticker: 'MID', net: 100_000 }),
    ]);
    expect(getBodyTickers()).toEqual(['BIG', 'MID', 'SMALL']);
  });

  it('Sellers toggle shows only net sellers', () => {
    renderWith([
      makeRow({ ticker: 'BUYER', net: 100_000 }),
      makeRow({ ticker: 'SELLER1', net: -50_000, sell: 50_000 }),
      makeRow({ ticker: 'SELLER2', net: -200_000, sell: 200_000 }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Sellers' }));
    const tickers = getBodyTickers();
    expect(tickers).toContain('SELLER1');
    expect(tickers).toContain('SELLER2');
    expect(tickers).not.toContain('BUYER');
  });

  it('All toggle shows every row regardless of net direction', () => {
    renderWith([
      makeRow({ ticker: 'AAA', net: 100_000 }),
      makeRow({ ticker: 'BBB', net: -50_000, sell: 50_000 }),
      makeRow({ ticker: 'CCC', net: 0 }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    const tickers = getBodyTickers();
    expect(tickers).toEqual(expect.arrayContaining(['AAA', 'BBB', 'CCC']));
    expect(tickers).toHaveLength(3);
  });

  it('renders a sortable Price column with formatted Polygon close', () => {
    renderWith([
      makeRow({ ticker: 'AAPL', buy: 100_000, net: 100_000, price: 178.42 }),
    ]);
    expect(screen.getByRole('button', { name: /Price/i })).toBeInTheDocument();
    expect(screen.getByText('$178.42')).toBeInTheDocument();
  });

  it('clicking a column header sorts by that field; clicking again reverses', () => {
    renderWith([
      makeRow({ ticker: 'AAA', buy: 50_000, net: 50_000, price: 10 }),
      makeRow({ ticker: 'BBB', buy: 30_000, net: 30_000, price: 100 }),
      makeRow({ ticker: 'CCC', buy: 80_000, net: 80_000, price: 50 }),
    ]);

    // Default Buyers view sorts by net desc → CCC, AAA, BBB
    expect(getBodyTickers()).toEqual(['CCC', 'AAA', 'BBB']);

    // Click "Price" → sort by price desc → BBB(100), CCC(50), AAA(10)
    fireEvent.click(screen.getByRole('button', { name: /Price/i }));
    expect(getBodyTickers()).toEqual(['BBB', 'CCC', 'AAA']);

    // Click "Price" again → ascending → AAA(10), CCC(50), BBB(100)
    fireEvent.click(screen.getByRole('button', { name: /Price/i }));
    expect(getBodyTickers()).toEqual(['AAA', 'CCC', 'BBB']);
  });

  it('sortable columns are exposed for every required field', () => {
    renderWith([makeRow({ ticker: 'AAA', buy: 100, net: 100 })]);
    // Scope to the thead row so the view-toggle button ('Buyers') doesn't
    // collide with the column header of the same name.
    const thead = document.querySelector('thead');
    expect(thead).toBeTruthy();
    const headerScope = within(thead);
    // The kickoff requires: ticker, amount bought, amount sold, net,
    // buyer count, price.
    for (const label of ['Ticker', 'Price', /\$ Bought/, /\$ Sold/, 'Net', 'Buyers']) {
      expect(headerScope.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('toggle to Sellers re-anchors the sort to sellDollars', () => {
    renderWith([
      makeRow({ ticker: 'BIG_SELL', sell: 500_000, net: -500_000 }),
      makeRow({ ticker: 'SMALL_SELL', sell: 100_000, net: -100_000 }),
      makeRow({ ticker: 'MID_SELL', sell: 300_000, net: -300_000 }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Sellers' }));
    // After re-anchor, sort is sellDollars desc.
    expect(getBodyTickers()).toEqual(['BIG_SELL', 'MID_SELL', 'SMALL_SELL']);
  });

  it('shows empty-state message guiding user to other views when Buyers is empty', () => {
    renderWith([
      makeRow({ ticker: 'SELLER', sell: 50_000, net: -50_000 }),
    ]);
    expect(screen.getByText(/No net insider buyers/i)).toBeInTheDocument();
  });
});
