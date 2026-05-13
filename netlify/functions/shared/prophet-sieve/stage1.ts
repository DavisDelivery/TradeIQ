// 4c-2 Sieve Stage 1 — bars-only filter for the full Russell universe.
//
// Goal: score every ticker in ~2 minutes using only Polygon daily bars.
// No fundamentals, no Quiver, no Anthropic. This is the only stage that
// touches all 2000+ tickers, so it must stay cheap.
//
// Five signals contribute to the Stage 1 composite (each 0-100,
// equal-weighted in the default scoring):
//   1. Trend qualifier — close > sma20 AND close > sma50 AND close > sma200
//   2. Momentum 20d — percent return over last 20 trading days, percentile-ranked
//   3. Volume surge — vol[5] / vol[20] avg, percentile-ranked
//   4. Volatility regime — 20d realized vol annualized, INVERTED percentile-rank
//      (lower vol → higher score; Prophet's strategy is stable trending names)
//   5. Above-52w-low margin — (close - low52w) / low52w
//
// Survival: top N by composite, clamped to [min, max] survivors, with an
// optional minimum composite floor. The russell scanner uses these to
// hand off ~300-600 names to Stage 2.

import type { Bar } from '../data-provider';
import { getDailyBars } from '../data-provider';
import { mapWithConcurrency } from '../full-scan-iterator';
import type { Logger } from '../logger';
import type { StageMeta, Stage1Result, SieveContext } from './types';
import { SIEVE_BUDGETS } from './budgets';

interface RawSignals {
  ticker: string;
  trendQualifier: boolean;
  momentum20d: number | null;
  volumeSurge: number | null;
  realizedVol: number | null;
  above52wLowPct: number | null;
}

