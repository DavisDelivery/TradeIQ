// Phase 4e-1 — Portfolio backtest harness.
//
// Walks a [start, end] window: at each rebalance date, asks the
// configured RankingSignal for top-K candidates, calls decideRebalance,
// applies slippage, and marks equity day-by-day using the supplied
// PriceSource. Produces a PortfolioBacktestResult with the metrics the
// verdict report needs.
//
// The harness is a thin orchestrator — it does NOT bake in a data
// provider. Callers inject a PriceSource (live → Polygon-backed; tests
// → synthetic series). This keeps the harness unit-testable and lets
// the CLI fail loud-and-clear when production credentials are missing.
//
// What the harness intentionally does NOT do:
//   - hit Firestore or Polygon directly (callers wire data in)
//   - persist any results to Firestore (the CLI writes report.md only)
//   - mutate any state passed in (every per-rebalance state is fresh)

import type {
  PortfolioConfig,
  PortfolioPosition,
  PortfolioState,
  RankingResult,
  RankingSignal,
  SwapEvent,
} from './types';
import { decideRebalance } from './rebalance';

export interface PortfolioBacktestResult {
  windowLabel: string;
  startDate: string;
  endDate: string;
  portfolioReturnPct: number;
  spyReturnPct: number;
  qqqReturnPct: number;
  iwfReturnPct: number;
  excessReturnPct: number; // portfolio - SPY
  sharpe: number;
  spySharpe: number;
  maxDDPct: number;
  spyMaxDDPct: number;
  longestUnderwaterDays: number;
  swapCount: number;
  avgHoldDays: number;
  turnoverPct: number; // annualized
  costDragPct: number;
  rebalanceCount: number;
  swaps: SwapEvent[];
  equityCurve: Array<{ date: string; portfolio: number; spy: number | null; qqq: number | null; iwf: number | null }>;
  warnings: string[];
}

export interface PriceSource {
  /**
   * Close price for `ticker` on `date` (or the most recent trading day
   * on or before). Returns null if no bar exists in the data window.
   */
  closeAt(ticker: string, date: string): Promise<number | null>;
}

export interface BacktestWindow {
  label: string;
  start: string;
  end: string;
  /** Inclusive sorted list of rebalance dates within [start, end]. */
  rebalanceDates: string[];
  /** Inclusive sorted list of mark dates within [start, end]. */
  markDates: string[];
}

export interface RunPortfolioBacktestOptions {
  config: PortfolioConfig;
  window: BacktestWindow;
  signal: RankingSignal;
  prices: PriceSource;
  /** SPY / QQQ / IWF total-return series — close prices indexed by mark date. */
  benchmarks?: {
    spy: PriceSource;
    qqq: PriceSource;
    iwf: PriceSource;
  };
  /** Defaults to 0 — daily risk-free rate for Sharpe. */
  riskFreeDailyRate?: number;
}

function sortedUnique(dates: string[]): string[] {
  return [...new Set(dates)].sort();
}

function dailyReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    if (prev > 0) out.push((cur - prev) / prev);
  }
  return out;
}

function annualizedSharpe(rets: number[], riskFreeDailyRate = 0): number {
  if (rets.length < 2) return 0;
  const excess = rets.map((r) => r - riskFreeDailyRate);
  const mean = excess.reduce((s, x) => s + x, 0) / excess.length;
  const variance =
    excess.reduce((s, x) => s + (x - mean) ** 2, 0) / (excess.length - 1);
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return 0;
  return (mean / stdev) * Math.sqrt(252);
}

function maxDrawdownPct(values: number[]): number {
  if (values.length === 0) return 0;
  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return +(maxDD * 100).toFixed(4);
}

function longestUnderwaterDays(
  curve: Array<{ date: string; value: number }>,
): number {
  if (curve.length === 0) return 0;
  let peak = curve[0].value;
  let peakIdx = 0;
  let longest = 0;
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].value >= peak) {
      const stretch = i - peakIdx;
      if (stretch > longest) longest = stretch;
      peak = curve[i].value;
      peakIdx = i;
    }
  }
  // Trailing underwater stretch (never recovered)
  const trailing = curve.length - 1 - peakIdx;
  if (trailing > longest) longest = trailing;
  return longest;
}

interface MutablePosition extends PortfolioPosition {}

async function markEquityAt(
  positions: MutablePosition[],
  cash: number,
  date: string,
  prices: PriceSource,
): Promise<{ equity: number; positions: MutablePosition[] }> {
  let holdingsValue = 0;
  const next: MutablePosition[] = [];
  for (const p of positions) {
    const px = await prices.closeAt(p.ticker, date);
    const currentPrice = px ?? p.currentPrice;
    const marketValue = p.shares * currentPrice;
    holdingsValue += marketValue;
    next.push({
      ...p,
      currentPrice,
      marketValue,
      weight: 0, // recomputed after totals are known
    });
  }
  const equity = cash + holdingsValue;
  if (equity > 0) {
    for (const p of next) p.weight = p.marketValue / equity;
  }
  return { equity, positions: next };
}

