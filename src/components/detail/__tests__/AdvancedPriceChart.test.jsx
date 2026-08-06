// AdvancedPriceChart smoke tests — lightweight-charts is mocked (canvas
// doesn't exist in jsdom); the tests pin the WIRING: candles receive
// OHLC data, volume gets its own pane, strategy price lines are created,
// and the legend renders the latest bar's OHLCV.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const seriesCalls = [];
const priceLineCalls = [];
const setDataCalls = [];
// Spy on teardown: the chart effect's cleanup calls chart.remove(), so a
// remove() during a parent re-render means the chart was destroyed and
// rebuilt (see the priceLinesKey test at the bottom).
const removeSpy = vi.fn();

vi.mock('lightweight-charts', () => {
  const mkSeries = (label) => ({
    setData: (d) => setDataCalls.push({ label, count: d.length, sample: d[0] }),
    createPriceLine: (opts) => priceLineCalls.push(opts),
  });
  return {
    CandlestickSeries: 'CANDLES',
    LineSeries: 'LINE',
    AreaSeries: 'AREA',
    HistogramSeries: 'HISTO',
    CrosshairMode: { Normal: 1 },
    PriceScaleMode: { Normal: 0, Logarithmic: 1 },
    createChart: vi.fn(() => ({
      addSeries: (kind, _opts, paneIndex) => {
        seriesCalls.push({ kind, paneIndex: paneIndex ?? 0 });
        return mkSeries(kind);
      },
      panes: () => [{ setHeight: () => {} }, { setHeight: () => {} }, { setHeight: () => {} }],
      subscribeCrosshairMove: () => {},
      unsubscribeCrosshairMove: () => {},
      timeScale: () => ({ fitContent: () => {} }),
      remove: removeSpy,
    })),
  };
});

const BARS = Array.from({ length: 60 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 3, 1 + i));
  const c = 100 + i;
  return {
    date: d.toISOString().slice(0, 10),
    open: c - 0.5,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 1_000_000 + i,
  };
});

// Return a STABLE result object. The real hook is staleTime/gcTime Infinity
// with refetchOnWindowFocus off, so query.data keeps its identity across
// re-renders; a mock minting a fresh literal each call would make `bars`
// unstable in the test only, and would mask the priceLines rebuild fix.
const PRICE_HISTORY_RESULT = { data: { bars: BARS }, isLoading: false, isError: false };
vi.mock('../../../hooks/usePriceHistory.js', () => ({
  usePriceHistory: () => PRICE_HISTORY_RESULT,
}));

import { AdvancedPriceChart } from '../AdvancedPriceChart.jsx';

function renderChart(props = {}) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AdvancedPriceChart ticker="CNC" {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  seriesCalls.length = 0;
  priceLineCalls.length = 0;
  setDataCalls.length = 0;
});

describe('AdvancedPriceChart', () => {
  it('renders candles by default with OHLC data and a volume pane', () => {
    renderChart();
    expect(seriesCalls.some((s) => s.kind === 'CANDLES' && s.paneIndex === 0)).toBe(true);
    expect(seriesCalls.some((s) => s.kind === 'HISTO' && s.paneIndex === 1)).toBe(true);
    const candleData = setDataCalls.find((c) => c.label === 'CANDLES');
    expect(candleData.count).toBe(BARS.length);
    expect(candleData.sample).toMatchObject({ open: 99.5, high: 101, low: 99, close: 100 });
  });

  it('creates strategy price lines for FABLE pivot/stop', () => {
    renderChart({
      priceLines: [
        { price: 169.29, color: '#38bdf8', title: 'entry pivot' },
        { price: 148.9, color: '#ff5577', title: 'stop' },
      ],
    });
    expect(priceLineCalls.map((p) => p.title)).toEqual(expect.arrayContaining(['entry pivot', 'stop']));
    expect(priceLineCalls.find((p) => p.title === 'stop').price).toBeCloseTo(148.9);
  });

  it('legend shows the latest bar OHLCV; controls render (ranges, types, MAs, RSI, Log)', () => {
    renderChart();
    const legend = screen.getByTestId('ohlc-legend');
    expect(legend.textContent).toContain(BARS[BARS.length - 1].date);
    for (const label of ['1M', '3M', '6M', '1Y', '5Y', 'Candles', 'Line', 'Area', 'MA50', 'MA200', 'RSI', 'Log']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('default MA overlays (50/200) are added as line series on the price pane', () => {
    renderChart();
    const lines = seriesCalls.filter((s) => s.kind === 'LINE' && s.paneIndex === 0);
    expect(lines.length).toBe(1); // only MA50 fits a 60-bar window; MA200 has no points
  });

  // Regression: a poll-driven parent re-render must NOT destroy the chart.
  //
  // `priceLines` was in the effect's dep array by IDENTITY, and every call
  // site passes either the `= []` default or an inline literal — both mint a
  // fresh array each render. Parents poll live quotes every 15-30s, so the
  // chart was being torn down and rebuilt 2-4x a minute, resetting pan/zoom
  // and recomputing every indicator. Keying on serialized content fixes all
  // five call sites at once.
  it('does NOT rebuild when a re-render passes an equal-but-new priceLines array', () => {
    removeSpy.mockClear();
    // Reuse ONE QueryClient across both renders. Passing a new client would
    // change the provider identity, unmount the subtree, and call remove()
    // for a legitimate reason — masking what this test is actually pinning.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (lines) => (
      <QueryClientProvider client={qc}>
        <AdvancedPriceChart ticker="NVDA" priceLines={lines} />
      </QueryClientProvider>
    );

    const { rerender } = render(tree([{ price: 100, color: '#fff', title: 'entry' }]));
    const before = removeSpy.mock.calls.length;

    // Same CONTENT, new array identity — exactly what a live-quote poll does.
    rerender(tree([{ price: 100, color: '#fff', title: 'entry' }]));
    expect(removeSpy.mock.calls.length).toBe(before);
  });
});
