// GET /api/target-board?limit=50&universe=all|sp500|ndx|dow|russell|russell2k|core
// Returns ranked targets across the requested universe.
//   core    — default, 33-ticker curated watchlist (CORE_WATCHLIST)
//   sp500   — S&P 500 constituents from universe.ts
//   ndx     — Nasdaq 100
//   dow     — Dow 30
//   russell/russell2k — Russell 2000 (from IWM holdings)
//   all     — everything deduped
//
// Two-pass scanning strategy for large universes:
//   Pass 1: fetch bars only + cheap technical pre-score (~0.1s per ticker)
//   Pass 2: run full analyst battery on the top N survivors (~3s per ticker)
// Caps heavy analyst runs at 20 regardless of universe size, preventing
// DNS overflow from firing 600+ concurrent API calls.

import type { Handler } from '@netlify/functions';
import { fetchBarCache, runAnalystsForTicker } from './shared/analyst-runner';
import { computeRegime, regimeToMacroBias } from './shared/regime';
import { CORE_WATCHLIST, UNIVERSE, inIndex, SPY } from './shared/universe';
import type { TargetBoardResponse, Target } from './shared/types';
import type { Bar } from './shared/data-provider';

const PASS1_MAX = 80;
const PASS2_MAX = 20;
const SCAN_BUDGET_MS = 24_000;

const resultCache = new Map<string, { data: any; at: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

// Test-only export: exposes the module-scoped cache so the cache-poisoning
// regression suite can assert empty results never poison the cache.
// Production code never references this — it's a pure introspection hook.
export const __testInternals = {
  resultCache,
  reset: () => resultCache.clear(),
};

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(Number(qs.limit ?? 50), 100);
  const universe = (qs.universe as 'all' | 'sp500' | 'ndx' | 'dow' | 'russell' | 'russell2k' | 'core') ?? 'core';

  const cacheKey = universe;
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return json(200, { ...cached.data, cached: true });
  }

  const scanStart = Date.now();

  try {
    const regime = await computeRegime();
    const macroBias = regimeToMacroBias(regime);

    let allTickers: string[];
    if (universe === 'core') {
      allTickers = CORE_WATCHLIST;
    } else if (universe === 'sp500') {
      allTickers = inIndex('sp500').map((u) => u.ticker);
    } else if (universe === 'ndx') {
      allTickers = inIndex('ndx').map((u) => u.ticker);
    } else if (universe === 'dow') {
      allTickers = inIndex('dow').map((u) => u.ticker);
    } else if (universe === 'russell' || universe === 'russell2k') {
      allTickers = inIndex('russell2k').map((u) => u.ticker);
    } else {
      allTickers = UNIVERSE.map((u) => u.ticker);
    }

    const totalAvailable = allTickers.length;
    const smallUniverse = allTickers.length <= 40;
    const pass1Tickers = smallUniverse ? allTickers : allTickers.slice(0, PASS1_MAX);

    const barCache = await fetchBarCache(pass1Tickers);

    let survivors: string[];
    if (smallUniverse) {
      survivors = pass1Tickers;
    } else {
      const spyBars = barCache[SPY] ?? [];
      const spyRet20 = ret(spyBars, 20);
      const preScored = pass1Tickers.map((t) => {
        const bars = barCache[t];
        if (!bars || bars.length < 50) return { ticker: t, score: -1 };
        return { ticker: t, score: preScore(bars, spyRet20) };
      });
      preScored.sort((a, b) => b.score - a.score);
      survivors = preScored.slice(0, PASS2_MAX).filter((p) => p.score > 0).map((p) => p.ticker);
    }

    const results: Target[] = [];
    // Run analysts in parallel chunks of 5 — each runAnalystsForTicker fans
    // out to ~6 analysts but they share the bar cache, so most are fast.
    // Sequential was the real bottleneck (1.5s × 20 tickers = 30s, blew our budget).
    const ANALYST_CONCURRENCY = 5;
    for (let i = 0; i < survivors.length; i += ANALYST_CONCURRENCY) {
      if (Date.now() - scanStart > SCAN_BUDGET_MS) break;
      const chunk = survivors.slice(i, i + ANALYST_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map((t) => runAnalystsForTicker({ ticker: t, barCache, macroBias }))
      );
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value.target) results.push(s.value.target);
      }
    }

    results.sort((a, b) => b.composite - a.composite);

    const response = {
      targets: results.slice(0, limit),
      generatedAt: new Date().toISOString(),
      source: 'live (polygon+finnhub+fred)',
      universe,
      tickersScanned: results.length,
      pass1Scanned: pass1Tickers.length,
      universeSize: totalAvailable,
      cached: false,
    };

    // Only cache successful scans — don't poison the cache with empty results
    // from cold-start timeouts that would lock us into 0 targets for 10 min.
    if (results.length > 0) {
      resultCache.set(cacheKey, { data: response, at: Date.now() });
    }
    return json(200, response);
  } catch (err: any) {
    if (cached) return json(200, { ...cached.data, cached: true, stale: true, warning: String(err?.message ?? err) });
    return json(500, { error: String(err?.message ?? err), targets: [], generatedAt: new Date().toISOString(), source: 'error' } as TargetBoardResponse);
  }
};

function preScore(bars: Bar[], spyRet20: number): number {
  if (bars.length < 50) return 0;
  const closes = bars.map((b) => b.c);
  const last = closes[closes.length - 1];
  const sma20 = avg(closes.slice(-20));
  const sma50 = avg(closes.slice(-50));
  const sma200 = bars.length >= 200 ? avg(closes.slice(-200)) : null;

  let s = 50;
  if (last > sma20) s += 8;
  if (last > sma50) s += 8;
  if (sma200 !== null && last > sma200) s += 10;
  if (sma20 > sma50) s += 6;

  const myRet = ret(bars, 20);
  if (myRet > spyRet20) s += 10;
  else if (myRet > spyRet20 - 0.05) s += 3;

  const window52w = closes.slice(-252);
  const max52w = Math.max(...window52w);
  const from52wHigh = (last - max52w) / max52w;
  if (from52wHigh > -0.05) s += 8;
  else if (from52wHigh < -0.25) s -= 10;

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

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600' }, body: JSON.stringify(body) };
}
