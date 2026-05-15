// Phase 4f W4c — block-trades compute tests.

import { describe, expect, it } from 'vitest';
import { computeBlockTradeSignal, isBlockTrade } from '../block-trades';
import type { PolygonTrade } from '../types';

function trade(s: number, p: number, t = 0): PolygonTrade {
  return { t, p, s };
}

describe('isBlockTrade', () => {
  it('flags ≥ 10,000 shares (using a low price so notional rule alone wouldn\'t fire)', () => {
    // 10,000 shares × $5 = $50K notional — fails notional rule, passes shares rule.
    expect(isBlockTrade(trade(10_000, 5))).toBe(true);
    expect(isBlockTrade(trade(9_999, 5))).toBe(false);
  });
  it('flags ≥ $200K notional (using a small share count so shares rule wouldn\'t fire)', () => {
    expect(isBlockTrade(trade(100, 2_000))).toBe(true);
    expect(isBlockTrade(trade(100, 1_999.99))).toBe(false);
  });
});

describe('computeBlockTradeSignal', () => {
  it('zero blocks → all zero', () => {
    const out = computeBlockTradeSignal({
      ticker: 'AAPL',
      asOfDate: '2024-06-30',
      trades: [trade(100, 100), trade(50, 200)],
    });
    expect(out.blockCount).toBe(0);
    expect(out.blockNotional).toBe(0);
    expect(out.buyMinusSell).toBe(0);
  });

  it('classifies block buys vs sells via bid/ask', () => {
    const tradesArr = [
      trade(10_000, 150, 100), // notional 1.5M, at-or-above ask → buy
      trade(10_000, 149, 200), // at-or-below bid → sell
      trade(10_000, 149.5, 300), // inside spread → split
    ];
    const bidAskByTs: Record<number, { bid: number; ask: number }> = {
      100: { bid: 149, ask: 150 },
      200: { bid: 149, ask: 150 },
      300: { bid: 149, ask: 150 },
    };
    const out = computeBlockTradeSignal({
      ticker: 'AAPL',
      asOfDate: '2024-06-30',
      trades: tradesArr,
      bidAskByTs,
    });
    expect(out.blockCount).toBe(3);
    // buy notional = 1.5M + half of mid = 1.5M + 747500 = 2,247,500
    expect(out.buySideEstimate).toBeCloseTo(1_500_000 + 1_495_000 / 2, 0);
    expect(out.sellSideEstimate).toBeCloseTo(1_490_000 + 1_495_000 / 2, 0);
  });

  it('falls back to VWAP when bid/ask is missing', () => {
    const tradesArr = [
      trade(10_000, 100, 1), // above vwap → buy
      trade(10_000, 90, 2), // below vwap → sell
    ];
    const out = computeBlockTradeSignal({
      ticker: 'AAPL',
      asOfDate: '2024-06-30',
      trades: tradesArr,
      vwap: 95,
    });
    expect(out.buySideEstimate).toBeCloseTo(10_000 * 100, 0);
    expect(out.sellSideEstimate).toBeCloseTo(10_000 * 90, 0);
  });

  it('splits 50/50 when no classifier info available', () => {
    const tradesArr = [trade(10_000, 100, 1)];
    const out = computeBlockTradeSignal({
      ticker: 'AAPL',
      asOfDate: '2024-06-30',
      trades: tradesArr,
    });
    const notional = 10_000 * 100;
    expect(out.buySideEstimate).toBeCloseTo(notional / 2, 0);
    expect(out.sellSideEstimate).toBeCloseTo(notional / 2, 0);
    expect(out.buyMinusSell).toBe(0);
  });

  it('blockNotional sums across all blocks', () => {
    const out = computeBlockTradeSignal({
      ticker: 'AAPL',
      asOfDate: '2024-06-30',
      trades: [trade(10_000, 100), trade(10_000, 200)],
    });
    expect(out.blockNotional).toBe(10_000 * 100 + 10_000 * 200);
  });
});
