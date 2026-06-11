// Shared scan orchestrator for the target board.
//
// Both the live endpoint (netlify/functions/target-board.ts) and the
// scheduled full-universe scan (netlify/functions/scan-target-board-{universe}.ts)
// route through this module. Single source of truth for scoring math:
// no duplication, no drift between live and scheduled.
//
// The live caller passes a tight budget + small caps to fit Netlify's 26s
// sync timeout. The scheduled caller passes the full universe and a 14-min
// budget to fit the 15-min background timeout with margin.

import { fetchBarCache, runAnalystsForTicker } from './analyst-runner';
import { computeRegime, regimeToMacroBias } from './regime';
import { CORE_WATCHLIST, UNIVERSE, inIndex, SPY } from './universe';
import type { Target } from './types';
import type { Bar } from './data-provider';
import { mapWithConcurrency } from './full-scan-iterator';
import type { Logger } from './logger';
import { enrichTickerNames } from './ticker-reference';

export type TargetUniverseKey =
  | 'all'
  | 'sp500'
  | 'ndx'
  | 'dow'
  | 'russell'
  | 'russell2k'
  | 'core';

export interface RunTargetScanOpts {
  universe: TargetUniverseKey;
  /** Cap on Pass-1 cheap pre-scoring. Use Infinity for full-universe scans. */
  pass1Max?: number;
  /** Cap on Pass-2 full analyst battery (the expensive pass). */
  pass2Max: number;
  /** Wall-clock budget for the entire scan; loop bails between batches once exceeded. */
  scanBudgetMs: number;
  /** Bar-fetch concurrency. Live: ~6. Scheduled: ~8. */
  barFetchConcurrency?: number;
  /** Bar-fetch pacing in ms between batches. Use to respect rate limits. */
  barFetchPacingMs?: number;
  /** Pass-2 analyst concurrency. Live used 5; scheduled can use 5–8. */
  analystConcurrency?: number;
  /** Optional logger for structured progress. */
  logger?: Logger;
}

export interface RunTargetScanResult {
  results: Target[];
  scanDurationMs: number;
  /** Total tickers in the universe (before any cap). */
  universeChecked: number;
  /** Pass-1 tickers actually scanned (= min(universe, pass1Max)). */
  pass1Scanned: number;
  /** Pass-2 survivors that ran the full battery. */
  pass2Survivors: number;
  /** Soft warnings (timeouts, partial bar fetches) without aborting the scan. */
  warnings: string[];
  /** True if the scan returned early due to scanBudgetMs. */
  budgetExceeded: boolean;
}

/**
 * Phase 4h W1 — single-batch helper for the checkpoint-resume scan
 * worker. Walks the ticker slice `[startIdx, startIdx + batchSize)`,
 * fetches bars for those names + the SPY benchmark + the sectors they
 * cover, runs the full analyst battery on each, returns the scored
 * Target rows + how many tickers it actually consumed. Stateless;
 * callers persist the cursor + accumulate rows themselves.
 */
export interface RunTargetBatchOpts {
  universe: TargetUniverseKey;
  startIdx: number;
  batchSize: number;
  /** Pre-fetched company-name map (Polygon ticker-reference cache). */
  nameMap?: Record<string, string>;
  macroBias?: number;
  analystConcurrency?: number;
  logger?: Logger;
}

export interface RunTargetBatchResult {
  results: Target[];
  tickersConsumed: number;
  warnings: string[];
}

export async function runTargetScanBatch(
  opts: RunTargetBatchOpts,
): Promise<RunTargetBatchResult> {
  const log = opts.logger;
  const allTickers = resolveTargetUniverse(opts.universe);
  const slice = allTickers.slice(opts.startIdx, opts.startIdx + opts.batchSize);
  const warnings: string[] = [];

  if (slice.length === 0) {
    return { results: [], tickersConsumed: 0, warnings };
  }

  const barCache = await fetchBarCache(slice).catch((err) => {
    warnings.push(`bar-fetch failed for batch ${opts.startIdx}: ${String(err?.message ?? err)}`);
    return {} as Awaited<ReturnType<typeof fetchBarCache>>;
  });

  const analystConcurrency = opts.analystConcurrency ?? 6;
  const macroBias = opts.macroBias ?? 0;
  const nameMap = opts.nameMap ?? {};
  const results: Target[] = [];

  await mapWithConcurrency(
    slice,
    async (t) => {
      const r = await runAnalystsForTicker({
        ticker: t,
        barCache,
        macroBias,
        companyName: nameMap[t],
      });
      if (r.target) results.push(r.target);
      return r;
    },
    {
      batchSize: analystConcurrency,
      onError: (err, ticker) => {
        log?.warn('scan_batch_ticker_error', { ticker, err: String(err) });
      },
    },
  );

  log?.debug('scan_batch_complete', {
    universe: opts.universe,
    startIdx: opts.startIdx,
    consumed: slice.length,
    scored: results.length,
  });

  return { results, tickersConsumed: slice.length, warnings };
}

