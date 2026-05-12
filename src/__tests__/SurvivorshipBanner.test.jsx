import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { SurvivorshipBanner } from '../components/SurvivorshipBanner.jsx';

// Phase 4b — banner rendering contract.
//
// The banner is the single most important visual element in the run
// viewer. Its rendering rules are deliberately strict so an
// uncorrected SP500/NDX run can never silently pass for honest:
//
//   - corrected: false → banner renders
//   - corrected: true  → banner does NOT render
//   - stamp absent     → banner does NOT render (legacy or malformed
//                        docs; the absence isn't a positive "this is
//                        fine" signal but it's also not a known-bad
//                        signal we can warn about confidently)

describe('SurvivorshipBanner', () => {
  it('renders when universe is NOT survivorship-corrected', () => {
    render(
      <SurvivorshipBanner
        universeStamp={{ universe: 'sp500', corrected: false, coverageThrough: null }}
      />,
    );
    expect(screen.getByTestId('survivorship-banner')).toBeInTheDocument();
    expect(screen.getByText(/not survivorship-corrected/i)).toBeInTheDocument();
    // Universe name surfaces in uppercase so it's unambiguous.
    expect(screen.getByText(/current SP500 constituents only/)).toBeInTheDocument();
  });

  it('does NOT render when universe IS survivorship-corrected', () => {
    render(
      <SurvivorshipBanner
        universeStamp={{ universe: 'dow', corrected: true, coverageThrough: '2018-01-31' }}
      />,
    );
    expect(screen.queryByTestId('survivorship-banner')).not.toBeInTheDocument();
  });

  it('does NOT render when universeStamp is missing', () => {
    render(<SurvivorshipBanner universeStamp={null} />);
    expect(screen.queryByTestId('survivorship-banner')).not.toBeInTheDocument();
  });

  it('does NOT render when universeStamp is undefined', () => {
    render(<SurvivorshipBanner />);
    expect(screen.queryByTestId('survivorship-banner')).not.toBeInTheDocument();
  });

  it('includes a link to BACKTEST_LIMITATIONS.md', () => {
    render(
      <SurvivorshipBanner
        universeStamp={{ universe: 'ndx', corrected: false, coverageThrough: null }}
      />,
    );
    const link = screen.getByRole('link', { name: /Limitations/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('BACKTEST_LIMITATIONS.md'));
    // External-link safety attributes
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('uppercases the universe label even for mixed-case input', () => {
    render(
      <SurvivorshipBanner
        universeStamp={{ universe: 'Sp500', corrected: false, coverageThrough: null }}
      />,
    );
    expect(screen.getByText(/current SP500 constituents only/)).toBeInTheDocument();
  });

  it('falls back to UNIVERSE label when universe field is missing', () => {
    render(
      <SurvivorshipBanner universeStamp={{ corrected: false }} />,
    );
    expect(screen.getByTestId('survivorship-banner')).toBeInTheDocument();
    expect(screen.getByText(/current UNIVERSE constituents only/)).toBeInTheDocument();
  });
});
