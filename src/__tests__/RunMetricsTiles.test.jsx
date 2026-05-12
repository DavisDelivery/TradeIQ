import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { RunMetricsTiles } from '../components/RunMetricsTiles.jsx';

// Phase 4b — metrics-tile rendering contract.
//
// The Phase 4a engine writes metrics as percentages already
// (totalReturnPct = totalReturn * 100, etc.; see
// netlify/functions/shared/backtest/metrics.ts:198). So a value of
// `7.3012` in the doc means 7.30%, and the tiles must NOT multiply
// again. These tests pin that contract.

describe('RunMetricsTiles', () => {
  it('renders all eight tile labels', () => {
    render(
      <RunMetricsTiles
        metrics={{
          totalReturnPct: 7.3,
          cagrPct: 1.03,
          sharpe: 0.224,
          maxDrawdownPct: -9.2,
          winRatePct: 56.8,
          informationCoefficient: -0.0951,
          informationRatio: 0.05,
          tradeCount: 350,
        }}
      />,
    );
    expect(screen.getByText('Total return')).toBeInTheDocument();
    expect(screen.getByText('CAGR')).toBeInTheDocument();
    expect(screen.getByText('Sharpe')).toBeInTheDocument();
    expect(screen.getByText('Max DD')).toBeInTheDocument();
    expect(screen.getByText('Win rate')).toBeInTheDocument();
    expect(screen.getByText('IC')).toBeInTheDocument();
    expect(screen.getByText('IR vs bench')).toBeInTheDocument();
    expect(screen.getByText('Trades')).toBeInTheDocument();
  });

  it('formats percentage values without re-multiplying by 100', () => {
    render(
      <RunMetricsTiles
        metrics={{ totalReturnPct: 7.3012, cagrPct: 1.03, sharpe: 0.224 }}
      />,
    );
    // 7.30%, NOT 730.12% — engine values are already in pct form.
    expect(screen.getByText('7.30%')).toBeInTheDocument();
    expect(screen.getByText('1.03%')).toBeInTheDocument();
  });

  it('renders Sharpe to three decimal places', () => {
    render(<RunMetricsTiles metrics={{ sharpe: 0.224 }} />);
    expect(screen.getByText('0.224')).toBeInTheDocument();
  });

  it('renders null metric fields as em-dash', () => {
    render(
      <RunMetricsTiles
        metrics={{
          totalReturnPct: null,
          cagrPct: undefined,
          sharpe: null,
          tradeCount: null,
        }}
      />,
    );
    // Multiple tiles end up as — so count matters less than presence.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(4);
  });

  it('handles missing metrics object gracefully (in-flight runs)', () => {
    render(<RunMetricsTiles metrics={undefined} />);
    // All eight tiles render with em-dashes; no crash.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBe(8);
  });

  it('applies emerald color class to positive total return', () => {
    const { container } = render(
      <RunMetricsTiles metrics={{ totalReturnPct: 12.5 }} />,
    );
    const totalReturnTile = screen.getByText('12.50%');
    expect(totalReturnTile.className).toContain('emerald');
  });

  it('applies rose color class to negative total return', () => {
    render(<RunMetricsTiles metrics={{ totalReturnPct: -3.2 }} />);
    const totalReturnTile = screen.getByText('-3.20%');
    expect(totalReturnTile.className).toContain('rose');
  });

  it('always applies rose color to Max DD tile (drawdowns are always bad)', () => {
    render(<RunMetricsTiles metrics={{ maxDrawdownPct: -9.2 }} />);
    const ddTile = screen.getByText('-9.20%');
    expect(ddTile.className).toContain('rose');
  });

  it('renders a benchmark tile when benchmark is provided', () => {
    render(
      <RunMetricsTiles
        metrics={{ totalReturnPct: 7.3 }}
        benchmark={{ ticker: 'SPY', totalReturnPct: 12.4 }}
      />,
    );
    expect(screen.getByText('Bench (SPY)')).toBeInTheDocument();
    expect(screen.getByText('12.40%')).toBeInTheDocument();
  });

  it('does NOT render a benchmark tile when benchmark is null', () => {
    render(<RunMetricsTiles metrics={{ totalReturnPct: 7.3 }} benchmark={null} />);
    expect(screen.queryByText(/^Bench /)).not.toBeInTheDocument();
  });
});
