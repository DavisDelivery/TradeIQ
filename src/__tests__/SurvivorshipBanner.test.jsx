import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SurvivorshipBanner } from '../components/SurvivorshipBanner.jsx';

// SurvivorshipBanner is the single most important UI element in Phase 4b
// per the brief: "the integrity of every dishonesty Phase 4a fought to
// surface gets reversed if this banner doesn't slap the user every time
// they look at one of those runs." These tests pin that contract:
//
//   - corrected: false → render (this is the moment that matters)
//   - corrected: true  → null (don't add noise to clean runs)
//   - missing stamp    → null (old runs predating the stamp aren't lied about)

describe('SurvivorshipBanner', () => {
  it('renders the warning when universeStamp.corrected is false', () => {
    render(
      <SurvivorshipBanner universeStamp={{ universe: 'sp500', corrected: false }} />,
    );
    expect(screen.getByText(/Universe is not survivorship-corrected/i)).toBeTruthy();
    expect(screen.getByText(/SP500/)).toBeTruthy();
    // Link to the limitations doc must be present and external
    const link = screen.getByRole('link', { name: /Limitations/i });
    expect(link.getAttribute('href')).toContain('BACKTEST_LIMITATIONS.md');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('renders nothing when universeStamp.corrected is true', () => {
    const { container } = render(
      <SurvivorshipBanner universeStamp={{ universe: 'sp500', corrected: true }} />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders nothing when universeStamp is missing', () => {
    const { container } = render(<SurvivorshipBanner universeStamp={null} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when universeStamp is undefined', () => {
    const { container } = render(<SurvivorshipBanner universeStamp={undefined} />);
    expect(container.textContent).toBe('');
  });
});
