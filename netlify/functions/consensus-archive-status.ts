// GET /api/consensus-archive-status
//
// The archive is write-only and its payoff is a year away, which makes it
// exactly the kind of job that dies quietly and is discovered missing when
// somebody finally goes to use it. This endpoint is the check: how many days
// are recorded, what span they cover, and whether the clock is still ticking.

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { CONSENSUS_COLLECTION, archiveReadiness } from './shared/consensus-archive';
import { etTradingDate } from './shared/forward-test';
import { isMarketClosed } from './shared/us-market-holidays';
import { logger } from './shared/logger';

export const handler: Handler = async () => {
  const log = logger.child({ fn: 'consensus-archive-status' });
  try {
    // Doc ids ARE the dates, so select() fetches ids without the payloads —
    // reading ~250 full cross-sections to count them would be absurd.
    const snap = await getAdminDb().collection(CONSENSUS_COLLECTION).select().get();
    const dates = snap.docs.map((d) => d.id).filter((id) => /^\d{4}-\d{2}-\d{2}$/.test(id));
    const readiness = archiveReadiness(dates);

    // "Stalled" means a trading day passed with nothing written. Weekends and
    // holidays are not gaps, so today only counts once the market has opened.
    const today = etTradingDate();
    const marketOpenToday = !isMarketClosed(new Date());
    const lastIsRecent = readiness.last !== null &&
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${readiness.last}T00:00:00Z`)) / 86_400_000 <= 4;

    return json(200, {
      ok: true,
      days: dates.length,
      first: readiness.first,
      last: readiness.last,
      spanDays: readiness.spanDays,
      // A revision study needs ~12 months of daily cross-sections.
      readyForRevisionStudy: readiness.ready,
      daysRemaining: Math.max(0, 365 - readiness.spanDays),
      stalled: dates.length > 0 && marketOpenToday && !lastIsRecent,
      note:
        'Write-only, point-in-time consensus archive. No screen ships off this ' +
        'until the span reaches ~12 months; a vendor backfill would embed ' +
        'revisions that were not knowable at the time.',
    });
  } catch (err: any) {
    log.error('consensus_archive_status_failed', { err: String(err?.message ?? err) });
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    body: JSON.stringify(body),
  };
}
