// PROFILE-1 W3.2 — every metric on the profile opens.
//
// The gap this closes: W3 wired the drawer into KeyMetricsPanel only, and
// even there six rows carried no key and so rendered as plain text. The
// ownership and tradability panels — eleven more rows, four of them backed
// by columns the peer engine already reads — had no drawer at all. Under
// half the metrics on the page were tappable, which reads as "the ones that
// open are special" rather than "this one is still loading".

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { OwnershipPanel } from '../OwnershipPanel.jsx';
import { TradabilityStrip } from '../TradabilityStrip.jsx';

const OWNERSHIP = {
  instOwnPct: 61.2, insiderOwnPct: 0.07, insiderTransPct: -1.4,
  shortFloatPct: 22.5, shortRatio: 6.2, floatM: 15_000,
};

const TRADABILITY = {
  advDollar: 1e10, atr: 4.5, atrPct: 2.3, relativeVolume: 1.3, floatM: 15_000,
};

const PEER_URLS = [];

/**
 * URL-aware, because this exercise is precisely about which endpoint a tap
 * reaches. A mock that answers every URL identically would pass even if the
 * drawer requested the wrong metric.
 */
function mountWith(finviz, ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('peer-stats')) {
      PEER_URLS.push(u);
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true, stat: null, reason: 'no-pool',
          policy: {
            label: 'Metric', meaning: 'A plain definition of the metric in question.',
            caveat: null, direction: 'neutral', band: null, showBeside: [],
          },
          note: 'No pool for this one.',
        }),
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, ticker: 'AAPL', finviz }),
    };
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => { vi.restoreAllMocks(); PEER_URLS.length = 0; });

describe('OwnershipPanel — all six rows drill down', () => {
  it('renders every row as a button', async () => {
    mountWith({ ownership: OWNERSHIP }, <OwnershipPanel ticker="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('ownership-panel')).toBeInTheDocument());
    for (const label of [
      'Institutional', 'Insider', 'Insider net trans.',
      'Float', 'Short % of float', 'Days to cover',
    ]) {
      const row = screen.getByTestId(`own-${label}`);
      expect(within(row).getByRole('button'), `${label} is not clickable`).toBeInTheDocument();
    }
  });

  it('opening a row fetches that row’s metric, not another', async () => {
    mountWith({ ownership: OWNERSHIP }, <OwnershipPanel ticker="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('ownership-panel')).toBeInTheDocument());

    fireEvent.click(
      within(screen.getByTestId('own-Days to cover')).getByRole('button'));

    await waitFor(() => expect(PEER_URLS.length).toBe(1));
    expect(PEER_URLS[0]).toMatch(/metric=shortRatio/);
    expect(PEER_URLS[0]).toMatch(/ticker=AAPL/);
  });

  it('shows the definition once open', async () => {
    mountWith({ ownership: OWNERSHIP }, <OwnershipPanel ticker="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('ownership-panel')).toBeInTheDocument());
    fireEvent.click(
      within(screen.getByTestId('own-Institutional')).getByRole('button'));
    await waitFor(() =>
      expect(screen.getByText(/A plain definition of the metric/)).toBeInTheDocument());
  });

  it('fetches nothing until something is tapped', async () => {
    mountWith({ ownership: OWNERSHIP }, <OwnershipPanel ticker="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('ownership-panel')).toBeInTheDocument());
    expect(PEER_URLS).toEqual([]);
  });

  it('opens one row at a time', async () => {
    mountWith({ ownership: OWNERSHIP }, <OwnershipPanel ticker="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('ownership-panel')).toBeInTheDocument());

    const inst = within(screen.getByTestId('own-Institutional')).getByRole('button');
    const days = within(screen.getByTestId('own-Days to cover')).getByRole('button');

    fireEvent.click(inst);
    await waitFor(() => expect(inst).toHaveAttribute('aria-expanded', 'true'));

    fireEvent.click(days);
    await waitFor(() => expect(days).toHaveAttribute('aria-expanded', 'true'));
    expect(inst).toHaveAttribute('aria-expanded', 'false');
  });

  it('a second tap on the same row closes it', async () => {
    mountWith({ ownership: OWNERSHIP }, <OwnershipPanel ticker="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('ownership-panel')).toBeInTheDocument());
    const btn = within(screen.getByTestId('own-Float')).getByRole('button');
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute('aria-expanded', 'true'));
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute('aria-expanded', 'false'));
  });
});

describe('TradabilityStrip — all five cells drill down', () => {
  it('renders every cell as a button', async () => {
    mountWith({ tradability: TRADABILITY }, <TradabilityStrip ticker="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('tradability-strip')).toBeInTheDocument());
    for (const label of ['Avg $ vol', 'ATR', 'ATR %', 'Rel. vol', 'Float']) {
      expect(screen.getByTestId(`trad-${label}`).tagName).toBe('BUTTON');
    }
  });

  it('tapping a cell requests that cell’s metric', async () => {
    mountWith({ tradability: TRADABILITY }, <TradabilityStrip ticker="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('tradability-strip')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('trad-ATR %'));
    await waitFor(() => expect(PEER_URLS.length).toBe(1));
    expect(PEER_URLS[0]).toMatch(/metric=atrPct/);
  });

  it('ATR dollars and ATR percent are separate metrics, not one cell twice', async () => {
    // They are deliberately both shown — dollars is what a stop is written
    // in, percent is what makes two names comparable — so they must not
    // collapse to the same drawer.
    mountWith({ tradability: TRADABILITY }, <TradabilityStrip ticker="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('tradability-strip')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('trad-ATR'));
    await waitFor(() => expect(PEER_URLS.length).toBe(1));
    fireEvent.click(screen.getByTestId('trad-ATR %'));
    await waitFor(() => expect(PEER_URLS.length).toBe(2));

    expect(PEER_URLS[0]).toMatch(/metric=atr(&|$)/);
    expect(PEER_URLS[1]).toMatch(/metric=atrPct/);
  });

  it('the drawer sits below the strip, so cells do not reflow sideways', async () => {
    mountWith({ tradability: TRADABILITY }, <TradabilityStrip ticker="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('tradability-strip')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('trad-Float'));

    const drawer = screen.getByTestId('peer-drawer');
    const cell = screen.getByTestId('trad-Float');
    expect(cell.contains(drawer)).toBe(false);
    expect(screen.getByTestId('tradability-strip').contains(drawer)).toBe(true);
  });

  it('fetches nothing while every cell is closed', async () => {
    mountWith({ tradability: TRADABILITY }, <TradabilityStrip ticker="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('tradability-strip')).toBeInTheDocument());
    expect(PEER_URLS).toEqual([]);
  });
});