/** Stage 1 entrypoint. Returns sorted Stage1Results (passers first) + meta. */
export async function runStage1(
  ctx: SieveContext,
  opts: { logger?: Logger; budgetMs?: number; concurrency?: number } = {},
): Promise<{ results: Stage1Result[]; survivors: Stage1Result[]; meta: StageMeta }> {
  const start = Date.now();
  const budgetMs = opts.budgetMs ?? SIEVE_BUDGETS.stage1.budgetMs;
  const concurrency = opts.concurrency ?? SIEVE_BUDGETS.stage1.concurrency;
  const log = opts.logger;
  const warnings: string[] = [];

  let budgetExceeded = false;

  // Fetch raw bars + compute per-ticker signals.
  const entryByTicker = new Map(ctx.entries.map((e) => [e.ticker, e]));
  const tickers = ctx.entries.map((e) => e.ticker);
  const raw = await mapWithConcurrency<RawSignals | null>(
    tickers,
    async (ticker) => {
      if (Date.now() - start > budgetMs) {
        budgetExceeded = true;
        return null;
      }
      try {
        const bars = await getDailyBars(ticker, ctx.from, ctx.to);
        return computeRawSignals(ticker, bars);
      } catch (err) {
        warnings.push(`stage1_fetch:${ticker}:${(err as any)?.message ?? err}`);
        return null;
      }
    },
    { batchSize: concurrency },
  );
  void entryByTicker; // reserved for stage2 cross-reference

  const scored = raw.filter((r): r is RawSignals => r != null);
  log?.info('stage1_signals_computed', {
    fed: ctx.entries.length,
    scored: scored.length,
    skipped: ctx.entries.length - scored.length,
    elapsedMs: Date.now() - start,
  });

  // Percentile-rank each signal across the cohort. Pre-extracted arrays so
  // the per-ticker rank lookup is O(1) after one sort.
  const momArr = scored.map((s) => s.momentum20d).filter((n): n is number => Number.isFinite(n as any));
  const volSurgeArr = scored.map((s) => s.volumeSurge).filter((n): n is number => Number.isFinite(n as any));
  const realVolArr = scored.map((s) => s.realizedVol).filter((n): n is number => Number.isFinite(n as any));
  const above52Arr = scored.map((s) => s.above52wLowPct).filter((n): n is number => Number.isFinite(n as any));

  momArr.sort((a, b) => a - b);
  volSurgeArr.sort((a, b) => a - b);
  realVolArr.sort((a, b) => a - b);
  above52Arr.sort((a, b) => a - b);

  const pct = (sortedAsc: number[], v: number | null): number | null => {
    if (v === null || !Number.isFinite(v) || sortedAsc.length === 0) return null;
    // Binary-search rank
    let lo = 0;
    let hi = sortedAsc.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedAsc[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return (lo / sortedAsc.length) * 100;
  };

  // Compose Stage 1 composite per ticker.
  const results: Stage1Result[] = scored.map((s) => {
    const sigMom = pct(momArr, s.momentum20d) ?? 50;
    const sigVolSurge = pct(volSurgeArr, s.volumeSurge) ?? 50;
    const sigRealVol = pct(realVolArr, s.realizedVol);
    const sigVolatility = sigRealVol !== null ? 100 - sigRealVol : 50; // INVERT
    const sig52 = pct(above52Arr, s.above52wLowPct) ?? 50;
    const sigTrend = s.trendQualifier ? 100 : 25; // boolean → score

    const composite = Math.round(
      0.2 * sigTrend + 0.2 * sigMom + 0.2 * sigVolSurge + 0.2 * sigVolatility + 0.2 * sig52,
    );

    return {
      ticker: s.ticker,
      composite,
      passed: false, // filled in below
      signals: {
        trendQualifier: s.trendQualifier,
        momentum20d: s.momentum20d,
        volumeSurge: s.volumeSurge,
        volatilityRegime: s.realizedVol,
        above52wLowPct: s.above52wLowPct,
      },
    };
  });

  // Sort descending and apply survival rule.
  results.sort((a, b) => b.composite - a.composite);

  const cfg = SIEVE_BUDGETS.stage1.survivors;
  const minComposite = SIEVE_BUDGETS.stage1.minComposite;
  const topN = Math.round(results.length * cfg.topPct);
  const targetSurvivors = Math.min(cfg.max, Math.max(cfg.min, topN));

  let thresholdScore: number | null = null;
  if (results.length > 0) {
    const cutoffIdx = Math.min(targetSurvivors - 1, results.length - 1);
    thresholdScore = Math.max(minComposite, results[cutoffIdx].composite);
  }

  const survivors: Stage1Result[] = [];
  for (const r of results) {
    if (thresholdScore !== null && r.composite >= thresholdScore && survivors.length < cfg.max) {
      r.passed = true;
      survivors.push(r);
    } else {
      r.passed = false;
    }
  }

  const meta: StageMeta = {
    scored: scored.length,
    survived: survivors.length,
    thresholdScore,
    budgetMs: Date.now() - start,
    partial: budgetExceeded,
    warnings,
  };

  log?.info('stage1_complete', {
    scored: meta.scored,
    survived: meta.survived,
    thresholdScore: meta.thresholdScore,
    budgetMs: meta.budgetMs,
    partial: meta.partial,
    warnings: warnings.length,
  });

  return { results, survivors, meta };
}

// ---------------------------------------------------------------------------
// Raw signal computation — pure functions over bars
// ---------------------------------------------------------------------------

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

function realizedVol20d(bars: Bar[]): number | null {
  if (bars.length < 21) return null;
  const rets: number[] = [];
  for (let i = bars.length - 20; i < bars.length; i++) {
    const r = (bars[i].c - bars[i - 1].c) / bars[i - 1].c;
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

export function computeRawSignals(ticker: string, bars: Bar[]): RawSignals | null {
  if (bars.length < 200) return null; // need full sma200 window
  const closes = bars.map((b) => b.c).filter((c): c is number => Number.isFinite(c));
  if (closes.length < 200) return null;

  const last = closes[closes.length - 1];
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);

  const trendQualifier = !!(s20 && s50 && s200 && last > s20 && last > s50 && last > s200);

  const momentum20d =
    closes.length > 20 && closes[closes.length - 21] !== 0
      ? (last - closes[closes.length - 21]) / closes[closes.length - 21]
      : null;

  // Volume surge: avg vol last 5 days / avg vol last 20 days
  const vols = bars.map((b) => b.v).filter((v): v is number => Number.isFinite(v));
  let volumeSurge: number | null = null;
  if (vols.length >= 20) {
    const last5 = vols.slice(-5);
    const last20 = vols.slice(-20);
    const v5 = last5.reduce((a, b) => a + b, 0) / last5.length;
    const v20 = last20.reduce((a, b) => a + b, 0) / last20.length;
    if (v20 > 0) volumeSurge = v5 / v20;
  }

  const realizedVol = realizedVol20d(bars);

  // 52-week low margin
  let above52wLowPct: number | null = null;
  if (closes.length >= 252) {
    const window = closes.slice(-252);
    const low = Math.min(...window);
    if (low > 0) above52wLowPct = (last - low) / low;
  }

  return {
    ticker,
    trendQualifier,
    momentum20d,
    volumeSurge,
    realizedVol,
    above52wLowPct,
  };
}
