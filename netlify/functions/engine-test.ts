// GET /api/engine-test?ticker=NVDA
// Runs full analyst pipeline for one ticker, returns Target + per-analyst breakdown.

import type { Handler } from '@netlify/functions';
import { fetchBarCache, runAnalystsForTicker } from './shared/analyst-runner';
import { computeRegime, regimeToMacroBias } from './shared/regime';
import type { EngineTestResponse } from './shared/types';
import { createLogger } from './shared/logger';

const log = createLogger('engine-test');

export const handler: Handler = async (event) => {
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase();
  log.info('request', { ticker });
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
      log.warn('no_bars', { ticker, durationMs: Date.now() - t0 });
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
    log.info('response', { status: 200, ticker, composite: target.composite, durationMs: Date.now() - t0 });
    return json(200, response);
  } catch (err: any) {
    log.error('failed', { ticker, error: err, durationMs: Date.now() - t0 });
    return json(500, { error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
