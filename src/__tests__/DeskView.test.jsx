// DESK-1 W5 — DeskView smoke tests at both breakpoints + watchlist
// behavior: sortable columns, null-quote em-dash fallback, signal
// verdict chips, focus wiring, positions + base-rate rails.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

const mockUseBreakpoint = vi.fn();
const mockUseRegime = vi.fn();
const mockUseLiveQuotes = vi.fn();
const mockUseDeskStats = vi.fn();
const mockUseEarningsRadar = vi.fn();
const mockUseTargetBoard = vi.fn();
const mockUseProphet = vi.fn();

vi.mock('../hooks/useBreakpoint.js', () => ({
  useBreakpoint: (...a) => mockUseBreakpoint(...a),
  DESKTOP_BREAKPOINT_PX: 1280,
}));
vi.mock('../hooks/useRegime.js', () => ({ useRegime: (...a) => mockUseRegime(...a) }));
vi.mock('../hooks/useLiveQuotes.js', () => ({
  useLiveQuotes: (...a) => mockUseLiveQuotes(...a),
  overlayQuotes: (rows) => rows,
}));
vi.mock('../hooks/useDeskStats.js', () => ({ useDeskStats: (...a) => mockUseDeskStats(...a) }));
vi.mock('../hooks/useEarningsRadar.js', () => ({ useEarningsRadar: (...a) => mockUseEarningsRadar(...a) }));
vi.mock('../hooks/useTargetBoard.js', () => ({ useTargetBoard: (...a) => mockUseTargetBoard(...a) }));
// BrokerPanel uses a raw useQuery (needs a QueryClientProvider this harness
// deliberately omits) — stub it; it renders null until a broker sync exists
// anyway, and has no assertions here.
vi.mock('../components/desk/BrokerPanel.jsx', () => ({ BrokerPanel: () => null }));
vi.mock('../hooks/useProphet.js', () => ({ useProphet: (...a) => mockUseProphet(...a) }));
// The focus workspace's heavy children are covered by their own suites.
vi.mock('../components/detail/AdvancedPriceChart.jsx', () => ({
  AdvancedPriceChart: ({ ticker }) => <div data-testid="price-chart">{ticker}</div>,
}));
vi.mock('../components/desk/DossierTabs.jsx', () => ({
  DossierTabs: ({ ticker }) => <div data-testid="dossier">{ticker}</div>,
}));
vi.mock('../firebase.js', () => ({ fbOps: async () => null }));

import { DeskView } from '../DeskView.jsx';
import { _internals as watchInternals } from '../watchlist.js';

const WATCH_KEY = watchInternals.LOCAL_KEY;
const LOG_KEY = 'tradeiq.tradeLog.v1';

