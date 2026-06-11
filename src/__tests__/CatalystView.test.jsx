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
});
