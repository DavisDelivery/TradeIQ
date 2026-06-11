// Backtest engine main loop.
//
// Flow per rebalance:
//   1. Resolve universe pool at this asOfDate (PIT)
//   2. Build shared market context (SPY + sector ETFs)
//   3. Score every ticker in pool (concurrency-limited)
//   4. Build portfolio (top-N + caps)
//   5. Diff prev → next, apply costs, record trades
//   6. Mark equity day-by-day through to next rebalance using daily bars
//   7. Record per-analyst attribution + ML training rows
//
// Walk-forward integrity invariants enforced here:
//   - asOfDate is the ONLY source of "now"; we never call new Date()
//     to derive a fetch window
//   - mark-equity bars are fetched with `to <= nextRebalanceDate`
//   - the engine never reaches into scan-*.ts paths (which still use
//     new Date() for legacy live-mode windows)
//
// Phase 4a V1: long-only; daily-bar marks; prophet board only (other
// boards return null candidates and the engine emits a warning).

import { getDailyBars, type Bar } from '../data-provider';
import { mapWithConcurrency } from '../full-scan-iterator';
import { pitCacheWrap, type PitCacheKey } from '../pit-cache';
import {
  buildMarketContextAtDate,
  scoreTickerAtDate,
} from './score-at-date';
import { universePoolForDate, windowSurvivorshipCorrected } from './universe-pool';
import { walkForwardArray, finalMarkDate } from './walk-forward';
import { addDays, prevOrCurrentTradingDay, tradingDaysBetween } from './trading-calendar';
import { buildPortfolio, diffPortfolios } from './portfolio';
import { applyCosts } from './costs';
import { computeMetrics } from './metrics';
import {
  generateRunId,
  persistRunStart,
  persistRunResult,
  persistRunFailure,
  persistMLTrainingRows,
} from './persistence';
import type {
  BacktestConfig,
  BacktestResult,
  DailyEquityPoint,
  MLTrainingRow,
  PortfolioPosition,
  ScoredCandidate,
  TickerFailure,
  TradeRecord,
  AttributionRecord,
} from './types';

const BAR_LOOKBACK_DAYS = 300;

/**
 * Wave 3B (track-3 M3) — forced-liquidation gap. A held position with no
 * daily bar for MORE than this many consecutive trading days is treated
 * as delisted/halted: it is dropped from the carried portfolio (its
 * weight stops riding as an implicit 0%-return flat hold and no phantom
 * sell is booked against its stale close at the next rebalance) and a
 * warning is surfaced per occurrence. 10 trading days ≈ 2 calendar
 * weeks — beyond any routine halt/provider gap. Data-free by design (no
 * Polygon delisted-status lookups in this wave); mirrors
 * FORCED_LIQUIDATION_GAP_TRADING_DAYS in the portfolio harness.
 */
const FORCED_LIQUIDATION_GAP_TRADING_DAYS = 10;

const BENCHMARK_BY_UNIVERSE: Record<BacktestConfig['universe'], string> = {
  dow: 'DIA',
  sp500: 'SPY',
  ndx: 'QQQ',
  russell2k: 'IWM',
};

export interface RunBacktestOptions {
  /** Skip Firestore persistence — used by integrity tests + dry runs. */
  noPersist?: boolean;
  /** Optional logger callback — defaults to console-less silent. */
  onProgress?: (event: {
    phase: string;
    rebalanceDate?: string;
    rebalanceIndex?: number;
    totalRebalances?: number;
    msg?: string;
  }) => void;
  /**
   * Phase 4b-2: reuse a pre-existing runId instead of generating a new
   * one. The Phase 4b-2 launcher trigger endpoint writes a 'pending' row
   * via persistRunPending(), then fires the background function with the
   * runId attached. The background function calls runBacktest with
   * resumeRunId set so that:
   *   - generateRunId() is skipped
   *   - persistRunStart() is skipped (the trigger already wrote the row;
   *     re-running set() would clobber 'pending' → 'running' transition
   *     done by persistRunRunning())
   * persistRunResult / persistRunFailure write to the same runId at the
   * end of the run as usual.
   */
  resumeRunId?: string;
}

