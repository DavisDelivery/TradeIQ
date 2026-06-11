// Phase 4e-1-infra — batched/resumable regular backtest engine.
//
// Same per-rebalance semantics as `runBacktest` in `engine.ts`, but
// factored so the bg-function can:
//   - process a slice of the rebalance schedule per invocation,
//   - persist a serializable state snapshot at the batch boundary,
//   - resume from that snapshot on a follow-on invocation,
//   - write each batch's mlTraining rows to a subcollection immediately
//     (kickoff requirement — accumulating them in the cursor would push
//     the run doc past Firestore's 1 MiB ceiling for full sp500/monthly).
//
// The unbatched `runBacktest` in `engine.ts` remains the canonical entry
// for CLI runs + integration tests. Both paths share the per-rebalance
// math via `_engineInternals` (getCachedBars, dailyReturnsBetween,
// forwardReturn) — one source of truth for bar-window edge cases.

import { mapWithConcurrency } from '../full-scan-iterator';
import { pitCacheWrap, type PitCacheKey } from '../pit-cache';
import { getDailyBars, type Bar } from '../data-provider';
import {
  buildMarketContextAtDate,
  scoreTickerAtDate,
} from './score-at-date';
import {
  universePoolForDate,
  windowSurvivorshipCorrected,
} from './universe-pool';
import { walkForwardArray, finalMarkDate } from './walk-forward';
import {
  addDays,
  prevOrCurrentTradingDay,
  tradingDaysBetween,
} from './trading-calendar';
import { buildPortfolio, diffPortfolios } from './portfolio';
import { applyCosts } from './costs';
import { computeMetrics } from './metrics';
import { _engineInternals, lastCloseAtOrBefore } from './engine';
import type {
  AttributionRecord,
  BacktestConfig,
  BacktestResult,
  DailyEquityPoint,
  MLTrainingRow,
  PortfolioPosition,
  ScoredCandidate,
  TickerFailure,
  TradeRecord,
} from './types';

const FAILURE_SAMPLE_CAP = 20;

/**
 * Serializable per-run state — *bounded checkpoint only*. Carries
 * everything the next batch needs to resume + counters used in the
 * finalize, but NO unbounded accumulations. Phase 4u W1 moved
 * `dailyEquity / trades / attribution / warnings` out of this shape
 * into `ProcessBatchResult.batch*` slices that the worker streams to
 * Firestore subcollections per batch — the same discipline
 * `mlTraining` rows have followed since Phase 4e-1-infra. Without
 * that the cursor doc blew past Firestore's 1 MiB ceiling on the
 * 2026-05-19 Williams baseline. See `reports/phase-4u/diagnosis.md`.
 */
export interface RegularBacktestState {
  /** Next rebalance index to process (0-based). */
  nextRebalanceIdx: number;
  /** Total rebalances in the schedule (immutable across batches). */
  totalRebalances: number;
  /** Most recent target portfolio (passed into next rebalance's diff). Bounded by topN. */
  portfolio: PortfolioPosition[];
  /** Current NAV (compounded through marks). */
  nav: number;
  /** Bounded sample of ticker failures (≤ 20 across the run). */
  tickerFailureSample: TickerFailure[];
  /** Total ticker failures across the run (unbounded counter — a number, not an array). */
  tickerFailureTotal: number;
  /** Total ticker scoring attempts (denominator for failure-rate metric). */
  tickerAttemptTotal: number;
  /** Cumulative count of mlTraining rows written to the subcollection. */
  mlTrainingRowCount: number;
  /** Cumulative count of dailyEquity points written to the subcollection (Phase 4u). */
  dailyEquityRowCount: number;
  /** Cumulative count of trades written to the subcollection (Phase 4u). */
  tradeRowCount: number;
  /** Cumulative count of attribution records written to the subcollection (Phase 4u). */
  attributionRowCount: number;
  /** Cumulative count of warnings written to the subcollection (Phase 4u). */
  warningRowCount: number;
  /** Sticky flag: did we already warn about survivorship for this run? */
  survivorshipWarned: boolean;
  /**
   * CR-2 — cumulative count of candidates scored for pool tickers outside
   * the current universe seed (delisted/acquired historical members).
   * Optional with `?? 0` defaulting on resume: cursors persisted before
   * the fix predate the field.
   */
  scoredOutsideUniverseTotal?: number;
}

