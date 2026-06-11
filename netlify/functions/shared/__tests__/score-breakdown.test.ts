// Phase 6 W1 — score-breakdown decomposition fidelity.
//
// The breakdown is a presentation layer over the real style scores. These
// tests pin that it (a) reconstructs the Lynch score exactly (Lynch is purely
// additive over the 5 surfaced components when market-cap/insider proxies are
// off, as they are in production), and (b) produces a well-formed Williams
// breakdown from the signals runWilliams emits.

import { describe, it, expect } from 'vitest';
import { runLynch } from '../../styles/lynch';
import { runWilliams } from '../../styles/williams';
import { buildLynchComponents, buildWilliamsComponents } from '../score-breakdown';
import type { Bar } from '../data-provider';

describe('buildLynchComponents', () => {
  it('reconstructs the Lynch score from the surfaced components', () => {
    const s = runLynch({
      ticker: 'AAPL',
      peRatio: 15,
      epsGrowthYoY: 0.25,
      revenueGrowthYoY: 0.2,
      debtToEquity: 0.25,
      operatingMargin: 0.3,
      earningsHistory: [
        { epsActual: 2.4, epsEstimate: 2.2 },
        { epsActual: 1.6, epsEstimate: 1.5 },
        { epsActual: 1.4, epsEstimate: 1.3 },
        { epsActual: 1.5, epsEstimate: 1.4 },
      ],
    });
    const comps = buildLynchComponents(s.signals);
    expect(comps).toHaveLength(5);
    const sum = comps.reduce((a, c) => a + c.score, 0);
    // runLynch clamps to [-100,100]; with these inputs it's well within range,
    // so the additive components sum exactly to the analyst score.
    expect(sum).toBeCloseTo(s.score, 5);
  });

  it('marks every component no-data when there are no fundamentals', () => {
    const s = runLynch({ ticker: 'XYZ' });
    const comps = buildLynchComponents(s.signals);
    expect(comps.every((c) => c.noData)).toBe(true);
  });
});

describe('buildWilliamsComponents', () => {
  function genBars(n = 60): Bar[] {
    const bars: Bar[] = [];
    let c = 100;
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < n; i++) {
      const o = c;
      c = c * (1 + (i % 5 === 0 ? -0.006 : 0.009));
      bars.push({ t: t0 + i * 86400000, o, h: Math.max(o, c) * 1.012, l: Math.min(o, c) * 0.988, c, v: 1e6 });
    }
    return bars;
  }

  it('produces 5 well-formed components from real Williams signals', () => {
    const s = runWilliams({ ticker: 'NVDA', bars: genBars() });
    const comps = buildWilliamsComponents(s.signals);
    expect(comps.map((c) => c.name)).toEqual([
      'Momentum (%R)', 'Volatility Breakout', 'Closing Strength', 'Seasonality', 'Trend Confirmation',
    ]);
    for (const c of comps) {
      expect(Number.isFinite(c.score)).toBe(true);
      expect(c.weight).toBeGreaterThan(0);
      expect(['long', 'short', 'neutral']).toContain(c.direction);
    }
  });

  it('returns a uniform no-data breakdown when signals are empty', () => {
    const comps = buildWilliamsComponents({});
    expect(comps).toHaveLength(5);
    expect(comps.every((c) => c.noData)).toBe(true);
  });
});
