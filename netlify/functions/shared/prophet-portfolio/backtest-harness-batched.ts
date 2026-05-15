// Phase 4e-1-infra — batched/resumable portfolio backtest harness.
//
// Same per-rebalance semantics as `runPortfolioBacktest` in
// `backtest-harness.ts`, but factored so the bg-function can:
//   - process a slice of the rebalance schedule per invocation,
//   - persist a serializable state snapshot at the batch boundary,
//   - resume from that snapshot on a follow-on invocation.
//
// The non-batched harness in `backtest-harness.ts` remains the canonical
// entry-point for the CLI + integration tests; it stays a single-pass
// implementation. Only the production bg-function uses the batched path.
//
// What "state" captures: everything that the unbatched harness held in
// closure variables — cash, positions, accumulated swaps, equity curve,
// running cost / turnover sums, completed-hold dwell times, and the
// rebalance/mark indices for resume. All fields are JSON-serializable so
// the bg-function can stamp them onto the Firestore cursor.

import { decideRebalance } from './rebalance';
import type {
  PortfolioConfig,
  PortfolioPosition,
  PortfolioState,
  SwapEvent,
} from './types';
import type {
  BacktestWindow,
  PortfolioBacktestResult,
  PriceSource,
} from './backtest-harness';

/**
 * Serializable resume payload. Mirrors the closure of the unbatched
 * harness, with the rebalance / mark cursors made explicit.
 */
export interface PortfolioBacktestState {
  cash: number;
  positions: PortfolioPosition[];
  /** Equity curve, accumulated daily, up to (but not including) nextMarkIdx. */
  equityCurve: PortfolioBacktestResult['equityCurve'];
  /** All swap events that have fired so far. */
  swaps: SwapEvent[];
  warnings: string[];
  totalSlippage: number;
  totalTurnoverNotional: number;
  /** Hold-days at exit, one per completed swap-out — used for avgHoldDays. */
  completedHolds: number[];
  /** Next index into the window's mark-dates array. */
  nextMarkIdx: number;
  /** Next index into the window's rebalance-dates array. */
  nextRebalanceIdx: number;
}

export interface ProcessBatchOptions {
  config: PortfolioConfig;
  window: BacktestWindow;
  signal: import('./types').RankingSignal;
  prices: PriceSource;
  benchmarks?: {
    spy: PriceSource;
    qqq: PriceSource;
    iwf: PriceSource;
  };
  /** State at the start of this batch. Caller supplies initial state for fresh runs. */
  state: PortfolioBacktestState;
  /** Maximum rebalance events to process in this batch. */
  batchSize: number;
  /** Optional watchdog — when it returns true after a rebalance, the batch breaks early. */
  isExpired?: () => boolean;
}

export interface ProcessBatchResult {
  state: PortfolioBacktestState;
  /** True when the entire schedule (rebalances + marks) has been processed. */
  done: boolean;
  /** Number of rebalance events processed during this batch. */
  rebalancesProcessed: number;
  /** Number of mark days processed (rebalance days mark too, so this >= rebalancesProcessed). */
  marksProcessed: number;
}

function sortedUnique(dates: string[]): string[] {
  return [...new Set(dates)].sort();
}

/**
 * Build the zero-state for a fresh run. The caller passes
 * `config.startCapital` as the initial cash; positions empty; cursors at 0.
 */
export function initialPortfolioState(config: PortfolioConfig): PortfolioBacktestState {
  return {
    cash: config.startCapital,
    positions: [],
    equityCurve: [],
    swaps: [],
    warnings: [],
    totalSlippage: 0,
    totalTurnoverNotional: 0,
    completedHolds: [],
    nextMarkIdx: 0,
    nextRebalanceIdx: 0,
  };
}

async function markEquityAt(
  positions: PortfolioPosition[],
  cash: number,
  date: string,
  prices: PriceSource,
): Promise<{ equity: number; positions: PortfolioPosition[] }> {
  let holdingsValue = 0;
  const next: PortfolioPosition[] = [];
  for (const p of positions) {
    const px = await prices.closeAt(p.ticker, date);
    const currentPrice = px ?? p.currentPrice;
    const marketValue = p.shares * currentPrice;
    holdingsValue += marketValue;
    next.push({
      ...p,
      currentPrice,
      marketValue,
      weight: 0,
    });
  }
  const equity = cash + holdingsValue;
  if (equity > 0) {
    for (const p of next) p.weight = p.marketValue / equity;
  }
  return { equity, positions: next };
}