/**
 * Validate (and minimally normalize) a backtest config.
 *
 * code-review-2026-06 track-3 minor 10 — a future `endDate` used to pass
 * validation; the run then dragged a flat-equity tail through the window,
 * diluting CAGR/Sharpe. When `todayIso` (YYYY-MM-DD) is provided, a future
 * endDate is CLAMPED to it in place and a warning is returned rather than
 * throwing, so caller-built "through today"-style windows keep working.
 * `todayIso` is injected by the entry points (trigger / background
 * function): the engine itself must stay wall-clock-free per the
 * walk-forward integrity invariant (no `new Date()`-derived windows here).
 *
 * Returns warnings (empty array when nothing was normalized).
 */
export function validateConfig(
  config: BacktestConfig,
  todayIso?: string,
): string[] {
  const warnings: string[] = [];
  if (todayIso && config.endDate > todayIso) {
    warnings.push(
      `BacktestConfig: endDate ${config.endDate} is in the future; ` +
        `clamped to ${todayIso}.`,
    );
    config.endDate = todayIso;
  }
  if (config.startDate > config.endDate) {
    throw new Error(
      `BacktestConfig: startDate (${config.startDate}) > endDate (${config.endDate})`,
    );
  }
  if (config.startDate < '2018-01-01') {
    throw new Error(
      `BacktestConfig: startDate ${config.startDate} is before 2018-01-01. ` +
        `Polygon plan tier does not reach pre-2018 reliably; the engine ` +
        `enforces this as a hard floor.`,
    );
  }
  if (config.portfolio.topN <= 0) {
    throw new Error('BacktestConfig: portfolio.topN must be > 0');
  }
  if (config.initialCapital <= 0) {
    throw new Error('BacktestConfig: initialCapital must be > 0');
  }
  if (
    config.portfolio.maxPositionPct <= 0 ||
    config.portfolio.maxPositionPct > 1
  ) {
    throw new Error('BacktestConfig: maxPositionPct must be in (0, 1]');
  }
  return warnings;
}

/**
 * Fetch bars (cached) for a ticker through `to`. Default lookback window
 * is BAR_LOOKBACK_DAYS; pass an explicit `from` to extend the window
 * backwards (e.g., when the caller needs bars spanning both before AND
 * after a reference date, such as the ML-row write that captures entry
 * price + forward returns).
 *
 * The cache key includes `from` + `to` so different windows for the same
 * ticker don't collide.
 */
async function getCachedBars(
  ticker: string,
  from: string,
  to: string,
): Promise<Bar[]> {
  const key: PitCacheKey = {
    provider: 'polygon',
    dataClass: 'bars',
    ticker,
    asOfDate: to,
    extra: `from=${from}`,
  };
  return pitCacheWrap(key, () => getDailyBars(ticker, from, to));
}

async function getCachedBarsThrough(
  ticker: string,
  asOfDate: string,
): Promise<Bar[]> {
  return getCachedBars(ticker, addDays(asOfDate, -BAR_LOOKBACK_DAYS), asOfDate);
}

/**
 * Return the close price of the most recent bar whose trading day is on
 * or before `date`. Bars are Polygon daily aggregates: `{ o, h, l, c, v, t }`
 * where `t` is the Unix-ms timestamp at market open and `c` is the close.
 * Bars are assumed sorted ascending by `t`.
 *
 * Returns null when no bar exists on or before `date` (e.g., date precedes
 * the bar history).
 *
 * Exported for unit testing. Phase 4a hotfix-2 confirmed the helper itself
 * was correct — the original `null entryPrice` symptom was in the caller's
 * bar window, not here.
 */
export function lastCloseAtOrBefore(bars: Bar[], date: string): number | null {
  if (!bars || bars.length === 0) return null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    if (typeof bar.t !== 'number' || !Number.isFinite(bar.t)) continue;
    if (typeof bar.c !== 'number' || !Number.isFinite(bar.c)) continue;
    const barDate = new Date(bar.t).toISOString().slice(0, 10);
    if (barDate <= date) return bar.c;
  }
  return null;
}

/**
 * Per-day return series for a ticker over (startDate, endDate] using
 * daily bars. The first day's return is computed against the close on
 * startDate. Returns array of {date, ret}.
 */
