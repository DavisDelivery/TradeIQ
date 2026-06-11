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
import { tradingDaysBetween } from '../backtest/trading-calendar';

/**
 * Wave 3B (track-3 M3) — forced-liquidation gap. A held position whose
 * price source returns no bar for MORE than this many consecutive mark
 * dates (mark dates are trading days — see makeTradingDayWindow) is
 * treated as delisted/halted and force-liquidated at its last traded
 * close. 10 trading days ≈ 2 calendar weeks: long enough that ordinary
 * provider hiccups and short halts don't trigger it, short enough that
 * a bankruptcy doesn't ride the book as a phantom flat hold for months.
 * Data-free by design — no delisted-status lookups in this wave.
 */
export const FORCED_LIQUIDATION_GAP_TRADING_DAYS = 10;

/** Default rebalance cadence: every 5th trading day ≈ weekly. */
export const REBALANCE_EVERY_TRADING_DAYS = 5;

/**
 * Wave 3B (track-3 M4) — build a BacktestWindow whose markDates are
 * NYSE trading days and whose rebalanceDates are drawn from the SAME
 * series (every `rebalanceEvery`-th trading day ≈ weekly). Pre-fix the
 * worker marked every CALENDAR day while Sharpe annualized with √252
 * (≈17% understatement; ~30% of "daily returns" were structural zeros)
 * and rebalanced every 7 calendar days (drifting on/off weekends).
 *
 * Calendar note: the repo currently has TWO divergent holiday
 * calendars — `shared/backtest/trading-calendar.ts` (2018–2027,
 * includes the 2025-01-09 Carter closure) and
 * `shared/us-market-holidays.ts` (2024–2028, MISSING 2025-01-09).
 * Backtest internals standardize on trading-calendar.ts; consolidating
 * the two is deferred (code-review-2026-06, track-3 minor 4).
 */