/**
 * Process up to `batchSize` rebalances (and all interleaved daily marks)
 * starting from `state.nextMarkIdx` / `state.nextRebalanceIdx`. Mutates a
 * working copy of state and returns it.
 *
 * Stopping rules (in order):
 *   1. If the entire schedule is consumed (no more marks AND no more
 *      rebalances), `done: true` is returned.
 *   2. If `batchSize` rebalances have been applied AND we've then advanced
 *      to the next rebalance date (so the cursor sits cleanly between
 *      batches), break and return `done: false`.
 *   3. If `isExpired()` returns true after a rebalance, break — the cursor
 *      sits at the next mark after the just-applied rebalance, and the
 *      next invocation resumes there.
 *
 * The "mark today before rebalancing" pattern from the unbatched harness
 * is preserved: on a rebalance date we mark first, then decide+apply.
 */
export async function processPortfolioBatch(
  opts: ProcessBatchOptions,
): Promise<ProcessBatchResult> {
  const { config, window, signal, prices, benchmarks, batchSize } = opts;
  const isExpired = opts.isExpired ?? (() => false);

  if (window.rebalanceDates.length === 0) {
    throw new Error('processPortfolioBatch: window has no rebalance dates');
  }
  const rebalanceDates = sortedUnique(window.rebalanceDates);
  const markDates = sortedUnique(window.markDates);
  if (markDates.length === 0) {
    throw new Error('processPortfolioBatch: window has no mark dates');
  }

  // Work on a shallow-cloned state — caller still owns the original.
  const state: PortfolioBacktestState = {
    ...opts.state,
    positions: opts.state.positions.map((p) => ({ ...p })),
    equityCurve: opts.state.equityCurve.slice(),
    swaps: opts.state.swaps.slice(),
    warnings: opts.state.warnings.slice(),
    completedHolds: opts.state.completedHolds.slice(),
  };

  let rebalancesProcessed = 0;
  let marksProcessed = 0;
  let i = state.nextMarkIdx;

  while (i < markDates.length) {
    const date = markDates[i];

    // Rebalance date?
    const isRebalanceDate =
      state.nextRebalanceIdx < rebalanceDates.length &&
      date === rebalanceDates[state.nextRebalanceIdx];

    if (isRebalanceDate) {
      // Have we exhausted this batch's rebalance budget? If so, stop
      // BEFORE applying — the cursor sits at this mark date so the next
      // invocation picks up here and applies the rebalance.
      if (rebalancesProcessed >= batchSize) {
        state.nextMarkIdx = i;
        return {
          state,
          done: false,
          rebalancesProcessed,
          marksProcessed,
        };
      }

      // 1. Mark to today's close first so weights/equity are current.
      const marked = await markEquityAt(state.positions, state.cash, date, prices);
      state.positions = marked.positions;
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
        cash: state.cash,
        equity: preEquity,
        positions: state.positions,
        lastRebalanceAt: date,
        updatedAt: date,
      };
      const decision = decideRebalance(stateForRule, candidates, config, date);

      // 4. Apply exits.
      const swapOut: SwapEvent['out'] = [];
      for (const e of decision.out) {
        const pos = state.positions.find((p) => p.ticker === e.ticker);
        if (!pos) continue;
        const exitPx = (await prices.closeAt(e.ticker, date)) ?? pos.currentPrice;
        const grossProceeds = e.shares * exitPx;
        const slippage = (grossProceeds * config.slippageBps) / 10_000;
        const netProceeds = grossProceeds - slippage;
        state.cash += netProceeds;
        state.totalSlippage += slippage;
        state.totalTurnoverNotional += grossProceeds;
        const holdDays = Math.max(
          0,
          Math.round(
            (Date.parse(`${date}T00:00:00Z`) -
              Date.parse(`${pos.entryDate}T00:00:00Z`)) /
              86_400_000,
          ),
        );
        state.completedHolds.push(holdDays);
        swapOut.push({
          ticker: e.ticker,
          shares: e.shares,
          exitPrice: exitPx,
          holdDays,
          totalReturnPct: ((exitPx - pos.entryPrice) / pos.entryPrice) * 100,
          reasonCode: e.reason,
        });
        state.positions = state.positions.filter((p) => p.ticker !== e.ticker);
      }

      // 5. Apply additions at target weight.
      const postExitMarked = await markEquityAt(state.positions, state.cash, date, prices);
      state.positions = postExitMarked.positions;
      const equityForSizing = postExitMarked.equity;
      const swapIn: SwapEvent['in'] = [];
      for (const add of decision.in) {
        const px = await prices.closeAt(add.ticker, date);
        if (px == null || px <= 0) {
          state.warnings.push(`${date}: missing price for ${add.ticker}, addition skipped`);
          continue;
        }
        const grossSpend = Math.min(add.targetWeight * equityForSizing, state.cash);
        if (grossSpend <= 0) {
          state.warnings.push(`${date}: no cash for ${add.ticker}, addition skipped`);
          continue;
        }
        const effectivePx = px * (1 + config.slippageBps / 10_000);
        const shares = grossSpend / effectivePx;
        const slippage = grossSpend - shares * px;
        state.cash -= grossSpend;
        state.totalSlippage += slippage;
        state.totalTurnoverNotional += grossSpend;
        state.positions.push({
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
        state.swaps.push({
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

      state.nextRebalanceIdx++;
      rebalancesProcessed++;
    }

    // Daily mark (runs on every mark date — rebalance dates included).
    const marked = await markEquityAt(state.positions, state.cash, date, prices);
    state.positions = marked.positions;
    const spy = benchmarks?.spy ? await benchmarks.spy.closeAt('SPY', date) : null;
    const qqq = benchmarks?.qqq ? await benchmarks.qqq.closeAt('QQQ', date) : null;
    const iwf = benchmarks?.iwf ? await benchmarks.iwf.closeAt('IWF', date) : null;
    state.equityCurve.push({
      date,
      portfolio: marked.equity,
      spy,
      qqq,
      iwf,
    });
    marksProcessed++;
    i++;
    state.nextMarkIdx = i;

    // After a rebalance was applied this iteration, check the watchdog.
    // Daily-mark-only iterations are cheap; checking only after rebalances
    // keeps the inner loop tight and avoids tearing mid-mark-sweep.
    if (isRebalanceDate && isExpired() && rebalancesProcessed > 0) {
      return {
        state,
        done: false,
        rebalancesProcessed,
        marksProcessed,
      };
    }
  }

  // Schedule exhausted.
  return {
    state,
    done: true,
    rebalancesProcessed,
    marksProcessed,
  };
}

// --- Final metrics --------------------------------------------------------

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

function longestUnderwaterDaysFrom(
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
  const trailing = curve.length - 1 - peakIdx;
  if (trailing > longest) longest = trailing;
  return longest;
}

export interface FinalizeOptions {
  state: PortfolioBacktestState;
  config: PortfolioConfig;
  window: BacktestWindow;
  riskFreeDailyRate?: number;
}

/**
 * Compute the terminal `PortfolioBacktestResult` from a state that has
 * exhausted the rebalance schedule. Mirrors the metrics block at the
 * bottom of the unbatched harness so the result shape is identical and
 * downstream consumers (summary doc + detail subdoc) need no changes.
 */
export function finalizePortfolioBacktest(
  opts: FinalizeOptions,
): PortfolioBacktestResult {
  const { state, config, window } = opts;
  const equityCurve = state.equityCurve;
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
      ? ((state.totalTurnoverNotional / startVal) / yearsInWindow) * 100
      : 0;

  const avgHoldDays =
    state.completedHolds.length > 0
      ? state.completedHolds.reduce((s, x) => s + x, 0) / state.completedHolds.length
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
    longestUnderwaterDays: longestUnderwaterDaysFrom(
      equityCurve.map((p) => ({ date: p.date, value: p.portfolio })),
    ),
    swapCount: state.swaps.length,
    avgHoldDays: +avgHoldDays.toFixed(2),
    turnoverPct: +turnoverPct.toFixed(2),
    costDragPct: startVal > 0 ? +((state.totalSlippage / startVal) * 100).toFixed(4) : 0,
    rebalanceCount: sortedUnique(window.rebalanceDates).length,
    swaps: state.swaps,
    equityCurve,
    warnings: state.warnings,
  };
}
