// GET /api/stop-watch
//
// STOP-1 — what the scheduled watcher has observed. Returns currently-open
// stop breaches, newest first, each carrying the time it was FIRST seen.
//
// Deliberately reports its own freshness. A watcher the app cannot tell is
// dead is worse than no watcher: if the cron stops firing, this endpoint must
// say so rather than serving an empty list that reads as "all clear".

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { describeBreach, isStopWatchWindow, type StopBreachEvent } from './shared/stop-watch';
import { isMarketClosed } from './shared/us-market-holidays';
import { createLogger } from './shared/logger';

const log = createLogger('stop-watch');
const BREACH_COLLECTION = 'stopBreaches';
const META_COLLECTION = 'stopWatchMeta';
const HEARTBEAT_DOC = 'heartbeat';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

/** A run every 15 min in session; treat >45 min in-session silence as suspect. */
const STALE_AFTER_MS = 45 * 60_000;

export const handler: Handler = async () => {
  try {
    const db = getAdminDb();
    const [snap, beatSnap] = await Promise.all([
      db.collection(BREACH_COLLECTION).get(),
      db.collection(META_COLLECTION).doc(HEARTBEAT_DOC).get(),
    ]);

    const events = snap.docs
      .map((d) => d.data() as StopBreachEvent)
      .sort((a, b) => (a.firstObservedAt < b.firstObservedAt ? 1 : -1));

    // Freshness comes from the WATCHER'S heartbeat, not from the breach list.
    // Deriving it from the events would make an empty list undatable, and an
    // empty list from a dead cron reads as "all clear" — the single most
    // dangerous thing this endpoint could imply.
    const beat = beatSnap.exists ? (beatSnap.data() as Record<string, any>) : null;
    const lastObserved: string | null = beat?.lastObservedAt ?? null;
    const ageMs = lastObserved ? Date.now() - Date.parse(lastObserved) : null;

    // Only claim staleness while the watcher is supposed to be running.
    // Overnight, at weekends and on holidays, silence is correct.
    const now = new Date();
    const watching = isStopWatchWindow(now) && !isMarketClosed(now);
    const stale = watching && (ageMs == null || ageMs > STALE_AFTER_MS);

    log.info('response', { breaches: events.length, ageMs, watching, stale });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        breaches: events.map((e) => ({ ...e, summary: describeBreach(e) })),
        count: events.length,
        lastObserved,
        lastRunAt: beat?.lastRunAt ?? null,
        lastStatus: beat?.lastStatus ?? null,
        ageMs,
        watching,
        stale,
      }),
    };
  } catch (err: any) {
    log.error('failed', { error: err });
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
};
