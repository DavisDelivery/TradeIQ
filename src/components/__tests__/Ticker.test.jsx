// TICKER-1 — the ticker primitive's contract.
//
// "Every ticker opens the company profile" kept regressing because opening a
// profile used to require the surrounding view to hold state and render a
// modal. Every new panel started unable to do that. These tests pin the
// properties that make the capability belong to the primitive instead of the
// view, so a panel cannot be wired up wrong.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Ticker, TickerDetailProvider, useTickerDetail } from '../Ticker.jsx';

// StockDetailPanel fans out to ~10 providers; the contract under test is that
// the overlay OPENS for the right symbol, not what it renders inside.
vi.mock('../detail/StockDetailPanel.jsx', () => ({
  StockDetailPanel: ({ ticker, board }) => (
    <div data-testid="detail-panel">{`${board}:${ticker}`}</div>
  ),
}));

afterEach(() => cleanup());

function withProvider(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TickerDetailProvider>{ui}</TickerDetailProvider>
    </QueryClientProvider>,
  );
}

describe('Ticker', () => {
  it('opens the company profile for the symbol clicked', () => {
    withProvider(<Ticker symbol="PLTR" />);
    expect(screen.queryByTestId('ticker-detail-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('ticker-link-PLTR'));
    expect(screen.getByTestId('ticker-detail-modal')).toBeInTheDocument();
    expect(screen.getByTestId('detail-panel')).toHaveTextContent('search:PLTR');
  });

  it('passes the board and row through, so the profile opens in context', () => {
    withProvider(<Ticker symbol="tbi" board="forward" row={{ rankAtEntry: 9 }} />);
    fireEvent.click(screen.getByTestId('ticker-link-TBI'));
    expect(screen.getByTestId('detail-panel')).toHaveTextContent('forward:TBI');
  });

  it('is a real button — keyboard reachable, not a click handler on a span', () => {
    withProvider(<Ticker symbol="NVDA" />);
    expect(screen.getByTestId('ticker-link-NVDA').tagName).toBe('BUTTON');
  });

  it('carries a visible affordance — an invisible tap target is a dead one', () => {
    // The reported bug was a ticker that WAS clickable but looked exactly like
    // the ones that were not.
    withProvider(<Ticker symbol="AMD" />);
    expect(screen.getByTestId('ticker-link-AMD').className).toMatch(/underline/);
  });

  it('does not also trigger the row it sits inside', () => {
    const rowClick = vi.fn();
    withProvider(
      <div onClick={rowClick}>
        <Ticker symbol="IT" />
      </div>,
    );
    fireEvent.click(screen.getByTestId('ticker-link-IT'));
    expect(screen.getByTestId('ticker-detail-modal')).toBeInTheDocument();
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('renders an em-dash for a missing symbol rather than an empty clickable box', () => {
    withProvider(<Ticker symbol={null} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('degrades to plain text without a provider instead of throwing', () => {
    // Panels are unit-tested in isolation all over this repo; requiring the
    // provider would turn one shared primitive into dozens of broken suites.
    expect(() => render(<Ticker symbol="SPY" />)).not.toThrow();
    expect(screen.getByTestId('ticker-link-SPY')).toBeInTheDocument();
  });

  it('closes the profile again', () => {
    withProvider(<Ticker symbol="NEM" />);
    fireEvent.click(screen.getByTestId('ticker-link-NEM'));
    fireEvent.click(screen.getByLabelText('Close detail'));
    expect(screen.queryByTestId('ticker-detail-modal')).toBeNull();
  });
});

describe('useTickerDetail', () => {
  it('opens from a non-symbol target, e.g. a whole row', () => {
    function Row() {
      const { openTicker } = useTickerDetail();
      return <div data-testid="row" onClick={() => openTicker('LOVE', { board: 'forward' })} />;
    }
    withProvider(<Row />);
    fireEvent.click(screen.getByTestId('row'));
    expect(screen.getByTestId('detail-panel')).toHaveTextContent('forward:LOVE');
  });

  it('is a safe no-op outside a provider', () => {
    function Row() {
      const { openTicker } = useTickerDetail();
      return <div data-testid="row" onClick={() => openTicker('SPY')} />;
    }
    render(<Row />);
    expect(() => fireEvent.click(screen.getByTestId('row'))).not.toThrow();
  });
});
