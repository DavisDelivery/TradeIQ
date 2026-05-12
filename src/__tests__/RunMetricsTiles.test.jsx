import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunMetricsTiles } from '../components/RunMetricsTiles.jsx';

describe('RunMetricsTiles', () => {
  it('formats positive return with emerald color and percent', () => {
    const { container } = render(
      <RunMetricsTiles
        metrics={{
          totalReturn: 0.0730,
          cagr: 0.0103,
          sharpe: 0.224,
          sortino: 0.181,
          maxDrawdown: -0.0924,
          winRate: 0.568,
          ic: 0.0,
          informationRatio: -0.436,
          trades: 350,
        }}
      />,
    );
    expect(screen.getByText('7.30%')).toBeTruthy();
    // totalReturn tile should be emerald-colored (positive)
    const totalReturnTile = screen.getByText('7.30%').className;
    expect(totalReturnTile).toContain('text-emerald-400');
  });

  it('formats negative return with rose color', () => {
    render(
      <RunMetricsTiles
        metrics={{
          totalReturn: -0.15,
          cagr: -0.02,
          sharpe: -0.4,
          maxDrawdown: -0.25,
          winRate: 0.42,
          trades: 100,
        }}
      />,
    );
    const negReturn = screen.getByText('-15.00%');
    expect(negReturn.className).toContain('text-rose-400');
    // Negative Sharpe should also be rose
    const negSharpe = screen.getByText('-0.400');
    expect(negSharpe.className).toContain('text-rose-400');
  });

  it("renders '—' for null/missing metric values", () => {
    render(<RunMetricsTiles metrics={{ totalReturn: null, cagr: null, sharpe: null, trades: 0 }} />);
    const emDashes = screen.getAllByText('—');
    expect(emDashes.length).toBeGreaterThanOrEqual(3);
  });

  it('renders nothing when metrics is null', () => {
    const { container } = render(<RunMetricsTiles metrics={null} />);
    expect(container.textContent).toBe('');
  });

  it('shows emerald Sharpe when > 1', () => {
    render(<RunMetricsTiles metrics={{ sharpe: 1.5, totalReturn: 0.2, trades: 50 }} />);
    const sharpe = screen.getByText('1.500');
    expect(sharpe.className).toContain('text-emerald-400');
  });
});
