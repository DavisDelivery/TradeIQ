// Wave 4D (track-3 minor 2) — per-regime breakdown consumer.
//
// metrics.perRegime no longer carries a fake annualized "sharpe"
// (cross-sectional segment returns × √(252/20) was statistically
// meaningless). The table must render the honest replacement,
// avgSegmentReturnPct, labeled as an un-annualized average 20d segment
// return — and show '—' for pre-Wave-4D runs that only persisted
// `sharpe`.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RegimeBreakdownTable } from '../components/RegimeBreakdownTable.jsx';

describe('RegimeBreakdownTable', () => {
  it('renders avgSegmentReturnPct with the honest column label (no "Sharpe")', () => {
    render(
      <RegimeBreakdownTable
        perRegime={{
          risk_on: { avgSegmentReturnPct: 1.25, totalReturnPct: 8.4, rebalanceCount: 12 },
          risk_off: { avgSegmentReturnPct: -0.5, totalReturnPct: -2.1, rebalanceCount: 4 },
        }}
      />,
    );
    expect(screen.getByText('Avg 20d Seg Ret')).toBeInTheDocument();
    expect(screen.queryByText('Sharpe')).toBeNull();
    expect(screen.getByText('1.25%')).toBeInTheDocument();
    expect(screen.getByText('-0.50%')).toBeInTheDocument();
  });

  it('shows an em-dash for pre-Wave-4D runs that only persisted `sharpe`', () => {
    render(
      <RegimeBreakdownTable
        perRegime={{
          neutral: { sharpe: 1.9, totalReturnPct: 3.2, rebalanceCount: 6 },
        }}
      />,
    );
    expect(screen.getByText('Avg 20d Seg Ret')).toBeInTheDocument();
    // legacy sharpe must not be presented as a segment return
    expect(screen.queryByText('1.90%')).toBeNull();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('3.20%')).toBeInTheDocument();
  });

  it('renders the empty state when perRegime is missing', () => {
    render(<RegimeBreakdownTable perRegime={undefined} />);
    expect(screen.getByText(/No regime breakdown in run/)).toBeInTheDocument();
  });
});
