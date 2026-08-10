// PROFILE-1 W1.1 — the tradability strip.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  TradabilityStrip,
  tradabilityCells,
  fmtUsdCompact,
  fmtShares,
  fmtPct,
  fmtNum,
} from '../TradabilityStrip.jsx';

function renderStrip(tradability) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, ticker: 'AAPL', finviz: tradability ? { tradability } : null }),
  }));
  return render(
    <QueryClientProvider client={qc}>
      <TradabilityStrip ticker="AAPL" />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

const full = {
  advDollar: 10_000_000_000, avgVolume: 50_000_000, relativeVolume: 1.3,
  atr: 4.5, atrPct: 2.25, floatM: 15_000, price: 200,
};

describe('rendering', () => {
  it('shows the position-sizing facts', async () => {
    renderStrip(full);
    await waitFor(() => expect(screen.getByTestId('tradability-strip')).toBeInTheDocument());
    expect(screen.getByText('$10.0B')).toBeInTheDocument();  // ADV$
    expect(screen.getByText('$4.50')).toBeInTheDocument();   // ATR dollars
    expect(screen.getByText('2.3%')).toBeInTheDocument();    // ATR percent
    expect(screen.getByText('1.30')).toBeInTheDocument();    // relative volume
    expect(screen.getByText('15.00B')).toBeInTheDocument();  // float (millions -> B)
  });

  it('shows ATR in BOTH dollars and percent', async () => {
    // Dollars is what a stop is written in; percent is what makes two names
    // comparable. Either alone is half the answer.
    renderStrip(full);
    await waitFor(() => expect(screen.getByTestId('trad-ATR')).toBeInTheDocument());
    expect(screen.getByTestId('trad-ATR %')).toBeInTheDocument();
  });

  it('frames itself as not-a-signal', async () => {
    renderStrip(full);
    await waitFor(() => expect(screen.getByText(/not a signal/)).toBeInTheDocument());
  });

  it('uses tabular-nums so the row aligns', async () => {
    renderStrip(full);
    await waitFor(() => expect(screen.getByText('$10.0B')).toBeInTheDocument());
    expect(screen.getByText('$10.0B').className).toMatch(/tabular-nums/);
  });
});

describe('absent data', () => {
  it('renders NOTHING rather than a strip of dashes', async () => {
    // Five dashes in a row is worse than no strip: it occupies the most
    // valuable space on the page to say nothing.
    const { container } = renderStrip({
      advDollar: null, avgVolume: null, relativeVolume: null,
      atr: null, atrPct: null, floatM: null, price: null,
    });
    await waitFor(() => expect(container.querySelector('[data-testid="tradability-strip"]')).toBeNull());
  });

  it('renders nothing when the finviz block is missing entirely', async () => {
    const { container } = renderStrip(null);
    await waitFor(() => expect(container.querySelector('[data-testid="tradability-strip"]')).toBeNull());
  });

  it('renders the cells it DOES have', async () => {
    renderStrip({ ...full, atr: null, atrPct: null, relativeVolume: null });
    await waitFor(() => expect(screen.getByTestId('tradability-strip')).toBeInTheDocument());
    expect(screen.getByTestId('trad-Avg $ vol')).toBeInTheDocument();
    expect(screen.queryByTestId('trad-ATR')).not.toBeInTheDocument();
  });
});

describe('tradabilityCells', () => {
  it('drops null cells and keeps real zeros', () => {
    const cells = tradabilityCells({ ...full, relativeVolume: 0, atr: null, atrPct: null });
    const labels = cells.map((c) => c.label);
    expect(labels).toContain('Rel. vol'); // 0 is a measurement
    expect(labels).not.toContain('ATR');
  });

  it('returns nothing for a null block', () => {
    expect(tradabilityCells(null)).toEqual([]);
    expect(tradabilityCells(undefined)).toEqual([]);
  });
});

describe('formatters', () => {
  it('compacts dollars by magnitude', () => {
    expect(fmtUsdCompact(1.5e12)).toBe('$1.50T');
    expect(fmtUsdCompact(2.4e9)).toBe('$2.4B');
    expect(fmtUsdCompact(7e6)).toBe('$7M');
    expect(fmtUsdCompact(500)).toBe('$500');
  });

  it('renders float from MILLIONS of shares', () => {
    // Finviz's unit is millions; 15,000 is 15 billion shares, not 15,000.
    expect(fmtShares(15_000)).toBe('15.00B');
    expect(fmtShares(320)).toBe('320M');
  });

  it('dashes out unusable values rather than printing NaN', () => {
    for (const bad of [null, undefined, Number.NaN, Infinity]) {
      expect(fmtUsdCompact(bad)).toBe('—');
      expect(fmtShares(bad)).toBe('—');
      expect(fmtPct(bad)).toBe('—');
      expect(fmtNum(bad)).toBe('—');
    }
  });
});
