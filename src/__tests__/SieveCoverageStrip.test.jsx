// 4c-2 SieveCoverageStrip rendering contract:
//   - renders only when sieve metadata is present
//   - shows the universe → s1 → s2 → final ladder
//   - amber treatment + partial marker when any stage stamped partial: true

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SieveCoverageStrip } from '../components/SieveCoverageStrip.jsx';

function fullSieve(overrides = {}) {
  return {
    stage1: { scored: 2037, survived: 412, thresholdScore: 58, budgetMs: 119000, partial: false },
    stage2: { scored: 412, survived: 87, thresholdScore: 71, budgetMs: 230000, partial: false },
    stage3: { scored: 87, survived: 23, budgetMs: 470000, partial: false },
    ...overrides,
  };
}

describe('SieveCoverageStrip', () => {
  it('returns null when sieve is missing', () => {
    const { container } = render(<SieveCoverageStrip sieve={null} universeSize={2037} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the full ladder when sieve is present', () => {
    render(<SieveCoverageStrip sieve={fullSieve()} universeSize={2037} />);
    expect(screen.getByText(/2,037 names/)).toBeInTheDocument();
    expect(screen.getByText(/s1: 412/)).toBeInTheDocument();
    expect(screen.getByText(/s2: 87/)).toBeInTheDocument();
    expect(screen.getByText(/23 ranked/)).toBeInTheDocument();
    // No partial marker
    expect(screen.queryByText(/partial/i)).not.toBeInTheDocument();
  });

  it('shows a partial marker when stage 1 hit its budget', () => {
    const sieve = fullSieve({
      stage1: { scored: 1200, survived: 412, thresholdScore: 58, budgetMs: 120000, partial: true },
    });
    render(<SieveCoverageStrip sieve={sieve} universeSize={2037} />);
    expect(screen.getByText(/partial.*Stage 1 budget/i)).toBeInTheDocument();
  });

  it('shows a partial marker when stage 2 hit its budget', () => {
    const sieve = fullSieve({
      stage2: { scored: 412, survived: 87, thresholdScore: 71, budgetMs: 240000, partial: true },
    });
    render(<SieveCoverageStrip sieve={sieve} universeSize={2037} />);
    expect(screen.getByText(/partial.*Stage 2 budget/i)).toBeInTheDocument();
  });

  it('shows a partial marker when stage 3 hit its budget', () => {
    const sieve = fullSieve({
      stage3: { scored: 87, survived: 23, budgetMs: 480000, partial: true },
    });
    render(<SieveCoverageStrip sieve={sieve} universeSize={2037} />);
    expect(screen.getByText(/partial.*Stage 3 budget/i)).toBeInTheDocument();
  });

  it('renders even when universeSize is missing — falls back to dash', () => {
    render(<SieveCoverageStrip sieve={fullSieve()} universeSize={undefined} />);
    expect(screen.getByText(/— names/)).toBeInTheDocument();
  });
});
