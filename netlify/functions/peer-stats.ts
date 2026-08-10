// GET /api/peer-stats?ticker=AAPL&metric=pe
//
// One metric, one peer distribution, computed on demand. This endpoint exists
// because the drawer is lazy: reading the sharded universe is a manifest plus
// every shard, which is affordable once per tap and would not be affordable
// on every profile load.

import type { Handler } from '@netlify/functions';
import { computePeerStat, canPoolMetric } from './shared/peer-pool';
import { NO_PEER_POOL } from './shared/peer-stats';
import { policyFor } from './shared/metric-direction';
import { logger } from './shared/logger';

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const ticker = (qs.ticker ?? '').toUpperCase().trim();
  const metric = (qs.metric ?? '').trim();
  const log = logger.child({ fn: 'peer-stats', ticker, metric });

  if (!ticker) return json(400, { ok: false, error: 'ticker required' });
  if (!metric) return json(400, { ok: false, error: 'metric required' });
  if (!policyFor(metric)) return json(400, { ok: false, error: `unknown metric '${metric}'` });

  // Refused by design, and it is a 200 rather than an error: "this metric has
  // no peer pool" is an ANSWER the drawer renders, not a failure.
  if (NO_PEER_POOL.has(metric) || !canPoolMetric(metric)) {
    return json(200, {
      ok: true, ticker, metric, stat: null,
      reason: 'no-pool',
      note:
        'This metric is not in the screener universe the peer statistics are computed ' +
        'from. Mixing a second source into the pool would compare figures that were ' +
        'never measured the same way.',
    });
  }

  try {
    const stat = await computePeerStat({ ticker, metricKey: metric });
    if (!stat) {
      return json(200, {
        ok: true, ticker, metric, stat: null,
        reason: 'universe-unavailable',
        note: 'The screener universe is unavailable right now, so no peer comparison was computed.',
      });
    }
    log.info('served', { poolLevel: stat.poolLevel, n: stat.n });
    return json(200, { ok: true, ticker, metric, stat });
  } catch (err: any) {
    log.error('peer_stats_failed', { err: String(err?.message ?? err) });
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // Only cache success. A 4xx/5xx cached for minutes is a transient
      // failure turned into a sticky one.
      'Cache-Control': statusCode === 200 ? 'public, max-age=300' : 'no-store',
    },
    body: JSON.stringify(body),
  };
}
