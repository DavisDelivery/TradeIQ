// Wave-1 regression — CatalystView render-with-data smoke test.
//
// The board crashed in production the moment data loaded: the refresh
// button's onClick referenced `load`, an identifier deleted when the
// data-fetch migrated to useCatalyst (code-review-2026-06, frontend C1).
// No test rendered the view with data, so the ReferenceError shipped.
// This test pins the data branch: it must render, and refresh must call
// forceRescan.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockUseCatalyst = vi.fn();

vi.mock('../hooks/useCatalyst.js', () => ({
  useCatalyst: (...args) => mockUseCatalyst(...args),
}));

// Live-quote overlay is orthogonal to this render smoke test and pulls in
// TanStack Query (needs a provider); stub it as a pass-through.
vi.mock('../hooks/useLiveQuotes.js', () => ({
  useLiveRows: (rows) => rows ?? [],
  useLiveQuotes: () => ({ quotesByTicker: {}, isFetching: false }),
}));

vi.mock('../components/FreshnessPill.jsx', () => ({
  FreshnessPill: () => <div data-testid="freshness-pill" />,
}));

vi.mock('../components/detail/FundamentalsStrip.jsx', () => ({
  FundamentalsStrip: () => <div data-testid="fundamentals-strip" />,
}));

vi.mock('../components/CatalystBadges.jsx', () => ({
  CatalystBadges: () => <div data-testid="catalyst-badges" />,
  ConvictionChip: () => <span />,
  CatalystChip: () => <span />,
}));

import { CatalystView } from '../CatalystView.jsx';

function makePick(ticker) {
  return {
    ticker,
    name: `${ticker} Inc`,
    sector: 'Technology',
    composite: 78,
    conviction: 'high',
    direction: 'long',
    price: 123.45,
    priceChangePct: 1.2,
    rationale: 'Cluster buying plus stacked setups.',
    tags: ['cluster'],
    components: {},
    setupLabels: [],
  };
}

function renderWith({ picks = [], forceRescan = vi.fn() } = {}) {
  mockUseCatalyst.mockReturnValue({
    data: {
      picks,
      matched: picks.length,
      universeChecked: 503,
      generatedAt: '2026-06-10T22:00:00.000Z',
    },
    error: null,
    isLoading: false,
    isFetching: false,
    forceRescan,
  });
  render(<CatalystView universe="sp500" />);
  return { forceRescan };
}

describe('CatalystView (data loaded)', () => {
  beforeEach(() => {
    mockUseCatalyst.mockReset();
  });

  it('renders the data branch without throwing (regression: deleted `load` ref)', () => {
    renderWith({ picks: [makePick('NVDA')] });
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(screen.getByText(/1 matched \/ 503 scanned/)).toBeInTheDocument();
  });

  it('renders the empty-picks data branch without throwing', () => {
    renderWith({ picks: [] });
    expect(screen.getByText(/No tickers match these filters/)).toBeInTheDocument();
  });

  it('refresh button triggers forceRescan', () => {
    const { forceRescan } = renderWith({ picks: [makePick('NVDA')] });
    fireEvent.click(screen.getByText('refresh'));
    expect(forceRescan).toHaveBeenCalledTimes(1);
  });

  // Wave 4D (code-review-2026-06 m11) — FundamentalsStrip carries
  // role="button" + tabIndex=0 and used to render INSIDE the row's
  // <button>: invalid nested interactive elements, double-activation on
  // keyboard. It must be a sibling of the row toggle button, never a
  // descendant.
  it('does not nest FundamentalsStrip inside the row toggle button', () => {
    renderWith({ picks: [makePick('NVDA')] });
    const strip = screen.getByTestId('fundamentals-strip');
    expect(strip.closest('button')).toBeNull();
  });

  it('row toggle button still expands the detail panel', () => {
    renderWith({ picks: [makePick('NVDA')] });
    // The row header (ticker) lives inside the toggle button.
    const toggle = screen.getByText('NVDA').closest('button');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle);
    // CatalystDetail renders the per-component breakdown sections.
    expect(screen.getByText('Insider')).toBeInTheDocument();
    expect(screen.getByText('Patents')).toBeInTheDocument();
  });
});
