// Phase 4f W4c — Block trade detection.
//
// Filters equity trades for size ≥ 10,000 shares OR notional ≥ $200K
// and classifies each block as buy-side / sell-side using the
// at-or-above-ask / at-or-below-bid heuristic (when bid/ask is known)
// or price-vs-day's-VWAP fallback.
//
// Pure compute — caller supplies the day's trades.

import type { BlockTradeSignal, PolygonTrade } from './types';

const BLOCK_SHARE_THRESHOLD = 10_000;
const BLOCK_NOTIONAL_THRESHOLD = 200_000;

export interface BlockTradeInput {
  ticker: string;
  asOfDate: string;
  trades: PolygonTrade[];
  /** Optional bid/ask at time of trade, indexed by trade timestamp. */
  bidAskByTs?: Record<number, { bid: number; ask: number }>;
  /** Optional day VWAP as fallback classifier when bid/ask unknown. */
  vwap?: number;
}

export function isBlockTrade(t: PolygonTrade): boolean {
  if (t.s >= BLOCK_SHARE_THRESHOLD) return true;
  if (t.s * t.p >= BLOCK_NOTIONAL_THRESHOLD) return true;
  return false;
}

export function computeBlockTradeSignal(
  input: BlockTradeInput,
): BlockTradeSignal {
  const blocks = input.trades.filter(isBlockTrade);
  let blockNotional = 0;
  let buySide = 0;
  let sellSide = 0;

  for (const b of blocks) {
    const notional = b.s * b.p;
    blockNotional += notional;
    const quote = input.bidAskByTs?.[b.t];
    if (quote) {
      if (b.p >= quote.ask) {
        buySide += notional;
      } else if (b.p <= quote.bid) {
        sellSide += notional;
      } else {
        // Inside the spread — split evenly. Generates a neutral signal.
        buySide += notional / 2;
        sellSide += notional / 2;
      }
    } else if (input.vwap != null) {
      // VWAP fallback: above VWAP = aggressor buyer, below = aggressor seller.
      if (b.p >= input.vwap) buySide += notional;
      else sellSide += notional;
    } else {
      // No info: split evenly so the metric stays honest.
      buySide += notional / 2;
      sellSide += notional / 2;
    }
  }

  return {
    ticker: input.ticker,
    asOfDate: input.asOfDate,
    blockCount: blocks.length,
    blockNotional: +blockNotional.toFixed(2),
    buySideEstimate: +buySide.toFixed(2),
    sellSideEstimate: +sellSide.toFixed(2),
    buyMinusSell: +(buySide - sellSide).toFixed(2),
  };
}
