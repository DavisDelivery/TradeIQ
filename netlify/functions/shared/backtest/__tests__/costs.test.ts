import { describe, it, expect } from 'vitest';
import {
  applyCosts,
  slippageBpsFor,
  totalCostDrag,
  DEFAULT_COSTS,
  DEFAULT_SLIPPAGE_BPS,
} from '../costs';
import type { CostConfig } from '../types';

describe('costs', () => {
  it('default slippage: russell2k > sp500/ndx > dow', () => {
    expect(DEFAULT_SLIPPAGE_BPS.russell2k).toBeGreaterThan(
      DEFAULT_SLIPPAGE_BPS.sp500,
    );
    expect(DEFAULT_SLIPPAGE_BPS.sp500).toBeGreaterThan(DEFAULT_SLIPPAGE_BPS.dow);
  });

  it('slippageBpsFor returns universe-specific bps', () => {
    expect(slippageBpsFor('dow', DEFAULT_COSTS)).toBe(3);
    expect(slippageBpsFor('russell2k', DEFAULT_COSTS)).toBe(20);
  });

  it('slippageBpsFor falls back when universe not configured', () => {
    const cfg: CostConfig = { slippageBps: {}, commission: 0 };
    expect(slippageBpsFor('sp500', cfg)).toBe(10);
  });

  it('applyCosts: slippageDollars = notional * bps / 10000', () => {
    const t = applyCosts(
      {
        rebalanceDate: '2024-01-15',
        ticker: 'AAPL',
        side: 'buy',
        prevWeight: 0,
        newWeight: 0.1,
        deltaWeight: 0.1,
        notional: 10_000,
        refPrice: 180,
      },
      'sp500',
      DEFAULT_COSTS,
    );
    // 10000 * 5 / 10000 = 5
    expect(t.slippageDollars).toBe(5);
    expect(t.slippageBps).toBe(5);
    expect(t.commissionDollars).toBe(0);
  });

  it('totalCostDrag sums slippage + commission across trades', () => {
    const trades = [
      applyCosts(
        { rebalanceDate: '2024-01-15', ticker: 'A', side: 'buy', prevWeight: 0, newWeight: 0.1, deltaWeight: 0.1, notional: 10_000, refPrice: null },
        'russell2k',
        DEFAULT_COSTS,
      ),
      applyCosts(
        { rebalanceDate: '2024-01-15', ticker: 'B', side: 'sell', prevWeight: 0.05, newWeight: 0, deltaWeight: -0.05, notional: 5_000, refPrice: null },
        'russell2k',
        DEFAULT_COSTS,
      ),
    ];
    // 10000 * 20/10000 = 20, 5000 * 20/10000 = 10 → 30
    expect(totalCostDrag(trades)).toBe(30);
  });

  it('russell2k round-trip drag is ~40bps as the brief notes', () => {
    // A position opened and closed at the same notional eats 2 × slippageBps.
    const open = applyCosts(
      { rebalanceDate: '2024-01-15', ticker: 'X', side: 'buy', prevWeight: 0, newWeight: 0.1, deltaWeight: 0.1, notional: 100_000, refPrice: null },
      'russell2k',
      DEFAULT_COSTS,
    );
    const close = applyCosts(
      { rebalanceDate: '2024-02-15', ticker: 'X', side: 'sell', prevWeight: 0.1, newWeight: 0, deltaWeight: -0.1, notional: 100_000, refPrice: null },
      'russell2k',
      DEFAULT_COSTS,
    );
    const drag = totalCostDrag([open, close]);
    // 100k notional × 20bps × 2 = 400 = 40bps of the 100k
    expect(drag).toBe(400);
    expect(drag / 100_000).toBeCloseTo(0.004, 6); // 40bps
  });
});
