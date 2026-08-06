// GET /api/sector-performance
//
// SECTOR-1 — the cross-sector strength table: every sector's return over
// 1m/3m/6m/12m, its excess over SPY, and its rank among peers.
//
// One endpoint serves every ticker profile. Sector performance does not vary
// by which stock you are looking at, so computing it per profile-open would
// be twelve redundant bar fetches per page view; this is computed once and
// cached for an hour.
//
// Deliberately carries no score and no recommendation — see the header of
// shared/sector-performance.ts for why.

import type { Handler } from '@netlify/functions';
import { getSectorPerformance } from './shared/sector-performance';
import { createLogger } from './shared/logger';

const log = createLogger('sector-performance');
const headers = {
  'Content-Type': 'application/json',
  // An hour matches the in-process TTL; sector aggregates are daily-ish data.
  'Cache-Control': 'public, max-age=900, stale-while-revalidate=3600',
};

export const handler: Handler = async () => {
  try {
    const result = await getSectorPerformance();
    log.info('response', {
      sectors: result.sectors.length,
      unavailable: result.unavailable.length,
      asOf: result.asOf,
    });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (err: any) {
    log.error('failed', { error: err });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
    };
  }
};
