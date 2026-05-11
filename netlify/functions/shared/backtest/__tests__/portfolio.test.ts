import { describe, it, expect } from 'vitest';
import { buildPortfolio, diffPortfolios } from '../portfolio';
import type { PortfolioConfig, ScoredCandidate } from '../types';

const cand = (
  ticker: string,
  composite: number,
  sector: string = 'Tech',
): ScoredCandidate => ({
  ticker,
  composite,
  layers: {},
  sector,
  metadata: {},
});

const defaultConfig: PortfolioConfig = {
  topN: 5,
  weighting: 'equal',
  maxPositionPct: 1.0, // permissive default; tests that exercise the cap override
  maxSectorPct: 1.0,
  cashSleeve: 0,
  minComposite: 0,
};

describe('buildPortfolio', () => {
  it('returns empty when no candidates pass minComposite', () => {
    const out = buildPortfolio(
      [cand('A', 30), cand('B', 40)],
      { ...defaultConfig, minComposite: 50 },
    );
    expect(out).toEqual([]);
  });

  it('picks top-N by composite, equal-weighted, sums to 1 - cashSleeve', () => {
    const out = buildPortfolio(
      [
        cand('A', 90),
        cand('B', 80),
        cand('C', 70),
        cand('D', 60),
        cand('E', 50),
        cand('F', 40),
        cand('G', 30),
      ],
      { ...defaultConfig, topN: 3, cashSleeve: 0.05 },
    );
    expect(out.map((p) => p.ticker)).toEqual(['A', 'B', 'C']);
    const sum = out.reduce((s, p) => s + p.weight, 0);
    expect(sum).toBeCloseTo(0.95, 8);
    // Equal: each weight is (1-cashSleeve)/N
    expect(out[0].weight).toBeCloseTo(0.95 / 3, 8);
  });

  it('composite-weighted weights are proportional to composite', () => {
    const out = buildPortfolio(
      [cand('A', 60), cand('B', 30), cand('C', 10)],
      { ...defaultConfig, topN: 3, weighting: 'composite', maxPositionPct: 1 },
    );
    expect(out.map((p) => p.ticker)).toEqual(['A', 'B', 'C']);
    // 60/100, 30/100, 10/100
    expect(out[0].weight).toBeCloseTo(0.6, 6);
    expect(out[1].weight).toBeCloseTo(0.3, 6);
    expect(out[2].weight).toBeCloseTo(0.1, 6);
  });

  it('caps individual positions at maxPositionPct, leaves residual cash if caps cannot fill', () => {
    // composite-weighted, A would be 60% but cap is 25% — overflow goes to B+C
    const out = buildPortfolio(
      [cand('A', 60), cand('B', 30), cand('C', 10)],
      { ...defaultConfig, topN: 3, weighting: 'composite', maxPositionPct: 0.25 },
    );
    const A = out.find((p) => p.ticker === 'A')!;
    expect(A.weight).toBeLessThanOrEqual(0.25 + 1e-9);
    // Cap × topN = 0.75 — sum cannot exceed that
    const sum = out.reduce((s, p) => s + p.weight, 0);
    expect(sum).toBeLessThanOrEqual(0.75 + 1e-9);
    expect(sum).toBeGreaterThan(0.7); // most of the budget should be used
  });

  it('sector cap drops lowest-composite ticker in over-cap sector', () => {
    // All 4 picks are Tech with topN=4, maxSectorPct=0.5 → must drop at
    // least one. Lowest composite (D=60) drops first.
    const out = buildPortfolio(
      [
        cand('A', 90, 'Tech'),
        cand('B', 80, 'Tech'),
        cand('C', 70, 'Tech'),
        cand('D', 60, 'Tech'),
      ],
      { ...defaultConfig, topN: 4, maxPositionPct: 0.5, maxSectorPct: 0.5 },
    );
    expect(out.map((p) => p.ticker)).not.toContain('D');
  });

  it('deterministic for tied composites (alphabetical tiebreak)', () => {
    const out = buildPortfolio(
      [cand('B', 50), cand('A', 50), cand('C', 50)],
      { ...defaultConfig, topN: 2 },
    );
    expect(out.map((p) => p.ticker)).toEqual(['A', 'B']);
  });
});

describe('diffPortfolios', () => {
  const pos = (ticker: string, weight: number): import('../types').PortfolioPosition => ({
    ticker,
    weight,
    composite: 50,
    layers: {},
    sector: 'Tech',
  });

  it('emits buy when new weight > prev weight', () => {
    const trades = diffPortfolios(
      [pos('A', 0.2)],
      [pos('A', 0.3)],
      100_000,
      '2024-01-15',
      new Map([['A', 100]]),
    );
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('buy');
    expect(trades[0].notional).toBeCloseTo(10_000, 6);
  });

  it('emits sell when prev had a position no longer in target', () => {
    const trades = diffPortfolios(
      [pos('A', 0.3), pos('B', 0.3)],
      [pos('A', 0.3)],
      100_000,
      '2024-01-15',
      new Map([['B', 50]]),
    );
    expect(trades).toHaveLength(1);
    expect(trades[0].ticker).toBe('B');
    expect(trades[0].side).toBe('sell');
    expect(trades[0].newWeight).toBe(0);
  });

  it('skips tickers with zero delta', () => {
    const trades = diffPortfolios(
      [pos('A', 0.3)],
      [pos('A', 0.3)],
      100_000,
      '2024-01-15',
      new Map(),
    );
    expect(trades).toEqual([]);
  });
});