export interface ProcessBatchOptions {
  config: BacktestConfig;
  runId: string;
  /** State at the start of this batch. Caller seeds initial state on fresh runs. */
  state: RegularBacktestState;
  /** Maximum number of rebalances to process in this batch. */
  batchSize: number;
  /** Optional watchdog — when it returns true after a rebalance, batch breaks early. */
  isExpired?: () => boolean;
  /** Optional progress callback. */
  onProgress?: (evt: {
    phase: string;
    rebalanceDate?: string;
    rebalanceIndex?: number;
    totalRebalances?: number;
  }) => void;
}

export interface ProcessBatchResult {
  state: RegularBacktestState;
  done: boolean;
  rebalancesProcessed: number;
  /** mlTraining rows produced during THIS batch only. Caller persists them. */
  batchMlRows: MLTrainingRow[];
  /** Phase 4u — dailyEquity points produced during THIS batch only.
   *  Includes the t0 seed point on the very first batch (when
   *  `opts.state.nextRebalanceIdx === 0`). Caller appends to the
   *  per-run dailyEquity subcollection. */
  batchDailyEquity: DailyEquityPoint[];
  /** Phase 4u — trades produced during THIS batch only. Caller persists. */
  batchTrades: TradeRecord[];
  /** Phase 4u — attribution records produced during THIS batch only.
   *  Caller persists. */
  batchAttribution: AttributionRecord[];
  /** Phase 4u — warnings emitted during THIS batch only. Caller persists.
   *  Most batches emit zero or one warning; the sticky `survivorshipWarned`
   *  flag prevents duplicates across batches. */
  batchWarnings: string[];
}

/** Build the zero state for a fresh run.
 *
 *  Phase 4u — the t0 dailyEquity seed point is emitted by
 *  `processRegularBatch` on its first invocation
 *  (`nextRebalanceIdx === 0`), not seeded inline on the cursor — the
 *  cursor is a *bounded checkpoint*, never a ledger. The seed lands
 *  in the dailyEquity subcollection like every other equity point.
 *  `firstRebalanceDate` is kept for backward compat with callers that
 *  used to read the seeded array; the engine no longer reads it. */
export function initialRegularState(
  config: BacktestConfig,
  totalRebalances: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _firstRebalanceDate: string,
): RegularBacktestState {
  return {
    nextRebalanceIdx: 0,
    totalRebalances,
    portfolio: [],
    nav: config.initialCapital,
    tickerFailureSample: [],
    tickerFailureTotal: 0,
    tickerAttemptTotal: 0,
    mlTrainingRowCount: 0,
    dailyEquityRowCount: 0,
    tradeRowCount: 0,
    attributionRowCount: 0,
    warningRowCount: 0,
    survivorshipWarned: false,
    scoredOutsideUniverseTotal: 0,
  };
}

/**
 * Compute the immutable per-run prep data once per invocation. Cheap to
 * recompute because the underlying calls are cached / pure:
 *   - walkForwardArray is pure (date math),
 *   - windowSurvivorshipCorrected reads pre-loaded universe history,
 *   - benchmark bar fetch hits the PIT cache after the first time.
 */
async function prepRun(config: BacktestConfig): Promise<{
  rebalanceDates: string[];
  benchTicker: string;
  benchBars: Bar[];
  survivorship: ReturnType<typeof windowSurvivorshipCorrected>;
}> {
  const rebalanceDates = walkForwardArray(config);
  if (rebalanceDates.length === 0) {
    throw new Error(
      `No rebalance dates in window ${config.startDate}..${config.endDate}`,
    );
  }
  const survivorship = windowSurvivorshipCorrected(config.universe, rebalanceDates);
  const benchTicker = _engineInternals.BENCHMARK_BY_UNIVERSE[config.universe];
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
  return { rebalanceDates, benchTicker, benchBars, survivorship };
}

/**
 * Process up to `batchSize` rebalances starting at `state.nextRebalanceIdx`.
 * Mutates a working copy of state and returns the per-batch mlRows so the
 * caller can persist them to the run's mlTraining subcollection.
 *
 * Stopping rules (in order):
 *   1. If the schedule is exhausted, `done: true`.
 *   2. After applying batchSize rebalances, break.
 *   3. After each rebalance, if `isExpired()` is true, break.
 */
