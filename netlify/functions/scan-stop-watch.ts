// STOP-1 — scheduled stop watcher.
//
// Runs every 15 minutes through the US session. It reads open positions from
// the shared tradeLog, quotes them, and persists any observed stop breach so
// the app can show WHEN a breach was first seen rather than only whether one
// is happening at this instant.
//
// Single-shot on purpose: this reads a handful of open positions and makes one
// batched quote call (Finviz answers 500+ tickers in a single request), so it
// finishes in seconds and needs none of the checkpoint-resume machinery the
// universe scans use.

import { schedule } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { getLiveQuotes } from './shared/live-quotes';
import { isMarketClosed } from './shared/us-market-holidays';
import { logger } from './shared/logger';
import {
  selectWatchedTrades,
  foldBreaches,
  describeBreach,
  type WatchedTrade,
  type StopBreachEvent,
} from './shared/stop-watch';

const JOURNAL_COLLECTION = 'tradeLog';
const BREACH_COLLECTION = 'stopBreaches';
const META_COLLECTION = 'stopWatchMeta';
const HEARTBEAT_DOC = 'heartbeat';

// Every 15 min, 13:30-21:00 UTC (09:30-17:00 ET), weekdays. Denser than the
// board scans because a stop is a risk control, not a ranking.
export const CRON = '0,15,30,45 13-20 * * 1-5';

export async function runStopWatch(now = new Date()): Promise<{
  watched: number;
  breaching: number;
  opened: string[];
  cleared: string[];
  skipped?: string;
}> {
  const log = logger.child({ fn: 'scan-stop-watch' });
  const db = getAdminDb();
  const nowIso = now.toISOString();

  // Heartbeat. `lastObservedAt` advances ONLY when a sample actually landed,
  // which is what makes the read endpoint able to tell "nothing is breaching"
  // apart from "nobody has looked in three hours". A run that fired but could
  // not quote bumps lastRunAt and deliberately leaves lastObservedAt behind.
  const beat = (patch: Record<string, unknown>) =>
    db.collection(META_COLLECTION).doc(HEARTBEAT_DOC).set({ lastRunAt: nowIso, ...patch }, { merge: true });

  if (isMarketClosed(now)) {
    log.info('skipped_market_closed');
    await beat({ lastStatus: 'market_closed' });
    return { watched: 0, breaching: 0, opened: [], cleared: [], skipped: 'market_closed' };
  }

  const [tradeSnap, breachSnap] = await Promise.all([
    db.collection(JOURNAL_COLLECTION).get(),
    db.collection(BREACH_COLLECTION).get(),
  ]);

  const trades = tradeSnap.docs.map((d) => ({ id: d.id, ...(d.data() as object) })) as WatchedTrade[];
  const prior = breachSnap.docs.map((d) => d.data() as StopBreachEvent);
  const watched = selectWatchedTrades(trades);

  if (watched.length === 0) {
    log.info('no_watched_positions', { trades: trades.length });
    // Still reconcile: a position closed since the last run must clear.
    await Promise.all(prior.map((e) => db.collection(BREACH_COLLECTION).doc(docId(e.key)).delete()));
    // Nothing to watch is a complete, honest observation — not a gap.
    await beat({ lastObservedAt: nowIso, lastStatus: 'ok', watched: 0, breaching: 0 });
    return { watched: 0, breaching: 0, opened: [], cleared: prior.map((e) => e.key) };
  }

  const tickers = [...new Set(watched.map((t) => t.ticker.toUpperCase()))];
  let quotes: Record<string, number | null> = {};
  try {
    const live = await getLiveQuotes(tickers);
    quotes = Object.fromEntries(Object.entries(live).map(([k, v]) => [k, v?.price ?? null]));
  } catch (err: any) {
    // A quote outage is NOT a breach and NOT a clear. Leave every stored
    // event exactly as it is and try again next run.
    log.error('quotes_failed', { err: String(err?.message ?? err), tickers: tickers.length });
    await beat({ lastStatus: 'quotes_failed' });
    return { watched: watched.length, breaching: prior.length, opened: [], cleared: [], skipped: 'quotes_failed' };
  }

  const { events, opened, cleared } = foldBreaches(watched, quotes, prior, nowIso);

  await Promise.all([
    ...events.map((e) => db.collection(BREACH_COLLECTION).doc(docId(e.key)).set(e)),
    ...cleared.map((k) => db.collection(BREACH_COLLECTION).doc(docId(k)).delete()),
    beat({ lastObservedAt: nowIso, lastStatus: 'ok', watched: watched.length, breaching: events.length }),
  ]);

  for (const e of opened) log.warn('stop_breach_observed', { summary: describeBreach(e) });
  log.info('stop_watch_complete', {
    watched: watched.length,
    quoted: Object.keys(quotes).length,
    breaching: events.length,
    opened: opened.length,
    cleared: cleared.length,
  });

  return {
    watched: watched.length,
    breaching: events.length,
    opened: opened.map((e) => e.key),
    cleared,
  };
}

/** Firestore ids cannot contain '/'; the key is `${tradeId}:${stop}`. */
function docId(key: string): string {
  return key.replace(/\//g, '_');
}

export const handler = schedule(CRON, async () => {
  try {
    const res = await runStopWatch();
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...res }) };
  } catch (err: any) {
    logger.child({ fn: 'scan-stop-watch' }).error('failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
});
