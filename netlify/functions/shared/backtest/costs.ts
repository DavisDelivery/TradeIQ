// Transaction costs: slippage + commission applied to each trade leg.
//
// Slippage model: a fixed basis-point cost per leg, applied to the
// notional. Small-cap (Russell 2k) defaults are wider than large-cap
// because their bid-ask spreads are. Modern broker commissions are
// effectively zero; we expose the field but default to 0.
//
// This is intentionally simple. A real slippage model would include
// participation rate, ADV, intraday liquidity windows, market-impact
// curves, etc. — that's a Phase 5+ concern. The point here is to make
// the per-trade drag *visible* so a high-turnover strategy doesn't
// look profitable when in reality fills eat the edge.

import type { BacktestUniverse, CostConfig, TradeRecord } from './types';

export const DEFAULT_SLIPPAGE_BPS: Record<BacktestUniverse, number> = {
  dow: 3,
  sp500: 5,
  ndx: 5,
  russell2k: 20,
};

export const DEFAULT_COSTS: CostConfig = {
  slippageBps: DEFAULT_SLIPPAGE_BPS,
  commission: 0,
};

/**
 * Resolve the slippage rate for one leg of a trade given the backtest
 * universe. Falls back to a conservative 10bps if the universe has no
 * configured rate.
 */
export function slippageBpsFor(
  universe: BacktestUniverse,
  config: CostConfig,
): number {
  return config.slippageBps[universe] ?? 10;
}

/**
 * Apply costs to a partial trade record produced by diffPortfolios.
 * Returns a fully-populated TradeRecord including slippage and
 * commission dollar amounts.
 */
export function applyCosts(
  partial: {
    rebalanceDate: string;
    ticker: string;
    side: 'buy' | 'sell';
    prevWeight: number;
    newWeight: number;
    deltaWeight: number;
    notional: number;
    refPrice: number | null;
  },
  universe: BacktestUniverse,
  config: CostConfig,
): TradeRecord {
  const bps = slippageBpsFor(universe, config);
  const slippageDollars = (partial.notional * bps) / 10_000;
  return {
    ...partial,
    slippageBps: bps,
    slippageDollars,
    commissionDollars: config.commission,
  };
}

/**
 * Total cost drag of an array of trades — used by the engine to
 * subtract from NAV at each rebalance.
 */
export function totalCostDrag(trades: TradeRecord[]): number {
  let drag = 0;
  for (const t of trades) drag += t.slippageDollars + t.commissionDollars;
  return drag;
}