export function makeTradingDayWindow(
  label: string,
  start: string,
  end: string,
  rebalanceEvery: number = REBALANCE_EVERY_TRADING_DAYS,
): BacktestWindow {
  const marks = tradingDaysBetween(start, end);
  const rebalances: string[] = [];
  for (let i = 0; i < marks.length; i += rebalanceEvery) {
    rebalances.push(marks[i]);
  }
  return { label, start, end, rebalanceDates: rebalances, markDates: marks };
}

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
  /**
   * Longest stretch below a prior equity peak, counted in MARK DATES.
   * Wave 3B: production windows mark on TRADING days
   * (makeTradingDayWindow), so this is trading days — consistent with
   * the regular engine's `recoveryDays`. Results persisted before
   * Wave 3B counted calendar days.
   */
  longestUnderwaterDays: number;
  swapCount: number;
  avgHoldDays: number;
  /**
   * Annualized, standard (buys + sells) / 2 convention (Wave 3B,
   * track-3 minor 6). Results persisted before Wave 3B double-counted
   * both legs (~2× this number).
   */
  turnoverPct: number;
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
): Promise<{ equity: number; positions: MutablePosition[]; missingTickers: string[] }> {
  let holdingsValue = 0;
  const next: MutablePosition[] = [];
  // Wave 3B (M3) — tickers whose price source returned NO bar for this
  // date. The caller's daily-mark step feeds these into the per-position
  // missing-bar streaks that drive forced liquidation. The stale
  // `p.currentPrice` carry-forward remains the marking fallback for
  // short gaps (halts < FORCED_LIQUIDATION_GAP_TRADING_DAYS).
  const missingTickers: string[] = [];
  for (const p of positions) {
    const px = await prices.closeAt(p.ticker, date);
    if (px == null) missingTickers.push(p.ticker);
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
  return { equity, positions: next, missingTickers };
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

  // Wave 3B (M3) — consecutive mark dates with no price bar, per held
  // ticker. Reset when a bar appears; entry removed when the position
  // exits. Drives the forced-liquidation sweep below.
  const missingBarStreaks: Record<string, number> = {};

  let rebalanceIdx = 0;
  for (const date of markDates) {
    // Wave 3B (track-2 M6) — catch-up rebalance. Pre-fix this was a
    // strict `date === rebalanceDates[rebalanceIdx]`: a rebalance date
    // absent from markDates (holiday / misaligned calendars) never
    // matched AND the index never advanced, silently skipping every
    // later rebalance (the run degraded to buy-and-hold). Now any
    // rebalance date at or before today fires ONE rebalance at today's
    // mark, and the index advances past every stale date ≤ today.
    if (rebalanceIdx < rebalanceDates.length && rebalanceDates[rebalanceIdx] <= date) {
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
        delete missingBarStreaks[e.ticker];
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

      // Advance past every rebalance date at or before today — at most
      // ONE rebalance executes per mark date; stale (skipped-holiday)
      // dates collapse into it.
      while (
        rebalanceIdx < rebalanceDates.length &&
        rebalanceDates[rebalanceIdx] <= date
      ) {
        rebalanceIdx++;
      }
    }

    // Daily mark
    const marked = await markEquityAt(positions, cash, date, prices);
    positions = marked.positions;
    let equity = marked.equity;

    // Wave 3B (M3) — delisting/halt sweep. Update the per-position
    // missing-bar streaks from THIS date's mark (the daily mark is the
    // single per-date mark; rebalance-step marks don't touch streaks),
    // then force-liquidate any position with no bar for more than
    // FORCED_LIQUIDATION_GAP_TRADING_DAYS consecutive mark dates.
    // Liquidation books at the last traded close with the configured
    // slippage (a forced sell still crosses the spread); pre-fix the
    // position rode the book at its frozen last close forever, so a
    // bankruptcy read as a flat hold.
    const missingToday = new Set(marked.missingTickers);
    const survivors: MutablePosition[] = [];
    for (const p of positions) {
      const streak = missingToday.has(p.ticker)
        ? (missingBarStreaks[p.ticker] ?? 0) + 1
        : 0;
      if (streak > FORCED_LIQUIDATION_GAP_TRADING_DAYS) {
        const grossProceeds = p.shares * p.currentPrice;
        const slippage = (grossProceeds * config.slippageBps) / 10_000;
        cash += grossProceeds - slippage;
        totalSlippage += slippage;
        totalTurnoverNotional += grossProceeds;
        equity -= slippage; // proceeds replace holdings value; slippage is the only equity hit
        const holdDays = Math.max(
          0,
          Math.round(
            (Date.parse(`${date}T00:00:00Z`) -
              Date.parse(`${p.entryDate}T00:00:00Z`)) /
              86_400_000,
          ),
        );
        completedHolds.push(holdDays);
        warnings.push(
          `${date}: ${p.ticker} has no price bar for ${streak} consecutive mark dates — ` +
            `forced liquidation at last traded close ${p.currentPrice} ` +
            `(delisting/halt suspected; see FORCED_LIQUIDATION_GAP_TRADING_DAYS)`,
        );
        delete missingBarStreaks[p.ticker];
        continue;
      }
      missingBarStreaks[p.ticker] = streak;
      survivors.push(p);
    }
    positions = survivors;

    const spy = benchmarks?.spy ? await benchmarks.spy.closeAt('SPY', date) : null;
    const qqq = benchmarks?.qqq ? await benchmarks.qqq.closeAt('QQQ', date) : null;
    const iwf = benchmarks?.iwf ? await benchmarks.iwf.closeAt('IWF', date) : null;
    equityCurve.push({
      date,
      portfolio: equity,
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
  // Wave 3B (track-3 minor 6) — standard turnover convention:
  // (buys + sells) / 2. totalTurnoverNotional accumulates BOTH legs,
  // so halve it here. Pre-fix results reported ~2× standard.
  const turnoverPct =
    startVal > 0 && yearsInWindow > 0
      ? ((totalTurnoverNotional / 2 / startVal) / yearsInWindow) * 100
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