export async function runPortfolioBacktest(
  opts: RunPortfolioBacktestOptions,
): Promise<PortfolioBacktestResult> {
  const { config, window, signal, prices, benchmarks } = opts;
  const warnings: string[] = [];

  if (window.rebalanceDates.length === 0) {
    throw new Error('runPortfolioBacktest: window has no rebalance dates');
  }
  const rebalanceDates = sortedUnique(window.rebalanceDates);
  const markDates = sortedUnique(window.markDates);
  if (markDates.length === 0) {
    throw new Error('runPortfolioBacktest: window has no mark dates');
  }

  let positions: MutablePosition[] = [];
  let cash = config.startCapital;
  const swaps: SwapEvent[] = [];
  const equityCurve: PortfolioBacktestResult['equityCurve'] = [];
  let totalSlippage = 0;
  let totalTurnoverNotional = 0;
  const completedHolds: number[] = []; // hold-days at exit, for avg

  let rebalanceIdx = 0;
  for (const date of markDates) {
    // Apply rebalance if today is a rebalance date.
    if (rebalanceIdx < rebalanceDates.length && date === rebalanceDates[rebalanceIdx]) {
      // 1. Mark to today's close first (so weights/equity are current).
      const marked = await markEquityAt(positions, cash, date, prices);
      positions = marked.positions;
      const preEquity = marked.equity;

      // 2. Ask signal for top-K candidates.
      const candidates = await signal.rankAtDate({
        universe: config.universe,
        asOfDate: date,
        topN: config.candidatePool,
        minComposite: config.minComposite,
      });

      // 3. Decide rebalance.
      const stateForRule: PortfolioState = {
        universe: config.universe,
        asOfDate: date,
        cash,
        equity: preEquity,
        positions,
        lastRebalanceAt: date,
        updatedAt: date,
      };
      const decision = decideRebalance(stateForRule, candidates, config, date);

      // 4. Apply exits.
      const swapOut: SwapEvent['out'] = [];
      for (const e of decision.out) {
        const pos = positions.find((p) => p.ticker === e.ticker);
        if (!pos) continue;
        const exitPx = (await prices.closeAt(e.ticker, date)) ?? pos.currentPrice;
        const grossProceeds = e.shares * exitPx;
        const slippage = (grossProceeds * config.slippageBps) / 10_000;
        const netProceeds = grossProceeds - slippage;
        cash += netProceeds;
        totalSlippage += slippage;
        totalTurnoverNotional += grossProceeds;
        const holdDays = Math.max(
          0,
          Math.round(
            (Date.parse(`${date}T00:00:00Z`) -
              Date.parse(`${pos.entryDate}T00:00:00Z`)) /
              86_400_000,
          ),
        );
        completedHolds.push(holdDays);
        swapOut.push({
          ticker: e.ticker,
          shares: e.shares,
          exitPrice: exitPx,
          holdDays,
          totalReturnPct: ((exitPx - pos.entryPrice) / pos.entryPrice) * 100,
          reasonCode: e.reason,
        });
        positions = positions.filter((p) => p.ticker !== e.ticker);
      }

      // 5. Apply additions at target weight = 1/positionCount of equity.
      // Compute post-exit equity for sizing.
      const postExitMarked = await markEquityAt(positions, cash, date, prices);
      positions = postExitMarked.positions;
      const equityForSizing = postExitMarked.equity;
      const swapIn: SwapEvent['in'] = [];
      for (const add of decision.in) {
        const px = await prices.closeAt(add.ticker, date);
        if (px == null || px <= 0) {
          warnings.push(`${date}: missing price for ${add.ticker}, addition skipped`);
          continue;
        }
        // Cap spend to available cash — slippage on exits leaves a
        // sliver short; rather than dropping the addition we under-fill.
        const grossSpend = Math.min(add.targetWeight * equityForSizing, cash);
        if (grossSpend <= 0) {
          warnings.push(`${date}: no cash for ${add.ticker}, addition skipped`);
          continue;
        }
        // Slippage modeled as a worse execution price (buyer pays a bit
        // more per share). Cash debited = grossSpend; shares received =
        // grossSpend / effectivePx. The implicit slippage cost ends up
        // in equity-via-fewer-shares.
        const effectivePx = px * (1 + config.slippageBps / 10_000);
        const shares = grossSpend / effectivePx;
        const slippage = grossSpend - shares * px;
        cash -= grossSpend;
        totalSlippage += slippage;
        totalTurnoverNotional += grossSpend;
        positions.push({
          ticker: add.ticker,
          shares,
          entryDate: date,
          entryPrice: effectivePx,
          currentPrice: px,
          marketValue: shares * px,
          weight: 0,
          sector: add.sector,
        });
        swapIn.push({
          ticker: add.ticker,
          shares,
          entryPrice: effectivePx,
          candidateRank: add.rank,
          composite: add.composite,
          fundamentalScore: 0,
        });
      }

      if (swapOut.length > 0 || swapIn.length > 0 || decision.notes.length > 0) {
        swaps.push({
          swapId: `${date}-bt`,
          timestamp: `${date}T21:00:00.000Z`,
          asOfDate: date,
          out: swapOut,
          in: swapIn,
          candidatesConsidered: candidates.length,
          swapsApplied: swapOut.length,
          snapshotId: `bt-${date}`,
          notes: decision.notes.join(' | '),
          signalId: signal.id,
        });
      }

      rebalanceIdx++;
    }

    // Daily mark
    const marked = await markEquityAt(positions, cash, date, prices);
    positions = marked.positions;
    const spy = benchmarks?.spy ? await benchmarks.spy.closeAt('SPY', date) : null;
    const qqq = benchmarks?.qqq ? await benchmarks.qqq.closeAt('QQQ', date) : null;
    const iwf = benchmarks?.iwf ? await benchmarks.iwf.closeAt('IWF', date) : null;
    equityCurve.push({
      date,
      portfolio: marked.equity,
      spy,
      qqq,
      iwf,
    });
  }

  // ---- Metrics
  const portValues = equityCurve.map((p) => p.portfolio);
  const portRets = dailyReturns(portValues);
  const startVal = portValues[0] ?? config.startCapital;
  const endVal = portValues[portValues.length - 1] ?? startVal;
  const portfolioReturnPct = ((endVal - startVal) / startVal) * 100;

  function benchPct(getter: (p: (typeof equityCurve)[number]) => number | null): number {
    const series = equityCurve.map(getter).filter((v): v is number => v != null && v > 0);
    if (series.length < 2) return 0;
    return ((series[series.length - 1] - series[0]) / series[0]) * 100;
  }
  function benchSharpe(getter: (p: (typeof equityCurve)[number]) => number | null): number {
    const series = equityCurve.map(getter).filter((v): v is number => v != null && v > 0);
    return annualizedSharpe(dailyReturns(series), opts.riskFreeDailyRate ?? 0);
  }
  function benchMaxDD(getter: (p: (typeof equityCurve)[number]) => number | null): number {
    const series = equityCurve.map(getter).filter((v): v is number => v != null && v > 0);
    return maxDrawdownPct(series);
  }

  const spyReturnPct = benchPct((p) => p.spy);
  const qqqReturnPct = benchPct((p) => p.qqq);
  const iwfReturnPct = benchPct((p) => p.iwf);

  const yearsInWindow =
    (Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) /
    (365.25 * 86_400_000);
  const turnoverPct =
    startVal > 0 && yearsInWindow > 0
      ? ((totalTurnoverNotional / startVal) / yearsInWindow) * 100
      : 0;

  const avgHoldDays =
    completedHolds.length > 0
      ? completedHolds.reduce((s, x) => s + x, 0) / completedHolds.length
      : 0;

  return {
    windowLabel: window.label,
    startDate: window.start,
    endDate: window.end,
    portfolioReturnPct: +portfolioReturnPct.toFixed(4),
    spyReturnPct: +spyReturnPct.toFixed(4),
    qqqReturnPct: +qqqReturnPct.toFixed(4),
    iwfReturnPct: +iwfReturnPct.toFixed(4),
    excessReturnPct: +(portfolioReturnPct - spyReturnPct).toFixed(4),
    sharpe: +annualizedSharpe(portRets, opts.riskFreeDailyRate ?? 0).toFixed(4),
    spySharpe: +benchSharpe((p) => p.spy).toFixed(4),
    maxDDPct: maxDrawdownPct(portValues),
    spyMaxDDPct: benchMaxDD((p) => p.spy),
    longestUnderwaterDays: longestUnderwaterDays(
      equityCurve.map((p) => ({ date: p.date, value: p.portfolio })),
    ),
    swapCount: swaps.length,
    avgHoldDays: +avgHoldDays.toFixed(2),
    turnoverPct: +turnoverPct.toFixed(2),
    costDragPct: startVal > 0 ? +((totalSlippage / startVal) * 100).toFixed(4) : 0,
    rebalanceCount: rebalanceDates.length,
    swaps,
    equityCurve,
    warnings,
  };
}

// --- Helpers exposed for unit tests --------------------------------

export const _internals = {
  dailyReturns,
  annualizedSharpe,
  maxDrawdownPct,
  longestUnderwaterDays,
};
