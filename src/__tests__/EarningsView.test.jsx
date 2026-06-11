// Wave-1 regression — EarningsView "+ Log Trade" path.
//
// The onLog handler called `logTrade(...)` but the view only imported
// `readLog`, so clicking the button threw an uncaught ReferenceError and
// the trade was never logged (code-review-2026-06, frontend C2).
// Event-handler errors don't reach the ErrorBoundary, so only a test that
// actually clicks the button catches this. Asserts against the real
// tradeLog module (localStorage), not a mock.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockUseEarnings = vi.fn();

vi.mock('../hooks/useEarnings.js', () => ({
  useEarnings: (...args) => mockUseEarnings(...args),
}));

vi.mock('../components/FreshnessPill.jsx', () => ({
  FreshnessPill: () => <div data-testid="freshness-pill" />,
}));

vi.mock('../components/detail/FundamentalsStrip.jsx', () => ({
  FundamentalsStrip: () => <div data-testid="fundamentals-strip" />,
}));

import { EarningsPlaysView } from '../EarningsView.jsx';
import { readLog } from '../tradeLog.js';

function makeSetup(ticker) {
  return {
    ticker,
    reportDate: '2026-06-15',
    reportTime: 'amc',
    daysUntil: 4,
    playType: 'directional_long',
    strategy: 'Buy shares into the print',
    bias: 'buy_premium',
    postPrint: false,
    composite: 82,
    price: 100,
    expectedMove: 5.2,
    avgPriorMove: 4.1,
    moveRatio: 1.27,
    ivr: 62,
    rationale: 'Beats 7 of 8; positive drift.',
    triggers: null,
    historicalEdge: null,
  };
}

function renderWith(setups) {
  mockUseEarnings.mockReturnValue({
    data: {
      setups,
      universeChecked: 120,
      generatedAt: '2026-06-10T22:00:00.000Z',
    },
    error: null,
    isLoading: false,
    isFetching: false,
    forceRescan: vi.fn(),
  });
  render(<EarningsPlaysView />);
}

describe('EarningsView log-trade path', () => {
  beforeEach(() => {
    mockUseEarnings.mockReset();
    window.localStorage.clear();
  });

  it('clicking "+ Log Trade" logs the trade and flips the button (regression: missing logTrade import)', () => {
    renderWith([makeSetup('DE')]);

    // Expand the row, then log.
    fireEvent.click(screen.getByText('DE'));
    fireEvent.click(screen.getByText('+ Log Trade'));

    expect(screen.getByText('✓ Logged')).toBeInTheDocument();

    const logged = readLog().filter((t) => t.source === 'earnings');
    expect(logged).toHaveLength(1);
    expect(logged[0].ticker).toBe('DE');
    expect(logged[0].reportDate).toBe('2026-06-15');
    expect(logged[0].loggedPrice).toBe(100);
  });
});
