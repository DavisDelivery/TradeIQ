// Phase 4e-1 — mtm pure-helper test.
//
// The handler itself wraps `schedule(...)`; we exercise the extracted
// pure `recomputeMarks` helper, which is what produces the new state +
// equity curve point given a state + price quotes.

import { describe, expect, it } from 'vitest';
import { recomputeMarks } from '../scan-prophet-portfolio-mtm';
import type { PortfolioState } from '../shared/prophet-portfolio/types';

const STATE: PortfolioState = {
  universe: 'largecap',
  asOfDate: '2024-01-08',
  cash: 0,
  equity: 100_000,
  positions: [
    {
      ticker: 'AAPL',
      shares: 500,
      entryDate: '2024-01-01',
      entryPrice: 100,
      currentPrice: 100,
      marketValue: 50_000,
      weight: 0.5,
      sector: 'Technology',
    },
    {
      ticker: 'MSFT',
      shares: 250,
      entryDate: '2024-01-01',
      entryPrice: 200,
      currentPrice: 200,
      marketValue: 50_000,
      weight: 0.5,
      sector: 'Technology',
    },
  ],
  lastRebalanceAt: '2024-01-01T21:00:00.000Z',
  updatedAt: '2024-01-08T21:00:00.000Z',
};

describe('recomputeMarks', () => {
  it('refreshes prices, marketValue, weight, equity, and dailyReturn', () => {
    const prices = new Map<string, number | null>([
      ['AAPL', 105],
      ['MSFT', 210],
    ]);
    const { newState, curvePoint } = recomputeMarks(
      STATE,
      prices,
      { spy: 500, qqq: 400, iwf: 250 },
      '2024-01-09',
      '2024-01-09T21:00:00.000Z',
    );
    // 500 * 105 + 250 * 210 = 52,500 + 52,500 = 105,000
    expect(newState.equity).toBeCloseTo(105_000, 2);
    expect(newState.positions[0].currentPrice).toBe(105);
    expect(newState.positions[0].marketValue).toBeCloseTo(52_500, 2);
    expect(newState.positions[0].weight).toBeCloseTo(0.5, 4);
    expect(curvePoint.equity).toBeCloseTo(105_000, 2);
    expect(curvePoint.dailyReturn).toBeCloseTo(0.05, 4);
    expect(curvePoint.spyClose).toBe(500);
  });

  it('falls back to position.currentPrice when a quote is null', () => {
    const prices = new Map<string, number | null>([
      ['AAPL', null], // quote missing
      ['MSFT', 220],
    ]);
    const { newState } = recomputeMarks(
      STATE,
      prices,
      { spy: 500, qqq: null, iwf: null },
      '2024-01-09',
      '2024-01-09T21:00:00.000Z',
    );
    expect(newState.positions[0].currentPrice).toBe(100); // unchanged
    expect(newState.positions[1].currentPrice).toBe(220);
  });

  it('writes ISO timestamps + asOfDate from caller (no clock leak)', () => {
    const { newState } = recomputeMarks(
      STATE,
      new Map([
        ['AAPL', 100],
        ['MSFT', 200],
      ]),
      { spy: null, qqq: null, iwf: null },
      '2024-06-30',
      '2024-06-30T21:00:00.000Z',
    );
    expect(newState.asOfDate).toBe('2024-06-30');
    expect(newState.updatedAt).toBe('2024-06-30T21:00:00.000Z');
  });

  it('handles 0-equity edge case (all positions zero) without NaN', () => {
    const zeroState: PortfolioState = {
      ...STATE,
      cash: 0,
      equity: 0,
      positions: [
        { ...STATE.positions[0], shares: 0, marketValue: 0, weight: 0 },
      ],
    };
    const { newState, curvePoint } = recomputeMarks(
      zeroState,
      new Map([['AAPL', 100]]),
      { spy: null, qqq: null, iwf: null },
      '2024-01-09',
      '2024-01-09T21:00:00.000Z',
    );
    expect(newState.equity).toBe(0);
    expect(newState.positions[0].weight).toBe(0);
    expect(curvePoint.dailyReturn).toBe(0);
  });
});