function seedDefaults() {
  mockUseBreakpoint.mockReturnValue({ isDesktop: true, isMobile: false });
  mockUseRegime.mockReturnValue({ data: { regime: 'risk_on', conviction: 'high' } });
  mockUseLiveQuotes.mockReturnValue({
    quotesByTicker: { AAPL: { price: 210.55, changePct: 1.23 }, SPY: { price: 620.1, changePct: 0.4 } },
    quotesAsOf: new Date().toISOString(),
    dataUpdatedAt: Date.now(),
    isFetching: false,
  });
  mockUseDeskStats.mockReturnValue({
    statsByTicker: {
      AAPL: {
        ticker: 'AAPL', name: 'Apple Inc.', sector: 'Technology', marketCap: 3e12,
        last: 209.1, spark: [200, 205, 210], atrPct14: 2.1,
        dist52wHighPct: -4.2, dist52wLowPct: 31.5, avgVol20: 55_000_000, asOfDate: '2026-07-10',
      },
      // MSFT: intentionally NO stats and NO quote → em-dash fallbacks.
    },
    warnings: [],
    isLoading: false,
    error: null,
  });
  mockUseEarningsRadar.mockReturnValue({
    radarByTicker: {
      AAPL: {
        ticker: 'AAPL', nextEarningsDate: '2026-07-14', daysUntil: 4,
        beatsLast4: 3, beatsLast4Quarters: 4, lastSurprisePct: 2.5, surpriseHistory: [],
      },
    },
    isLoading: false,
    error: null,
  });
  mockUseTargetBoard.mockReturnValue({
    data: { targets: [{ ticker: 'AAPL', tier: 'A', composite: 78 }] },
  });
  mockUseProphet.mockReturnValue({ data: { picks: [] } });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(WATCH_KEY, JSON.stringify([
    { ticker: 'AAPL', addedAt: '2026-07-01T00:00:00.000Z' },
    { ticker: 'MSFT', addedAt: '2026-07-02T00:00:00.000Z' },
  ]));
  localStorage.setItem(LOG_KEY, JSON.stringify([
    { id: 'open-1', ticker: 'AAPL', source: 'board', loggedAt: '2026-07-01T00:00:00.000Z', loggedPrice: 200, stop: 190, setup: 'breakout' },
    { id: 'closed-1', ticker: 'AMD', source: 'board', loggedAt: '2026-05-01T00:00:00.000Z', loggedPrice: 100, exitPrice: 110, exitAt: '2026-06-01T00:00:00.000Z', setup: 'breakout' },
  ]));
  seedDefaults();
});

afterEach(() => cleanup());