export function resolveTargetUniverse(universe: TargetUniverseKey): string[] {
  if (universe === 'core') return CORE_WATCHLIST;
  if (universe === 'sp500') return inIndex('sp500').map((u) => u.ticker);
  if (universe === 'ndx') return inIndex('ndx').map((u) => u.ticker);
  if (universe === 'dow') return inIndex('dow').map((u) => u.ticker);
  if (universe === 'russell' || universe === 'russell2k')
    return inIndex('russell2k').map((u) => u.ticker);
  return UNIVERSE.map((u) => u.ticker);
}

export async function runTargetScan(opts: RunTargetScanOpts): Promise<RunTargetScanResult> {
  const log = opts.logger;
  const start = Date.now();
  const warnings: string[] = [];

  const allTickers = resolveTargetUniverse(opts.universe);
  const universeChecked = allTickers.length;

  log?.info('target_scan_started', {
    universe: opts.universe,
    universeSize: universeChecked,
    pass1Max: opts.pass1Max ?? 'Infinity',
    pass2Max: opts.pass2Max,
    budgetMs: opts.scanBudgetMs,
  });

  const regime = await computeRegime();
  const macroBias = regimeToMacroBias(regime);

  const pass1Max = opts.pass1Max ?? Infinity;
  const pass1Tickers = isFinite(pass1Max) ? allTickers.slice(0, pass1Max) : allTickers;
  const smallUniverse = allTickers.length <= 40;

  // Pass 1: bar fetch (with the cache helper that already batches internally)
  // + cheap technical pre-score. fetchBarCache handles its own concurrency,
  // so we just pass through. For very large universes (> 500), fall back to
  // chunked bar fetches via mapWithConcurrency to respect Polygon limits.
  let barCache: Awaited<ReturnType<typeof fetchBarCache>>;
  if (pass1Tickers.length <= 500) {
    barCache = await fetchBarCache(pass1Tickers);
  } else {
    barCache = {};
    const chunkSize = 250;
    for (let i = 0; i < pass1Tickers.length; i += chunkSize) {
      if (Date.now() - start > opts.scanBudgetMs) {
        warnings.push(`bar-fetch budget exceeded after ${i} tickers`);
        break;
      }
      const chunk = pass1Tickers.slice(i, i + chunkSize);
      const sub = await fetchBarCache(chunk);
      Object.assign(barCache, sub);
      log?.debug('target_scan_bar_chunk_done', { fetched: i + chunk.length, total: pass1Tickers.length });
      // pacing handled inside fetchBarCache; tiny extra breath for very large universes:
      if (opts.barFetchPacingMs) await sleep(opts.barFetchPacingMs);
    }
  }

  const spyBars = barCache[SPY] ?? [];
  const spyRet20 = ret(spyBars, 20);

  let survivors: string[];
  if (smallUniverse) {
    survivors = pass1Tickers;
  } else {
    const preScored = pass1Tickers.map((t) => {
      const bars = barCache[t];
      if (!bars || bars.length < 50) return { ticker: t, score: -1 };
      return { ticker: t, score: preScore(bars, spyRet20) };
    });
    preScored.sort((a, b) => b.score - a.score);
    // NOTE: preScore is long-only, so this `score > 0` gate means shorts
    // can never surface from large-universe scans — see the limitation
    // comment on preScore (review m5).
    survivors = preScored
      .slice(0, opts.pass2Max)
      .filter((p) => p.score > 0)
      .map((p) => p.ticker);
  }

  log?.info('target_scan_pass1_complete', {
    pass1Scanned: pass1Tickers.length,
    survivors: survivors.length,
    elapsedMs: Date.now() - start,
  });

  // Phase 4h W3 — pre-fetch Polygon-canonical company names for survivors.
  // Cache-first via Firestore; first call cold-warms the cache, all later
  // scans are ~0 Polygon calls. Skip on the live-fallback path (smallish
  // survivor sets where the in-repo name table is already complete) by
  // letting enrichTickerNames degrade gracefully when Firestore is absent.
  const nameMap = await enrichTickerNames(survivors).catch((err) => {
    log?.warn('ticker_name_enrich_failed', { err: String(err?.message ?? err) });
    return {} as Record<string, string>;
  });

  // Pass 2: full analyst battery on survivors only.
  const analystConcurrency = opts.analystConcurrency ?? 5;
  let budgetExceeded = false;
  const results: Target[] = [];

  await mapWithConcurrency(
    survivors,
    async (t) => {
      const r = await runAnalystsForTicker({
        ticker: t,
        barCache,
        macroBias,
        companyName: nameMap[t],
      });
      if (r.target) results.push(r.target);
      return r;
    },
    {
      batchSize: analystConcurrency,
      shouldAbort: () => {
        if (Date.now() - start > opts.scanBudgetMs) {
          budgetExceeded = true;
          warnings.push('pass-2 budget exceeded; results may be partial');
          return true;
        }
        return false;
      },
      onError: (err, ticker) => {
        log?.warn('target_scan_ticker_error', { ticker, err: String(err) });
      },
    },
  );

  results.sort((a, b) => b.composite - a.composite);

  const scanDurationMs = Date.now() - start;
  log?.info('target_scan_complete', {
    universe: opts.universe,
    universeChecked,
    pass1Scanned: pass1Tickers.length,
    pass2Survivors: survivors.length,
    resultCount: results.length,
    scanDurationMs,
    budgetExceeded,
    warnings: warnings.length,
  });

  return {
    results,
    scanDurationMs,
    universeChecked,
    pass1Scanned: pass1Tickers.length,
    pass2Survivors: survivors.length,
    warnings,
    budgetExceeded,
  };
}

