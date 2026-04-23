// GET /api/target-board?limit=50&universe=all|sp500|ndx|dow|russell|core
// Returns ranked targets across the requested universe.
//   core    — default, 33-ticker curated watchlist (CORE_WATCHLIST)
//   sp500   — S&P 500 constituents from universe.ts
//   ndx     — Nasdaq 100
//   dow     — Dow 30
//   russell — Russell 2000 (from IWM holdings)
//   all     — everything deduped

import type { Handler } from '@netlify/functions';
import { fetchBarCache, runAnalystsForTicker } from './shared/analyst-runner';
import { computeRegime, regimeToMacroBias } from './shared/regime';
import { CORE_WATCHLIST, UNIVERSE, inIndex } from './shared/universe';
import type { TargetBoardResponse, Target } from './shared/types';

// Hard cap to keep within function timeout — target board runs the full analyst
// battery per ticker, which is ~3s cold per ticker. Scanning 2,000 Russell tickers
// is not feasible inside a single 26s function. We sample by market-cap proxy
// (UNIVERSE order is roughly descending by relevance / listing date) up to this cap.
const MAX_SCAN = 60;
const SCAN_BUDGET_MS = 22_000;

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(Number(qs.limit ?? 50), 100);
  const universe = (qs.universe as 'all' | 'sp500' | 'ndx' | 'dow' | 'russell' | 'russell2k' | 'core') ?? 'core';

  try {
    const regime = await computeRegime();
    const macroBias = regimeToMacroBias(regime);

    // Resolve ticker list for requested universe
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
      // all: dedup entire UNIVERSE
      allTickers = UNIVERSE.map((u) => u.ticker);
    }

    const tickers = allTickers.slice(0, MAX_SCAN);
    const totalAvailable = allTickers.length;

    const barCache = await fetchBarCache(tickers);

    // Time-budget aware: if the bar fetch alone already took too long,
    // return what we have.
    const start = Date.now();
    const results: (Target | null)[] = [];
    for (let i = 0; i < tickers.length; i++) {
      if (Date.now() - start > SCAN_BUDGET_MS) break;
      const t = tickers[i];
      try {
        const r = await runAnalystsForTicker({ ticker: t, barCache, macroBias });
        results.push(r.target);
      } catch {
        results.push(null);
      }
    }
    const targets: Target[] = results.filter((t): t is Target => t !== null);
    targets.sort((a, b) => b.composite - a.composite);

    const response: TargetBoardResponse & { universe?: string; tickersScanned?: number; universeSize?: number } = {
      targets: targets.slice(0, limit),
      generatedAt: new Date().toISOString(),
      source: 'live (polygon+finnhub+fred)',
      universe,
      tickersScanned: results.length,
      universeSize: totalAvailable,
    };
    return json(200, response);
  } catch (err: any) {
    return json(500, { error: String(err?.message ?? err), targets: [], generatedAt: new Date().toISOString(), source: 'error' } as TargetBoardResponse);
  }
};

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600' }, body: JSON.stringify(body) };
}