describe('DeskView — desktop', () => {
  it('renders all three regions: tape, watchlist, focus, positions, base rates, radar', () => {
    render(<DeskView />);
    expect(screen.getByTestId('desk-view')).toBeInTheDocument();
    expect(screen.getByTestId('desk-tape')).toBeInTheDocument();
    expect(screen.getByTestId('desk-watchlist')).toBeInTheDocument();
    // No ticker is auto-focused on load — the focus region shows its empty
    // state until the user opens one from the watchlist.
    expect(screen.getByTestId('desk-focus-empty')).toBeInTheDocument();
    expect(screen.getByTestId('desk-positions')).toBeInTheDocument();
    expect(screen.getByTestId('desk-baserates')).toBeInTheDocument();
    expect(screen.getByTestId('desk-earnings-radar')).toBeInTheDocument();
  });

  it('tape shows the four index cells, regime pill + exposure band, and a quote-age stamp', () => {
    render(<DeskView />);
    for (const t of ['SPY', 'QQQ', 'IWM', 'DIA']) {
      expect(screen.getByTestId(`tape-${t}`)).toBeInTheDocument();
    }
    const pill = screen.getByTestId('desk-regime-pill');
    expect(pill).toHaveTextContent(/risk on/i);
    expect(pill).toHaveTextContent(/80–100% gross/);
    expect(screen.getByTestId('tape-age')).toHaveTextContent(/quotes/i);
  });

  it('watchlist row overlays the live quote; missing quote+stats renders em-dashes, never 0', () => {
    render(<DeskView />);
    const aapl = screen.getByTestId('watch-row-AAPL');
    expect(within(aapl).getByText('210.55')).toBeInTheDocument(); // live overlay wins
    expect(within(aapl).getByText('+1.23%')).toBeInTheDocument();
    const msft = screen.getByTestId('watch-row-MSFT');
    expect(within(msft).queryByText('0')).not.toBeInTheDocument();
    expect(within(msft).queryByText(/\$null/)).not.toBeInTheDocument();
    expect(within(msft).getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('signal cell carries the board verdict chip (evidence, not prediction)', () => {
    render(<DeskView />);
    const aapl = screen.getByTestId('watch-row-AAPL');
    expect(within(aapl).getByText('TGT A·78')).toBeInTheDocument();
    expect(within(aapl).getByTestId('verdict-chip-target')).toBeInTheDocument();
  });

  it('watchlist columns sort on header click (Last ascends/descends)', () => {
    render(<DeskView />);
    const watchlist = screen.getByTestId('desk-watchlist');
    const rowsBefore = screen.getAllByTestId(/^watch-row-/).map((r) => r.getAttribute('data-testid'));
    expect(rowsBefore).toEqual(['watch-row-AAPL', 'watch-row-MSFT']); // default ticker asc
    fireEvent.click(within(watchlist).getByRole('button', { name: /^Last$/i }));
    // desc: AAPL (210.55) first, MSFT (null → last) stays last; flip to asc:
    fireEvent.click(within(watchlist).getByRole('button', { name: /^Last$/i }));
    const rowsAsc = screen.getAllByTestId(/^watch-row-/).map((r) => r.getAttribute('data-testid'));
    expect(rowsAsc[0]).toBe('watch-row-AAPL'); // nulls always last regardless of dir
    expect(rowsAsc[1]).toBe('watch-row-MSFT');
  });

  it('row click focuses the ticker in the center workspace', () => {
    render(<DeskView />);
    fireEvent.click(screen.getByTestId('watch-row-MSFT'));
    expect(screen.getByTestId('price-chart')).toHaveTextContent('MSFT');
    expect(screen.getByTestId('dossier')).toHaveTextContent('MSFT');
  });

  it('positions rail: open trade live-marked with unrealized %, R-multiple and days held; closed trade excluded', () => {
    render(<DeskView />);
    const positions = screen.getByTestId('desk-positions');
    const row = within(positions).getByTestId('position-row-AAPL');
    expect(within(row).getByText('200.00')).toBeInTheDocument();   // entry
    expect(within(row).getByText('210.55')).toBeInTheDocument();   // live mark
    expect(within(row).getByText('+5.3%')).toBeInTheDocument();    // unrealized %
    expect(within(row).getByText('1.06R')).toBeInTheDocument();    // (210.55-200)/(200-190)
    expect(within(positions).queryByTestId('position-row-AMD')).not.toBeInTheDocument();
  });

  it('base rates render from closed trades with the insufficient-sample gate', () => {
    render(<DeskView />);
    const rates = screen.getByTestId('desk-baserates');
    const row = within(rates).getByTestId('baserate-row-breakout');
    expect(row).toHaveTextContent(/insufficient sample/i); // n=1 closed
    expect(row).toHaveTextContent('100%'); // win rate shown but greyed
  });

  it('earnings radar lists upcoming reports with the honest beat denominator', () => {
    render(<DeskView />);
    const radar = screen.getByTestId('desk-earnings-radar');
    expect(within(radar).getByText('4d')).toBeInTheDocument();
    expect(within(radar).getByText('3/4')).toBeInTheDocument();
  });
});

describe('DeskView — mobile', () => {
  it('stacks the same modules below the tape strip', () => {
    mockUseBreakpoint.mockReturnValue({ isDesktop: false, isMobile: true });
    render(<DeskView />);
    expect(screen.getByTestId('desk-view')).toBeInTheDocument();
    expect(screen.getByTestId('desk-tape')).toBeInTheDocument();
    expect(screen.getByTestId('desk-watchlist')).toBeInTheDocument();
    expect(screen.getByTestId('desk-positions')).toBeInTheDocument();
    expect(screen.getByTestId('desk-baserates')).toBeInTheDocument();
    expect(screen.getByTestId('desk-earnings-radar')).toBeInTheDocument();
  });

  it('empty watchlist shows the add-first hint instead of a table', () => {
    mockUseBreakpoint.mockReturnValue({ isDesktop: false, isMobile: true });
    localStorage.setItem(WATCH_KEY, JSON.stringify([]));
    render(<DeskView />);
    expect(screen.getByText(/Add a ticker above/i)).toBeInTheDocument();
    expect(screen.getByTestId('desk-focus-empty')).toBeInTheDocument();
  });
});