// ---------- helpers (lifted verbatim from original target-board.ts) ----------

// KNOWN LIMITATION (code-review-2026-06 track-1, finding m5): pass-1
// pre-scoring is structurally LONG-ONLY. Every term below rewards bullish
// structure, and runTargetScan keeps only `score > 0` survivors, so even
// though composeTarget supports short candidates, a bearish name can never
// reach pass 2 on large universes. Making pass 1 two-sided is a methodology
// redesign (how do you rank "best shorts" against "best longs" on one
// scale?) deliberately deferred — see
// reports/code-review-2026-06/track-1-analyst-scoring.md.
function preScore(bars: Bar[], spyRet20: number): number {
  if (bars.length < 50) return 0;
  const closes = bars.map((b) => b.c);
  const last = closes[closes.length - 1];
  const sma20 = avg(closes.slice(-20));
  const sma50 = avg(closes.slice(-50));
  // fetchBarCache's default window is 220 CALENDAR days ≈ 150 trading bars,
  // so this is null in every production target scan; it only contributes
  // when a caller supplies a wider bar window.
  const sma200 = bars.length >= 200 ? avg(closes.slice(-200)) : null;

  let s = 50;
  if (last > sma20) s += 8;
  if (last > sma50) s += 8;
  if (sma200 !== null && last > sma200) s += 10;
  if (sma20 > sma50) s += 6;

  const myRet = ret(bars, 20);
  if (myRet > spyRet20) s += 10;
  else if (myRet > spyRet20 - 0.05) s += 3;

  // Distance from the high of the AVAILABLE window — at the production
  // 220-calendar-day fetch that's ~150 bars (≈ a 7-month high), NOT a true
  // 52-week high (the old `window52w`/`max52w` names overstated it —
  // code-review-2026-06 track-1 m5). Capped at 252 bars so a wider fetch
  // still measures at most one year.
  const windowHigh = Math.max(...closes.slice(-252));
  const fromWindowHigh = (last - windowHigh) / windowHigh;
  if (fromWindowHigh > -0.05) s += 8;
  else if (fromWindowHigh < -0.25) s -= 10;

  return Math.max(0, Math.min(100, s));
}

function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ret(bars: Bar[], n: number): number {
  if (bars.length < n + 1) return 0;
  const c0 = bars[bars.length - n - 1].c;
  const c1 = bars[bars.length - 1].c;
  return (c1 - c0) / c0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
