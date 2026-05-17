// Phase 4j W4 — PriceChart component tests.
//
// Verifies the panel surface: range toggle, type toggle, loading +
// empty + error states. We intentionally don't snapshot the SVG output
// of recharts - those tests are fragile against library updates and
// don't catch real regressions. We test the API contract of the buttons
// instead.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { PriceChart, _internals } from '../components/PriceChart.jsx';

// Recharts uses ResizeObserver internally; jsdom doesn't ship one.
beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fakeBars() {
  return [
    { date: '2026-05-12', open: 100, high: 102, low: 99, close: 101, volume: 1 },
    { date: '2026-05-13', open: 101, high: 103, low: 100, close: 102, volume: 1 },
    { date: '2026-05-14', open: 102, high: 104, low: 101, close: 103, volume: 1 },
    { date: '2026-05-15', open: 103, high: 105, low: 102, close: 104, volume: 1 },
  ];
}

function mockOnce(payload, { ok = true, status = 200 } = {}) {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok,
    status,
    json: async () => payload,
  });
}

describe('PriceChart', () => {
  it('exposes the canonical range set: 1M, 6M, 1Y, All — default 6M', () => {
    expect(_internals.RANGES).toEqual(['1M', '6M', '1Y', 'All']);
    expect(_internals.DEFAULT_RANGE).toBe('6M');
  });

  it('defaults to the 6M range on first render (requests range=6M)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ ok: true, ticker: 'AAPL', range: '6M', bars: fakeBars() }),
    });
    global.fetch = fetchSpy;
    render(<PriceChart ticker="AAPL" />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain('ticker=AAPL');
    expect(url).toContain('range=6M');
  });

  it('renders all four range buttons', async () => {
    mockOnce({ ok: true, ticker: 'AAPL', range: '6M', bars: fakeBars() });
    render(<PriceChart ticker="AAPL" />);
    // Wait for first render to settle
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalled(),
    );
    expect(screen.getByText('1M')).toBeInTheDocument();
    expect(screen.getByText('6M')).toBeInTheDocument();
    expect(screen.getByText('1Y')).toBeInTheDocument();
    expect(screen.getByText('All')).toBeInTheDocument();
  });

  it('clicking a different range refetches with the new range', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ ok: true, ticker: 'AAPL', range: '6M', bars: fakeBars() }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ ok: true, ticker: 'AAPL', range: '1Y', bars: fakeBars() }),
      });
    global.fetch = fetchSpy;
    render(<PriceChart ticker="AAPL" />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('1Y'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(fetchSpy.mock.calls[1][0]).toContain('range=1Y');
  });

  it('chart-type toggle starts as "switch to candle" and flips to "switch to area"', async () => {
    mockOnce({ ok: true, ticker: 'AAPL', range: '6M', bars: fakeBars() });
    render(<PriceChart ticker="AAPL" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    // Default mode is area, so the button offers to switch TO candle.
    const toggle = screen.getByLabelText('Toggle chart type');
    expect(toggle.textContent).toMatch(/candle/i);
    fireEvent.click(toggle);
    // After click, mode is candle, so the button offers to switch TO area.
    expect(toggle.textContent).toMatch(/area/i);
  });

  it('renders the empty-state message when bars=[]', async () => {
    mockOnce({ ok: true, ticker: 'OBSC', range: '6M', bars: [] });
    render(<PriceChart ticker="OBSC" />);
    expect(
      await screen.findByText(/No price history for this range/i),
    ).toBeInTheDocument();
  });

  it('renders the error message when the endpoint fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({ ok: false, error: 'polygon 500' }),
    });
    render(<PriceChart ticker="AAPL" />);
    expect(
      await screen.findByText(/Price history unavailable/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/polygon 500/i)).toBeInTheDocument();
  });

  it('refetches when the ticker prop changes', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ ok: true, ticker: 'AAPL', range: '6M', bars: fakeBars() }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ ok: true, ticker: 'TSLA', range: '6M', bars: fakeBars() }),
      });
    global.fetch = fetchSpy;
    const { rerender } = render(<PriceChart ticker="AAPL" />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    rerender(<PriceChart ticker="TSLA" />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(fetchSpy.mock.calls[1][0]).toContain('ticker=TSLA');
  });
});
