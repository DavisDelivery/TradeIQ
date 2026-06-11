// Wave-3D regression (code-review-2026-06 M4 + m7) — RegimeView must speak
// the backend's volRegime enum. shared/regime.ts emits
// 'low' | 'medium' | 'high'; the pre-fix view checked 'extreme'/'elevated'
// (values that never occur), so the VIX StatusDot was always green even at
// VIX 35 and the elevated premium-multiplier branch was dead. m7: the
// Math.random() "VIX" sparkline was fabricated data and must not return.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { RegimeView } from '../RegimeView.jsx';

function regimeFixture(volRegime, level = 32.4) {
  // Mirrors shared/types.ts Regime (the /api/regime payload shape).
  return {
    regime: 'risk_off',
    conviction: 'high',
    vol: { level, regime: volRegime, trend: 'rising', percentile: 92 },
    rates: { tenYear: 4.41, twoTenSpread: -12, curveRegime: 'inverted', trend: 'rising' },
    riskAppetite: { ratioTrend: 'risk_off_rising', creditSignal: 'widening_spreads' },
    rationale: 'Vol spike + curve inversion.',
    computedAt: '2026-06-10T20:00:00Z',
  };
}

// StatusDot renders bg-rose-400 for 'danger', bg-amber-400 for 'warning',
// bg-emerald-400 for 'healthy' (components/Badges.jsx).
function vixDotColor(container) {
  // The VIX card is the first metric card; its StatusDot is the only dot
  // rendered in this view.
  const dot = container.querySelector('.animate-ping');
  expect(dot).toBeTruthy();
  return dot.className;
}

describe('RegimeView — volRegime enum (M4)', () => {
  it("volRegime 'high' renders a danger (rose) VIX StatusDot", () => {
    const { container } = render(<RegimeView regime={regimeFixture('high')} />);
    expect(vixDotColor(container)).toContain('bg-rose-400');
  });

  it("volRegime 'medium' renders a warning (amber) VIX StatusDot", () => {
    const { container } = render(<RegimeView regime={regimeFixture('medium')} />);
    expect(vixDotColor(container)).toContain('bg-amber-400');
  });

  it("volRegime 'low' renders a healthy (emerald) VIX StatusDot", () => {
    const { container } = render(<RegimeView regime={regimeFixture('low', 13.2)} />);
    expect(vixDotColor(container)).toContain('bg-emerald-400');
  });

  it("premium multipliers key on the real enum: 'high' boosts sell premium", () => {
    render(<RegimeView regime={regimeFixture('high')} />);
    // Earnings Sell Premium ×1.15 (the formerly dead 'elevated' branch),
    // Earnings Buy Premium ×0.85.
    const sellRow = screen.getByText('Earnings Sell Premium').parentElement;
    expect(sellRow.textContent).toContain('×1.15');
    const buyRow = screen.getByText('Earnings Buy Premium').parentElement;
    expect(buyRow.textContent).toContain('×0.85');
  });

  it("premium multipliers for 'low' vol: buy premium boosted, sell discounted", () => {
    render(<RegimeView regime={regimeFixture('low', 13.2)} />);
    const sellRow = screen.getByText('Earnings Sell Premium').parentElement;
    expect(sellRow.textContent).toContain('×0.90');
    const buyRow = screen.getByText('Earnings Buy Premium').parentElement;
    expect(buyRow.textContent).toContain('×1.15');
  });
});

describe('RegimeView — no fabricated VIX sparkline (m7)', () => {
  it('renders no chart series (the payload has no VIX history to plot)', () => {
    const { container } = render(<RegimeView regime={regimeFixture('high')} />);
    // recharts renders into a .recharts-wrapper; none should exist now that
    // the Math.random() series is gone.
    expect(container.querySelector('.recharts-wrapper')).toBeNull();
  });
});
