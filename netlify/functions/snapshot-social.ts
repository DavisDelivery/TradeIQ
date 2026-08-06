// SOCIAL SNAPSHOT — the job whose whole purpose is to exist early.
//
// Cron: `10 21 * * *` (21:10 UTC, EVERY day including weekends).
//
// Two deliberate departures from the other crons in this repo:
//
//   1. IT RUNS ON WEEKENDS AND HOLIDAYS. Every other job here guards on
//      isMarketClosed() because a closed market has no new prices. Retail
//      chatter does the opposite — r/wallstreetbets is at its loudest on a
//      Sunday night, and skipping those days would put a systematic hole in
//      exactly the observations that matter most.
//   2. IT IS NOT A BOARD AND PRODUCES NO RANKING. It only records.
//
// WHY IT MATTERS THAT THIS STARTS NOW: ApeWisdom serves a live snapshot with
// no per-ticker history, and Apple's rating count is lifetime cumulative. The
// LEVEL of either is nearly useless — a big app has lots of ratings, a meme
// stock has lots of mentions, and you knew both already. The signal is the
// DAILY CHANGE, and that series does not exist anywhere to be bought. It only
// exists if something writes it down every day starting today.
//
// So this job is cheap, boring, and the single highest-value thing in the
// social stack: in ninety days it is the only reason there is anything to
// measure. Nothing reads it yet. That is fine.

import { schedule } from '@netlify/functions';
import {
  fetchMentionSnapshot,
  snapshotAppRatings,
  snapshotMentions,
  type AppRatingObservation,
} from './shared/social-mentions';
import { fetchAppRating } from './shared/app-ratings';
import { consumerWatchlist } from './shared/consumer-universe';
import { getTickerName } from './shared/ticker-reference';
import { logger } from './shared/logger';

export const CRON = '10 21 * * *';

/**
 * How many consumer names to poll Apple for per run.
 *
 * Apple's Search API has no published rate limit but throttles aggressively
 * (~20/min is the commonly reported ceiling), so this is paced rather than
 * parallel. 40 names at ~1.2s apart is under a minute of wall clock and stays
 * well inside the courteous range.
 */
const APP_POLL_LIMIT = 40;
const APP_POLL_DELAY_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The watchlist definition moved to `shared/consumer-universe.ts` when the
// trend-detect pass became a second caller. Both must read the SAME list: this
// job records the mention and app-rating observations, and the detect pass
// reads them back — two drifting copies would silently lose a name's history
// on the day the lists disagreed.

export const handler = schedule(CRON, async () => {
  const log = logger.child({ fn: 'snapshot-social', schedule: CRON });
  const start = Date.now();

  try {
    const snap = await fetchMentionSnapshot('all-stocks');

    // A failed fetch is NOT written. Storing an unavailable day as an empty
    // row set would put a permanent "nobody mentioned anything" into the
    // history, and unlike a cache entry it would never expire.
    if (!snap.available) {
      log.warn('skipped_unavailable', { reason: snap.reason });
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, written: false, reason: snap.reason }),
      };
    }

    const written = await snapshotMentions(snap);

    // App-rating counts for a stable consumer watchlist. Independent of the
    // mention snapshot: a failure here must not lose the mentions we already
    // wrote, so it is caught rather than allowed to propagate.
    let appRows = 0;
    try {
      // Null means the universe feed failed — NOT that there are no consumer
      // names. Polling an empty list would write a zero-row app-rating day
      // into a history that can never be corrected.
      const watchlist = (await consumerWatchlist(APP_POLL_LIMIT)) ?? [];
      const obs: AppRatingObservation[] = [];
      for (const row of watchlist) {
        const name = await getTickerName(row.ticker).catch(() => null);
        if (!name || name === row.ticker) continue;   // no name, no useful search
        const a = await fetchAppRating(name);
        // Only HIGH-confidence matches enter the history. A LOW match would
        // pin some other company's app to this ticker permanently, and a
        // series built on a wrong app is worse than no series.
        if (a.available && a.matchConfidence === 'HIGH') {
          obs.push({ ticker: row.ticker, appId: a.appId, appName: a.appName, rating: a.rating, ratingCount: a.ratingCount });
        }
        await sleep(APP_POLL_DELAY_MS);
      }
      appRows = await snapshotAppRatings(snap.date, obs);
      log.info('app_ratings_polled', { checked: watchlist.length, matched: obs.length, stored: appRows });
    } catch (err: any) {
      log.error('app_rating_snapshot_failed', { err: String(err?.message ?? err) });
    }

    log.info('done', { date: snap.date, rows: snap.rows.length, floor: snap.floor, written, appRows, durationMs: Date.now() - start });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true, written, date: snap.date,
        tickers: snap.rows.length, floor: snap.floor,
        appRatingsStored: appRows,
        top: snap.rows.slice(0, 5).map((r) => `${r.ticker}:${r.mentions}`),
      }),
    };
  } catch (err: any) {
    log.error('failed', { err: String(err?.message ?? err), durationMs: Date.now() - start });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
});
