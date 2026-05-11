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
}

function validateConfig(config: BacktestConfig): void {
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
}

/**
 * Fetch bars (cached) for a ticker through asOfDate. The cache key
 * includes the asOfDate so different rebalances don't poison each other.
 */
async function getCachedBarsThrough(
  ticker: string,
  asOfDate: string,
): Promise<Bar[]> {
  const from = addDays(asOfDate, -BAR_LOOKBACK_DAYS);
  const key: PitCacheKey = {
    provider: 'polygon',
    dataClass: 'bars',
    ticker,
    asOfDate,
    extra: `from=${from}`,
  };
  return pitCacheWrap(key, () => getDailyBars(ticker, from, asOfDate));
}

/** Last close at or before date — used for trade reference price. */
function lastCloseAtOrBefore(bars: Bar[], date: string): number | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    const barDate =
      typeof bars[i].t === 'number'
        ? new Date(bars[i].t as unknown as number).toISOString().slice(0, 10)
        : ((bars[i] as unknown as { date?: string }).date ?? null);
    if (barDate && barDate <= date) return bars[i].c;
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
  const runId = generateRunId();
  const warnings: string[] = [];
  const startedAt = new Date().toISOString();

  if (!options.noPersist) {
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
            );
            if (result === null && config.board !== 'prophet' && !nonProphetBoardWarned) {
              nonProphetBoardWarned = true;
              warnings.push(
                `Board "${config.board}" has no PIT scoring path in Phase 4a; ` +
                  `prophet is the only supported board. All candidates null.`,
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

      const dates = tradingDaysBetween(addDays(asOfDate, 1), nextAsOf);
      for (const date of dates) {
        let portReturn = 0;
        for (const p of target) {
          const rets = positionReturns.get(p.ticker) ?? [];
          const todayRet = rets.find((r) => r.date === date)?.ret ?? 0;
          portReturn += p.weight * todayRet;
        }
        nav = nav * (1 + portReturn);
        dailyEquity.push({ date, value: nav });
      }

      // 7. Per-position attribution + ML training rows
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

        // ML row — capture forward returns for the meta-ranker Phase 5
        const longBars = await getCachedBarsThrough(
          p.ticker,
          addDays(asOfDate, 400),
        ).catch(() => []);
        // Fundamentals at entry — currently unused for ML row beyond
        // marketCap bucketing which Phase 4a defers (FundamentalsSnapshot
        // doesn't expose marketCap; Phase 11 can add it).
        const entryClose = lastCloseAtOrBefore(longBars, asOfDate);
        mlRows.push({
          runId,
          ticker: p.ticker,
          asOfDate,
          composite: p.composite,
          layers: p.layers,
          regime: (ctx.regime?.regime as string | undefined) ?? null,
          sector: p.sector,
          marketCapBucket: null,
          entryPrice: entryClose,
          exitPrice: null,
          holdDays: null,
          forward5dReturn: forwardReturn(longBars, asOfDate, 5),
          forward20dReturn: forwardReturn(longBars, asOfDate, 20),
          forward60dReturn: forwardReturn(longBars, asOfDate, 60),
          forward252dReturn: forwardReturn(longBars, asOfDate, 252),
          realizedPnl: null,
        });
      }

      portfolio = target;
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