export async function processRegularBatch(
  opts: ProcessBatchOptions,
): Promise<ProcessBatchResult> {
  const { config, runId, batchSize } = opts;
  const isExpired = opts.isExpired ?? (() => false);

  const { rebalanceDates, survivorship } = await prepRun(config);

  // Shallow-copy state so callers' references are not mutated.
  // Phase 4u — `dailyEquity / trades / attribution / warnings` are no
  // longer carried on state; the per-batch slices live in the
  // batch-local accumulators below and the worker streams them to
  // subcollections.
  const state: RegularBacktestState = {
    ...opts.state,
    portfolio: opts.state.portfolio.map((p) => ({ ...p })),
    tickerFailureSample: opts.state.tickerFailureSample.slice(),
    // Cursors persisted before the CR-2 fix lack the counter — default it.
    scoredOutsideUniverseTotal: opts.state.scoredOutsideUniverseTotal ?? 0,
  };

  // Per-batch outputs — flushed to subcollections by the worker after
  // the batch returns. Each is BATCH-LOCAL: the engine never reads them
  // from a prior batch.
  const batchMlRows: MLTrainingRow[] = [];
  const batchDailyEquity: DailyEquityPoint[] = [];
  const batchTrades: TradeRecord[] = [];
  const batchAttribution: AttributionRecord[] = [];
  const batchWarnings: string[] = [];

  // Phase 4u — emit the t0 dailyEquity seed on the first batch only.
  // (Phase 4e-1-infra seeded this on `initialRegularState` and carried
  // it on the cursor; that's what unbounded growth was hiding.)
  if (state.nextRebalanceIdx === 0) {
    batchDailyEquity.push({
      date: rebalanceDates[0],
      value: state.nav,
    });
  }

  // Add the survivorship warning once per run (fresh-start state has the
  // flag false; resumed states retain whether the warning fired earlier).
  if (!state.survivorshipWarned && !survivorship.corrected) {
    batchWarnings.push(
      `Universe ${config.universe} is not fully survivorship-corrected ` +
        `over [${config.startDate}, ${config.endDate}]. Coverage starts at ` +
        `${survivorship.coverageThrough ?? 'unknown'}. Results may be ` +
        `survivorship-biased — see BACKTEST_LIMITATIONS.md.`,
    );
    state.survivorshipWarned = true;
  }

  let rebalancesProcessed = 0;

  const startIdx = state.nextRebalanceIdx;
  const endIdx = Math.min(startIdx + batchSize, rebalanceDates.length);

  for (let i = startIdx; i < endIdx; i++) {
    const asOfDate = rebalanceDates[i];
    const nextAsOf =
      i + 1 < rebalanceDates.length ? rebalanceDates[i + 1] : finalMarkDate(config);

    opts.onProgress?.({
      phase: 'rebalance_start',
      rebalanceDate: asOfDate,
      rebalanceIndex: i,
      totalRebalances: rebalanceDates.length,
    });

    // 1. Universe pool at this date (PIT)
    const pool = universePoolForDate(config.universe, asOfDate);
    if (pool.tickers.length === 0) {
      batchWarnings.push(
        `${asOfDate}: universe pool empty (no PIT snapshot covers date)`,
      );
      const flatDays = tradingDaysBetween(addDays(asOfDate, 1), nextAsOf);
      for (const d of flatDays) batchDailyEquity.push({ date: d, value: state.nav });
      state.nextRebalanceIdx = i + 1;
      rebalancesProcessed++;
      if (isExpired()) break;
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
        state.tickerAttemptTotal++;
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
            batchWarnings.push(
              `Board "${config.board}" has no PIT scoring path; ` +
                `prophet/williams/lynch/target are the supported boards. All candidates null.`,
            );
          }
          if (result) scored.push(result);
        } catch (err) {
          const failure: TickerFailure = {
            rebalanceDate: asOfDate,
            ticker,
            message: err instanceof Error ? err.message : String(err),
            stage: 'scoreTickerAtDate',
          };
          rebalanceFailures.push(failure);
          state.tickerFailureTotal++;
          if (state.tickerFailureSample.length < FAILURE_SAMPLE_CAP) {
            state.tickerFailureSample.push(failure);
          }
        }
        return null;
      },
      { batchSize: scoringConcurrency },
    );

    if (rebalanceFailures.length > pool.tickers.length / 2) {
      batchWarnings.push(
        `${asOfDate}: ${rebalanceFailures.length}/${pool.tickers.length} ticker scoring attempts failed ` +
          `(sample: ${rebalanceFailures.slice(0, 3).map((f) => `${f.ticker}: ${f.message.slice(0, 80)}`).join('; ')})`,
      );
    }

    // CR-2 metric: candidates from outside the current universe seed
    // (scored with degraded metadata). Must mirror engine.ts.
    state.scoredOutsideUniverseTotal =
      (state.scoredOutsideUniverseTotal ?? 0) +
      scored.filter((c) => c.metadata?.outsideCurrentUniverse === true).length;

    // 4. Portfolio target
    const target = buildPortfolio(scored, config.portfolio);

    // 5. Diff prev → target, apply costs
    const prevPrices = new Map<string, number>();
    for (const p of state.portfolio) {
      const bars = await _engineInternals
        .getCachedBarsThrough(p.ticker, asOfDate)
        .catch(() => [] as Bar[]);
      const price = lastCloseAtOrBefore(bars, asOfDate);
      if (price != null) prevPrices.set(p.ticker, price);
    }
    const partialTrades = diffPortfolios(
      state.portfolio,
      target,
      state.nav,
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

    const costDrag = segmentTrades.reduce(
      (s, t) => s + t.slippageDollars + t.commissionDollars,
      0,
    );
    state.nav = Math.max(0, state.nav - costDrag);
    batchTrades.push(...segmentTrades);

    // 6. Mark equity day-by-day from (asOfDate, nextAsOf]
    const positionReturns = new Map<string, { date: string; ret: number }[]>();
    for (const p of target) {
      const bars = await _engineInternals
        .getCachedBarsThrough(p.ticker, nextAsOf)
        .catch(() => [] as Bar[]);
      const rets = _engineInternals.dailyReturnsBetween(bars, asOfDate, nextAsOf);
      positionReturns.set(p.ticker, rets);
    }

    const dates = tradingDaysBetween(addDays(asOfDate, 1), nextAsOf);
    for (const date of dates) {
      let portReturn = 0;
      for (const p of target) {
        const rets = positionReturns.get(p.ticker) ?? [];
        const todayRet = rets.find((r) => r.date === date)?.ret ?? 0;
        portReturn += p.weight * todayRet;
      }
      state.nav = state.nav * (1 + portReturn);
      batchDailyEquity.push({ date, value: state.nav });
    }

    // 7a. Per-position attribution — stays portfolio-level. One record
    //     per HELD position; intentionally NOT per-candidate (attribution
    //     explains the portfolio's realized return). Must mirror engine.ts.
    for (const p of target) {
      const rets = positionReturns.get(p.ticker) ?? [];
      const segmentReturn = rets.reduce((acc, r) => (1 + acc) * (1 + r.ret) - 1, 0);
      batchAttribution.push({
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

    // 7b. ML training rows — Phase 5a-prep: one row per SCORED CANDIDATE
    //     (full ~500-name set for sp500), not per held position. Must
    //     mirror engine.ts §7b exactly — the equivalence tests assert the
    //     batched engine produces identical per-candidate rows. See the
    //     engine.ts comment for the cross-sectional-training rationale.
    //
    //     mapWithConcurrency keys on ticker strings and preserves input
    //     order, so batchMlRows lands in `scored` order. Determinism here
    //     is load-bearing for the cursor: appendMLTrainingRows assigns doc
    //     ids startIdx..startIdx+N-1 in array order, and a resumed run
    //     must reproduce the same ids — see processRegularBatch's
    //     mlTrainingRowCount accounting below.
    const heldTickers = new Set(target.map((p) => p.ticker));
    const scoredByTicker = new Map(scored.map((c) => [c.ticker, c]));
    const ML_ROW_BAR_CONCURRENCY = 6;
    const candidateRows = await mapWithConcurrency(
      scored.map((c) => c.ticker),
      async (ticker): Promise<MLTrainingRow> => {
        const c = scoredByTicker.get(ticker)!;
        const longBars = await _engineInternals
          .getCachedBars(
            c.ticker,
            addDays(asOfDate, -30),
            addDays(asOfDate, 400),
          )
          .catch(() => [] as Bar[]);
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
          forward5dReturn: _engineInternals.forwardReturn(longBars, asOfDate, 5),
          forward20dReturn: _engineInternals.forwardReturn(longBars, asOfDate, 20),
          forward60dReturn: _engineInternals.forwardReturn(longBars, asOfDate, 60),
          forward252dReturn: _engineInternals.forwardReturn(longBars, asOfDate, 252),
          realizedPnl: null,
        };
      },
      { batchSize: ML_ROW_BAR_CONCURRENCY },
    );
    // The mapper never throws (sole async op is .catch-wrapped); the
    // filter narrows mapWithConcurrency's Array<T | undefined> return.
    for (const row of candidateRows) {
      if (row !== undefined) batchMlRows.push(row);
    }

    state.portfolio = target;
    state.nextRebalanceIdx = i + 1;
    rebalancesProcessed++;

    if (isExpired()) break;
  }

  const done = state.nextRebalanceIdx >= rebalanceDates.length;
  state.mlTrainingRowCount += batchMlRows.length;
  state.dailyEquityRowCount += batchDailyEquity.length;
  state.tradeRowCount += batchTrades.length;
  state.attributionRowCount += batchAttribution.length;
  state.warningRowCount += batchWarnings.length;

  return {
    state,
    done,
    rebalancesProcessed,
    batchMlRows,
    batchDailyEquity,
    batchTrades,
    batchAttribution,
    batchWarnings,
  };
}

export interface FinalizeOptions {
  config: BacktestConfig;
  runId: string;
  state: RegularBacktestState;
  /** All mlTraining rows for this run — caller reads them back from the subcollection. */
  allMlRows: MLTrainingRow[];
  /** All dailyEquity points for this run — caller reads from subcollection (Phase 4u). */
  allDailyEquity: DailyEquityPoint[];
  /** All trades for this run — caller reads from subcollection (Phase 4u). */
  allTrades: TradeRecord[];
  /** All attribution records for this run — caller reads from subcollection (Phase 4u). */
  allAttribution: AttributionRecord[];
  /** All warnings emitted during the run — caller reads from subcollection (Phase 4u). */
  allWarnings: string[];
  /** Pre-fetched benchmark bars (or empty array). */
  benchBars: Bar[];
  /** Benchmark ticker (used for the result's benchmark field). */
  benchTicker: string;
  /** All rebalance dates (immutable, recomputable). */
  rebalanceDates: string[];
  /** Survivorship coverage info from prepRun. */
  survivorship: ReturnType<typeof windowSurvivorshipCorrected>;
}

/**
 * Compute the terminal BacktestResult from an exhausted state + the
 * subcollection-read mlTraining/dailyEquity/trades/attribution/warning
 * arrays. Mirrors the metrics block at the bottom of `runBacktest` so
 * the result shape is identical.
 */
export function finalizeRegularBacktest(opts: FinalizeOptions): BacktestResult {
  const {
    config, runId, state, allMlRows, allDailyEquity, allTrades, allAttribution,
    allWarnings, benchBars, benchTicker, rebalanceDates, survivorship,
  } = opts;
  const warnings = allWarnings.slice();

  // CR-2 — informational warning; must mirror engine.ts.
  const scoredOutsideUniverseTotal = state.scoredOutsideUniverseTotal ?? 0;
  if (scoredOutsideUniverseTotal > 0) {
    warnings.push(
      `${scoredOutsideUniverseTotal} candidate scores came from tickers outside the ` +
        `current universe seed (historical index members, e.g. delisted/acquired ` +
        `names). These score with degraded name/sector metadata — see ` +
        `score-at-date.ts (CR-2).`,
    );
  }

  const failureRate =
    state.tickerAttemptTotal > 0
      ? state.tickerFailureTotal / state.tickerAttemptTotal
      : 0;
  if (failureRate > 0.5) {
    warnings.push(
      `HIGH FAILURE RATE: ${(failureRate * 100).toFixed(1)}% of ticker scoring ` +
        `attempts failed (${state.tickerFailureTotal}/${state.tickerAttemptTotal}). ` +
        `Result is not trustworthy — inspect tickerFailures.sample to diagnose.`,
    );
  }

  let benchTotalRet = 0;
  if (benchBars.length >= 2) {
    const first = benchBars[0]?.c;
    const last = benchBars[benchBars.length - 1]?.c;
    if (first && last && first > 0) {
      benchTotalRet = (last - first) / first;
    }
  }

  const metrics = computeMetrics({
    dailyEquity: allDailyEquity,
    trades: allTrades,
    attribution: allAttribution,
    mlRows: allMlRows,
    benchmarkBars: benchBars,
    initialCapital: config.initialCapital,
    startDate: rebalanceDates[0],
    endDate: prevOrCurrentTradingDay(config.endDate),
  });

  return {
    runId,
    config,
    metrics,
    dailyEquity: allDailyEquity,
    trades: allTrades,
    perAnalystAttribution: allAttribution,
    universeSurvivorshipCorrected: {
      universe: config.universe,
      corrected: survivorship.corrected,
      coverageThrough: survivorship.coverageThrough,
    },
    warnings,
    tickerFailures: {
      total: state.tickerFailureTotal,
      totalAttempts: state.tickerAttemptTotal,
      failureRatePct: +(failureRate * 100).toFixed(2),
      sample: state.tickerFailureSample,
    },
    scoredOutsideCurrentUniverse: scoredOutsideUniverseTotal,
    completedAt: new Date().toISOString(),
    benchmark: {
      ticker: benchTicker,
      totalReturnPct: +(benchTotalRet * 100).toFixed(4),
    },
  };
}

// Re-exported for callers (bg-function) that need prep info on fresh runs.
export { prepRun };
