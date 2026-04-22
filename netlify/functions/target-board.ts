// GET /api/target-board?limit=50
// Returns ranked targets across the core watchlist, fully populated.

import type { Handler } from '@netlify/functions';
import { fetchBarCache, runAnalystsForTicker } from './shared/analyst-runner';
import { computeRegime, regimeToMacroBias } from './shared/regime';
import { CORE_WATCHLIST } from './shared/universe';
import type { TargetBoardResponse, Target } from './shared/types';

export const handler: Handler = async (event) => {
  const limit = Math.min(Number(event.queryStringParameters?.limit ?? 50), 100);

  try {
    const regime = await computeRegime();
    const macroBias = regimeToMacroBias(regime);

    const tickers = CORE_WATCHLIST;
    const barCache = await fetchBarCache(tickers);

    const results = await Promise.all(
      tickers.map((t) =>
        runAnalystsForTicker({ ticker: t, barCache, macroBias })
          .then((r) => r.target)
          .catch(() => null),
      ),
    );
    const targets: Target[] = results.filter((t): t is Target => t !== null);
    targets.sort((a, b) => b.composite - a.composite);

    const response: TargetBoardResponse = {
      targets: targets.slice(0, limit),
      generatedAt: new Date().toISOString(),
      source: 'live (polygon+finnhub+fred)',
    };
    return json(200, response);
  } catch (err: any) {
    return json(500, { error: String(err?.message ?? err), targets: [], generatedAt: new Date().toISOString(), source: 'error' } as TargetBoardResponse);
  }
};

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' }, body: JSON.stringify(body) };
}
