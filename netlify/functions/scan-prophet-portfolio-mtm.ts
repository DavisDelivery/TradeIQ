// Phase 4e-1 — Daily mark-to-market for the Prophet largecap portfolio.
//
// Cadence: weekdays at 21:00 UTC (~4pm ET, after the US close). This
// runs even when the rebalance scheduled function (W5) is gated on the
// backtest verdict — the equity curve should populate continuously
// regardless of whether the live manager has shipped, so the UI tab
// (Phase 4e-2) and the eventual backtest replay have a daily series.
//
// Steady-state body:
//   1. Read prophetPortfolio/largecap/state/current. No state → no-op.
//   2. Pull previous close for each holding ticker (Polygon).
//   3. Recompute currentPrice, marketValue, weight on each position.
//   4. Update state.current with the fresh marks.
//   5. Pull SPY/QQQ/IWF previous close.
//   6. Append one equityCurve/{YYYY-MM-DD} doc.
//
// Pre-W5 this function will observe `state===null` and exit early; that
// is the expected path until the rebalance scheduler ships.

import { schedule } from '@netlify/functions';
import { getPreviousClose } from './shared/data-provider';
import { logger } from './shared/logger';
import {
  appendEquityCurvePoint,
  getPortfolioState,
  writePortfolioState,
} from './shared/prophet-portfolio/state';
import type {
  EquityCurvePoint,
  PortfolioPosition,
  PortfolioState,
} from './shared/prophet-portfolio/types';

const UNIVERSE = 'largecap' as const;

async function safePrevClose(ticker: string): Promise<number | null> {
  try {
    const bar = await getPreviousClose(ticker);
    if (bar && typeof bar.c === 'number') return bar.c;
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure helper extracted for unit testing: given the current state and
 * fresh price quotes, return the new state + equity curve point.
 */
export function recomputeMarks(
  state: PortfolioState,
  prices: Map<string, number | null>,
  benchmarks: { spy: number | null; qqq: number | null; iwf: number | null },
  asOfDate: string,
  nowIso: string,
): { newState: PortfolioState; curvePoint: EquityCurvePoint } {
  const newPositions: PortfolioPosition[] = state.positions.map((p) => {
    const px = prices.get(p.ticker) ?? p.currentPrice;
    const marketValue = p.shares * px;
    return { ...p, currentPrice: px, marketValue, weight: 0 };
  });
  const holdingsValue = newPositions.reduce((s, p) => s + p.marketValue, 0);
  const equity = state.cash + holdingsValue;
  for (const p of newPositions) {
    p.weight = equity > 0 ? p.marketValue / equity : 0;
  }
  const dailyReturn =
    state.equity > 0 ? (equity - state.equity) / state.equity : 0;
  return {
    newState: {
      ...state,
      asOfDate,
      positions: newPositions,
      equity,
      updatedAt: nowIso,
    },
    curvePoint: {
      date: asOfDate,
      equity,
      cash: state.cash,
      holdingsValue,
      dailyReturn,
      spyClose: benchmarks.spy,
      qqqClose: benchmarks.qqq,
      iwfClose: benchmarks.iwf,
    },
  };
}

export const handler = schedule('0 21 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-prophet-portfolio-mtm', universe: UNIVERSE });
  try {
    const state = await getPortfolioState(UNIVERSE);
    if (!state) {
      log.info('mtm_no_state', { universe: UNIVERSE });
      return { statusCode: 200, body: JSON.stringify({ ok: true, action: 'no-state' }) };
    }
    const asOfDate = new Date().toISOString().slice(0, 10);
    const nowIso = new Date().toISOString();

    const tickers = state.positions.map((p) => p.ticker);
    const priceEntries = await Promise.all(
      tickers.map(async (t) => [t, await safePrevClose(t)] as const),
    );
    const prices = new Map<string, number | null>(priceEntries);

    const [spy, qqq, iwf] = await Promise.all([
      safePrevClose('SPY'),
      safePrevClose('QQQ'),
      safePrevClose('IWF'),
    ]);

    const { newState, curvePoint } = recomputeMarks(
      state,
      prices,
      { spy, qqq, iwf },
      asOfDate,
      nowIso,
    );

    await writePortfolioState(UNIVERSE, newState);
    await appendEquityCurvePoint(UNIVERSE, curvePoint);

    log.info('mtm_complete', {
      universe: UNIVERSE,
      asOfDate,
      equity: newState.equity,
      positions: newState.positions.length,
      dailyReturn: curvePoint.dailyReturn,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, asOfDate, equity: newState.equity }),
    };
  } catch (err: any) {
    log.error('mtm_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
});
