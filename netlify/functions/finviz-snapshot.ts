// GET /api/finviz-snapshot?universe=sp500|russell2k|ndx|dji[&full=1]
//
// FVZ-1 — read surface for the Finviz Elite universe snapshot layer
// (shared/finviz.ts). Default response is a verification summary (count,
// freshness, source, 5-row sample); ?full=1 returns every row for
// future UI/board consumers. Returns 503 with enabled:false when
// FINVIZ_AUTH_TOKEN is not configured, 502 when Finviz itself failed —
// callers must treat both as "no data", never as an empty universe.

import type { Handler } from '@netlify/functions';
import {
  finvizEnabled,
  getFinvizUniverseSnapshot,
  FINVIZ_UNIVERSE_FILTERS,
  type FinvizUniverse,
} from './shared/finviz';
import { createLogger } from './shared/logger';

const log = createLogger('finviz-snapshot');
const headers = { 'Content-Type': 'application/json' };

export const handler: Handler = async (event) => {
  const start = Date.now();
  const universeRaw = event.queryStringParameters?.universe ?? 'sp500';
  const full = event.queryStringParameters?.full === '1';

  if (!(universeRaw in FINVIZ_UNIVERSE_FILTERS)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: `unknown universe '${universeRaw}'`,
        universes: Object.keys(FINVIZ_UNIVERSE_FILTERS),
      }),
    };
  }
  const universe = universeRaw as FinvizUniverse;

  if (!finvizEnabled()) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ enabled: false, error: 'FINVIZ_AUTH_TOKEN not configured' }),
    };
  }

  try {
    const snap = await getFinvizUniverseSnapshot(universe);
    if (!snap) {
      log.error('finviz fetch failed', { universe, durationMs: Date.now() - start });
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ enabled: true, universe, error: 'finviz fetch failed' }),
      };
    }
    const ageMs = Date.now() - Date.parse(snap.fetchedAt);
    log.info('response', {
      universe,
      count: snap.rows.length,
      source: snap.source,
      ageMs,
      durationMs: Date.now() - start,
    });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        enabled: true,
        universe,
        count: snap.rows.length,
        source: snap.source,
        fetchedAt: snap.fetchedAt,
        ageMs,
        missingHeaders: snap.missingHeaders,
        ...(full ? { rows: snap.rows } : { sample: snap.rows.slice(0, 5) }),
      }),
    };
  } catch (err: any) {
    log.error('failed', { error: err, durationMs: Date.now() - start });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err?.message ?? err) }),
    };
  }
};
