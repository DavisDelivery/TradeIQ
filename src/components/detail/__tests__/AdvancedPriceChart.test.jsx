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
      remove: () => {},
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

vi.mock('../../../hooks/usePriceHistory.js', () => ({
  usePriceHistory: () => ({ data: { bars: BARS }, isLoading: false, isError: false }),
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
});