function dailyReturnsBetween(
  bars: Bar[],
  startDate: string,
  endDate: string,
): { date: string; ret: number }[] {
  // Map each bar to a (date, close) tuple
  const byDate: { date: string; close: number }[] = [];
  for (const b of bars) {
    const d =
      typeof b.t === 'number'
        ? new Date(b.t as unknown as number).toISOString().slice(0, 10)
        : ((b as unknown as { date?: string }).date ?? null);
    if (d) byDate.push({ date: d, close: b.c });
  }
  byDate.sort((a, b) => a.date.localeCompare(b.date));

  // Find index of bar at or just before startDate
  let startIdx = -1;
  for (let i = byDate.length - 1; i >= 0; i--) {
    if (byDate[i].date <= startDate) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return [];

  const out: { date: string; ret: number }[] = [];
  let prevClose = byDate[startIdx].close;
  for (let i = startIdx + 1; i < byDate.length; i++) {
    if (byDate[i].date <= startDate) continue;
    if (byDate[i].date > endDate) break;
    const ret = (byDate[i].close - prevClose) / prevClose;
    out.push({ date: byDate[i].date, ret });
    prevClose = byDate[i].close;
  }
  return out;
}

/**
 * Score a single ticker's forward return from entry over N trading
 * days. Used for ML training rows + IC computation.
 *
 * Bars must cover [entryDate, entryDate + N+30 calendar days] for safety.
 */
function forwardReturn(
  bars: Bar[],
  entryDate: string,
  nTradingDays: number,
): number | null {
  const byDate: { date: string; close: number }[] = [];
  for (const b of bars) {
    const d =
      typeof b.t === 'number'
        ? new Date(b.t as unknown as number).toISOString().slice(0, 10)
        : ((b as unknown as { date?: string }).date ?? null);
    if (d) byDate.push({ date: d, close: b.c });
  }
  byDate.sort((a, b) => a.date.localeCompare(b.date));

  let entryIdx = -1;
  for (let i = byDate.length - 1; i >= 0; i--) {
    if (byDate[i].date <= entryDate) {
      entryIdx = i;
      break;
    }
  }
  if (entryIdx < 0) return null;
  const exitIdx = entryIdx + nTradingDays;
  if (exitIdx >= byDate.length) return null;
  return (byDate[exitIdx].close - byDate[entryIdx].close) / byDate[entryIdx].close;
}

/**
 * Bucket a market cap into small/mid/large. Cap thresholds:
 *   small:  < $2B
 *   mid:    $2B – $10B
 *   large:  > $10B
 *
 * Returns null when the cap is unknown (so Phase 5 can filter rather
 * than blindly bucket missing data).
 */
function marketCapBucket(
  cap: number | undefined,
): MLTrainingRow['marketCapBucket'] {
  if (!cap || !Number.isFinite(cap)) return null;
  if (cap < 2_000_000_000) return 'small';
  if (cap < 10_000_000_000) return 'mid';
  return 'large';
}

export async function runBacktest(
  config: BacktestConfig,
  options: RunBacktestOptions = {},
): Promise<BacktestResult> {
  validateConfig(config);
  // Phase 4b-2: if a runId was pre-allocated by the trigger endpoint,
  // reuse it (and skip the persistRunStart write — the trigger wrote
  // 'pending', and the background function flipped it to 'running'
  // before calling us). Otherwise allocate a fresh runId and write
  // the 'running' row as in the CLI path.
  const runId = options.resumeRunId ?? generateRunId();
  const warnings: string[] = [];
  const startedAt = new Date().toISOString();

  if (!options.noPersist && !options.resumeRunId) {
    await persistRunStart(runId, config);
  }

  try {
    const rebalanceDates = walkForwardArray(config);
    if (rebalanceDates.length === 0) {
      throw new Error(
        `No rebalance dates in window ${config.startDate}..${config.endDate}`,
      );
    }

    const survivorship = windowSurvivorshipCorrected(
      config.universe,
      rebalanceDates,
    );
    if (!survivorship.corrected) {
      warnings.push(
        `Universe ${config.universe} is not fully survivorship-corrected ` +
          `over [${config.startDate}, ${config.endDate}]. Coverage starts at ` +
          `${survivorship.coverageThrough ?? 'unknown'}. Results may be ` +
          `survivorship-biased — see BACKTEST_LIMITATIONS.md.`,
      );
    }

    let portfolio: PortfolioPosition[] = [];
    let nav = config.initialCapital;
    const dailyEquity: DailyEquityPoint[] = [
      { date: rebalanceDates[0], value: nav },
    ];
    const trades: TradeRecord[] = [];
    const attribution: AttributionRecord[] = [];
    const mlRows: MLTrainingRow[] = [];

    // Failure tracking — replaces the previous silent catch{} that
    // masked Firestore undefined-rejection in Phase 4a. Bounded sample
    // keeps the result doc under Firestore's 1MiB ceiling; aggregate
    // counts capture the full picture.
    const tickerFailureSample: TickerFailure[] = [];
    let tickerFailureTotal = 0;
    let tickerAttemptTotal = 0;
    const FAILURE_SAMPLE_CAP = 20;
    // CR-2 — candidates scored for pool tickers outside the current
    // universe seed (delisted/acquired historical members). Counted so
    // the run surfaces how much of the result comes from non-survivors.
    let scoredOutsideUniverseTotal = 0;
    // Wave 3B (M3) — consecutive trading days with no bar, per held
    // ticker. Persists across rebalance segments (a halt can span one);
    // pruned to the current target at each rebalance.
    const missingBarStreaks: Record<string, number> = {};

    // Pre-fetch benchmark bars once
    const benchTicker = BENCHMARK_BY_UNIVERSE[config.universe];
    const benchTo = finalMarkDate(config);
    const benchFrom = rebalanceDates[0];
    const benchKey: PitCacheKey = {
      provider: 'polygon',
      dataClass: 'bars',
      ticker: benchTicker,
      asOfDate: benchTo,
      extra: `from=${benchFrom}:engine-benchmark`,
    };
    const benchBars = await pitCacheWrap(benchKey, () =>
      getDailyBars(benchTicker, benchFrom, benchTo).catch(() => []),
    );

    for (let i = 0; i < rebalanceDates.length; i++) {
      const asOfDate = rebalanceDates[i];
      const nextAsOf = i + 1 < rebalanceDates.length ? rebalanceDates[i + 1] : finalMarkDate(config);

      options.onProgress?.({
        phase: 'rebalance_start',
        rebalanceDate: asOfDate,
        rebalanceIndex: i,
        totalRebalances: rebalanceDates.length,
      });

      // 1. Universe pool at this date (PIT)
      const pool = universePoolForDate(config.universe, asOfDate);
      if (pool.tickers.length === 0) {
        warnings.push(
          `${asOfDate}: universe pool empty (no PIT snapshot covers date)`,
        );
        // Mark equity stays flat through this segment
        const flatDays = tradingDaysBetween(addDays(asOfDate, 1), nextAsOf);
        for (const d of flatDays) dailyEquity.push({ date: d, value: nav });
        continue;
      }

      // 2. Shared market context
      const ctx = await buildMarketContextAtDate(asOfDate);

      // 3. Score with bounded concurrency
      const scoringConcurrency = config.scoringConcurrency ?? 5;
      const scored: ScoredCandidate[] = [];
      let nonProphetBoardWarned = false;
      const rebalanceFailures: TickerFailure[] = [];
      await mapWithConcurrency(
        pool.tickers,
        async (ticker) => {
          tickerAttemptTotal++;
          try {
            const result = await scoreTickerAtDate(
              ticker,
              asOfDate,
              config.board,
              ctx,
              { discreteSignalOnly: config.discreteSignalOnly },
            );
            if (
              result === null &&
              config.board !== 'prophet' &&
              config.board !== 'williams' &&
              config.board !== 'lynch' &&
              config.board !== 'target' &&
              !nonProphetBoardWarned
            ) {
              nonProphetBoardWarned = true;
              warnings.push(
                `Board "${config.board}" has no PIT scoring path; ` +
                  `prophet/williams/lynch/target are the supported boards. All candidates null.`,
              );
            }
            if (result) scored.push(result);
          } catch (err) {
            // Capture structured failure instead of silently dropping.
            // Phase 4a smoke test surfaced the cost of the previous
            // catch{} — a Firestore-undefined-rejection masquerading
            // as a clean run. This catch records the failure so the
            // result includes a faithful picture.
            const failure: TickerFailure = {
              rebalanceDate: asOfDate,
              ticker,
              message: err instanceof Error ? err.message : String(err),
              stage: 'scoreTickerAtDate',
            };
            rebalanceFailures.push(failure);
            tickerFailureTotal++;
            if (tickerFailureSample.length < FAILURE_SAMPLE_CAP) {
              tickerFailureSample.push(failure);
            }
          }
          return null;
        },
        { batchSize: scoringConcurrency },
      );

      // Surface a per-rebalance warning when failures dominate the
      // pool — useful for spotting widespread issues (rate limits,
      // provider outages, schema breaks) at the rebalance granularity.
      if (rebalanceFailures.length > pool.tickers.length / 2) {
        warnings.push(
          `${asOfDate}: ${rebalanceFailures.length}/${pool.tickers.length} ticker scoring attempts failed ` +
            `(sample: ${rebalanceFailures.slice(0, 3).map((f) => `${f.ticker}: ${f.message.slice(0, 80)}`).join('; ')})`,
        );
      }

      // CR-2 metric: how many of this rebalance's candidates came from
      // outside the current universe seed (scored with degraded metadata).
      scoredOutsideUniverseTotal += scored.filter(
        (c) => c.metadata?.outsideCurrentUniverse === true,
      ).length;

      // 4. Portfolio target
      const target = buildPortfolio(scored, config.portfolio);

      // 5. Diff prev → target, apply costs
      const prevPrices = new Map<string, number>();
      for (const p of portfolio) {
        const bars = await getCachedBarsThrough(p.ticker, asOfDate).catch(() => []);
        const price = lastCloseAtOrBefore(bars, asOfDate);
        if (price != null) prevPrices.set(p.ticker, price);
      }
      const partialTrades = diffPortfolios(
        portfolio,
        target,
        nav,
        asOfDate,
        prevPrices,
      );
      const segmentTrades: TradeRecord[] = partialTrades.map((t) =>
        applyCosts(
          {
            rebalanceDate: t.rebalanceDate,
            ticker: t.ticker,
            side: t.side,
            prevWeight: t.prevWeight,
            newWeight: t.newWeight,
            deltaWeight: t.deltaWeight,
            notional: t.notional,
            refPrice: t.refPrice,
          },
          config.universe,
          config.costs,
        ),
      );

      // Pay slippage + commission out of NAV upfront at the rebalance
      const costDrag = segmentTrades.reduce(
        (s, t) => s + t.slippageDollars + t.commissionDollars,
        0,
      );
      nav = Math.max(0, nav - costDrag);

      trades.push(...segmentTrades);

      // 6. Mark equity day-by-day from (asOfDate, nextAsOf]
      //    Position-level marks weighted by target weight.
      const positionReturns = new Map<string, { date: string; ret: number }[]>();
      for (const p of target) {
        const bars = await getCachedBarsThrough(p.ticker, nextAsOf).catch(
          () => [],
        );
        const rets = dailyReturnsBetween(bars, asOfDate, nextAsOf);
        positionReturns.set(p.ticker, rets);
      }

      // Wave 3B (M3) — prune streak entries for tickers no longer held,
      // then walk the segment tracking per-ticker missing-bar streaks.
      // A position whose streak exceeds the gap is force-liquidated:
      // its (already 0%-return) weight stops riding and it is removed
      // from the carried portfolio below, so the next rebalance's diff
      // does not book a phantom sell at its stale close. A delisted
      // name cannot be transacted; the warning surfaces the event.
      for (const k of Object.keys(missingBarStreaks)) {
        if (!target.some((p) => p.ticker === k)) delete missingBarStreaks[k];
      }
      const forciblyLiquidated = new Set<string>();

      const dates = tradingDaysBetween(addDays(asOfDate, 1), nextAsOf);
      for (const date of dates) {
        let portReturn = 0;
        for (const p of target) {
          if (forciblyLiquidated.has(p.ticker)) continue;
          const rets = positionReturns.get(p.ticker) ?? [];
          const today = rets.find((r) => r.date === date);
          if (today) {
            missingBarStreaks[p.ticker] = 0;
            portReturn += p.weight * today.ret;
          } else {
            const streak = (missingBarStreaks[p.ticker] ?? 0) + 1;
            missingBarStreaks[p.ticker] = streak;
            if (streak > FORCED_LIQUIDATION_GAP_TRADING_DAYS) {
              forciblyLiquidated.add(p.ticker);
              delete missingBarStreaks[p.ticker];
              warnings.push(
                `${date}: ${p.ticker} has no daily bar for ${streak} consecutive trading days — ` +
                  `forced liquidation at last traded close (delisting/halt suspected; ` +
                  `see FORCED_LIQUIDATION_GAP_TRADING_DAYS)`,
              );
            }
          }
        }
        nav = nav * (1 + portReturn);
        dailyEquity.push({ date, value: nav });
      }

      // 7a. Per-position attribution — stays portfolio-level. One record
      //     per HELD position; this is intentionally NOT per-candidate
      //     (attribution explains the portfolio's realized return).
      for (const p of target) {
        const rets = positionReturns.get(p.ticker) ?? [];
        const segmentReturn = rets.reduce((acc, r) => (1 + acc) * (1 + r.ret) - 1, 0);
        attribution.push({
          rebalanceDate: asOfDate,
          ticker: p.ticker,
          weight: p.weight,
          segmentReturn,
          contribution: p.weight * segmentReturn,
          layers: p.layers,
          composite: p.composite,
          regime: (ctx.regime?.regime as string | undefined) ?? null,
        });
      }

      // 7b. ML training rows — Phase 5a-prep: one row per SCORED
      //     CANDIDATE (the full ~500-name set for sp500), not per held
      //     position. This makes the 5a training data cross-sectional —
      //     the model learns what features predict forward return across
      //     the whole universe, not just across the selection-confirmed
      //     held subset (which is a biased ~2-name sample at sp500 scale).
      //     `inPortfolio` marks which candidates were actually held.
      //
      //     Each candidate needs its own getCachedBars fetch (~500/rebalance
      //     vs ~2 before). Bars are PIT-cached so re-runs are cheap, but
      //     the first run is slower; the bar fetches run through
      //     mapWithConcurrency at a modest concurrency so a rebalance does
      //     not fan out 500 simultaneous provider calls. mapWithConcurrency
      //     keys on ticker strings and preserves input order in its result
      //     array, so ml-row ordering — and therefore the batched-engine
      //     cursor's doc-id assignment — stays deterministic (`scored`
      //     order). A ticker can appear in `scored` at most once per
      //     rebalance, so the candidate lookup is unambiguous.
      const heldTickers = new Set(target.map((p) => p.ticker));
      const scoredByTicker = new Map(scored.map((c) => [c.ticker, c]));
      const ML_ROW_BAR_CONCURRENCY = 6;
      const candidateRows = await mapWithConcurrency(
        scored.map((c) => c.ticker),
        async (ticker): Promise<MLTrainingRow> => {
          const c = scoredByTicker.get(ticker)!;
          // The window must span BOTH backward (so lastCloseAtOrBefore can
          // resolve the entry close on asOfDate) AND ~400 calendar days
          // forward (covering the 252-trading-day max forward horizon).
          // Phase 4a hotfix-2 fix: previously called getCachedBarsThrough
          // with asOfDate + 400d which yielded a window of (+100d, +400d),
          // missing the rebalance date entirely → entryPrice null and all
          // forward returns null → IC = 0.
          const longBars = await getCachedBars(
            c.ticker,
            addDays(asOfDate, -30), // small backward buffer so the entry bar is present
            addDays(asOfDate, 400),
          ).catch(() => []);
          const entryClose = lastCloseAtOrBefore(longBars, asOfDate);
          return {
            runId,
            ticker: c.ticker,
            asOfDate,
            composite: c.composite,
            layers: c.layers,
            regime: (ctx.regime?.regime as string | undefined) ?? null,
            sector: c.sector,
            marketCapBucket: null,
            inPortfolio: heldTickers.has(c.ticker),
            entryPrice: entryClose,
            exitPrice: null,
            holdDays: null,
            forward5dReturn: forwardReturn(longBars, asOfDate, 5),
            forward20dReturn: forwardReturn(longBars, asOfDate, 20),
            forward60dReturn: forwardReturn(longBars, asOfDate, 60),
            forward252dReturn: forwardReturn(longBars, asOfDate, 252),
            realizedPnl: null,
          };
        },
        { batchSize: ML_ROW_BAR_CONCURRENCY },
      );
      // The mapper never throws (the sole async op is .catch-wrapped), so
      // mapWithConcurrency yields no undefined slots in practice; the
      // filter is a type-narrowing guard for its Array<T | undefined>
      // return type.
      for (const row of candidateRows) {
        if (row !== undefined) mlRows.push(row);
      }

      // Wave 3B (M3) — carry only positions that were not force-
      // liquidated during the segment; their freed weight is implicitly
      // cash from here on.
      portfolio =
        forciblyLiquidated.size > 0
          ? target.filter((p) => !forciblyLiquidated.has(p.ticker))
          : target;
    }

    // Benchmark return for IR
    let benchTotalRet = 0;
    if (benchBars.length >= 2) {
      const first = benchBars[0]?.c;
      const last = benchBars[benchBars.length - 1]?.c;
      if (first && last && first > 0) {
        benchTotalRet = (last - first) / first;
      }
    }

    // Top-level sanity check: if more than half of all ticker scoring
    // attempts failed, the run is fundamentally broken and the result
    // should reflect that prominently. The previous Phase 4a smoke
    // test would have surfaced 100% failure rate here instead of
    // looking like a clean all-zeros backtest.
    const failureRate =
      tickerAttemptTotal > 0 ? tickerFailureTotal / tickerAttemptTotal : 0;
    if (failureRate > 0.5) {
      warnings.push(
        `HIGH FAILURE RATE: ${(failureRate * 100).toFixed(1)}% of ticker scoring ` +
          `attempts failed (${tickerFailureTotal}/${tickerAttemptTotal}). ` +
          `Result is not trustworthy — inspect tickerFailures.sample to diagnose.`,
      );
    }

    // CR-2 — informational: non-zero means the survivorship correction is
    // actually reaching non-survivors (scored with degraded name/sector).
    if (scoredOutsideUniverseTotal > 0) {
      warnings.push(
        `${scoredOutsideUniverseTotal} candidate scores came from tickers outside the ` +
          `current universe seed (historical index members, e.g. delisted/acquired ` +
          `names). These score with degraded name/sector metadata — see ` +
          `score-at-date.ts (CR-2).`,
      );
    }

    const metrics = computeMetrics({
      dailyEquity,
      trades,
      attribution,
      mlRows,
      benchmarkBars: benchBars,
      initialCapital: config.initialCapital,
      startDate: rebalanceDates[0],
      endDate: prevOrCurrentTradingDay(config.endDate),
    });

    const result: BacktestResult = {
      runId,
      config,
      metrics,
      dailyEquity,
      trades,
      perAnalystAttribution: attribution,
      universeSurvivorshipCorrected: {
        universe: config.universe,
        corrected: survivorship.corrected,
        coverageThrough: survivorship.coverageThrough,
      },
      warnings,
      tickerFailures: {
        total: tickerFailureTotal,
        totalAttempts: tickerAttemptTotal,
        failureRatePct: +(failureRate * 100).toFixed(2),
        sample: tickerFailureSample,
      },
      scoredOutsideCurrentUniverse: scoredOutsideUniverseTotal,
      completedAt: new Date().toISOString(),
      benchmark: {
        ticker: benchTicker,
        totalReturnPct: +(benchTotalRet * 100).toFixed(4),
      },
    };

    if (!options.noPersist) {
      await persistRunResult(runId, result);
      await persistMLTrainingRows(runId, mlRows);
    }

    options.onProgress?.({ phase: 'complete', msg: `runId=${runId}` });
    return result;
  } catch (err) {
    if (!options.noPersist) {
      await persistRunFailure(runId, String(err)).catch(() => {});
    }
    throw err;
  }
}

// Phase 4e-1-infra — re-export the engine's internal helpers so the
// batched/resumable companion module (`engine-batched.ts`) can drive a
// per-rebalance loop without duplicating the bar-window math. Keeps a
// single source of truth for cache keys, forward-return horizons, and
// the date-window edge cases (Phase 4a hotfix-2 lessons).
export const _engineInternals = {
  getCachedBars,
  getCachedBarsThrough,
  dailyReturnsBetween,
  forwardReturn,
  marketCapBucket,
  BENCHMARK_BY_UNIVERSE,
  // Wave 3B (M3) — shared with engine-batched so both paths liquidate
  // on the same gap.
  FORCED_LIQUIDATION_GAP_TRADING_DAYS,
};
