// GET /api/engine-test?ticker=NVDA
// Runs full analyst pipeline for one ticker, returns Target + per-analyst breakdown.

import type { Handler } from '@netlify/functions';
import { fetchBarCache, runAnalystsForTicker } from './shared/analyst-runner';
import { computeRegime, regimeToMacroBias } from './shared/regime';
import type { EngineTestResponse } from './shared/types';

export const handler: Handler = async (event) => {
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase();
  if (!ticker) return json(400, { error: 'ticker required' });
  const t0 = Date.now();

  try {
    const [regime, barCache] = await Promise.all([
      computeRegime(),
      fetchBarCache([ticker]),
    ]);
    const macroBias = regimeToMacroBias(regime);
    const { target, analysts } = await runAnalystsForTicker({ ticker, barCache, macroBias });

    if (!target) {
      return json(200, {
        ticker,
        price: 0,
        priceChangePct: 0,
        durationMs: Date.now() - t0,
        target: null,
        analysts: {},
        error: 'No bars available for ticker',
      } as EngineTestResponse);
    }

    const response: EngineTestResponse = {
      ticker,
      price: target.price,
      priceChangePct: target.priceChangePct,
      durationMs: Date.now() - t0,
      target,
      analysts,
    };
    return json(200, response);
  } catch (err: any) {
    return json(500, { error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
