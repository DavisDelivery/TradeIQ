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
import { fetchMentionSnapshot, snapshotMentions } from './shared/social-mentions';
import { logger } from './shared/logger';

export const CRON = '10 21 * * *';

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
    log.info('done', { date: snap.date, rows: snap.rows.length, floor: snap.floor, written, durationMs: Date.now() - start });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true, written, date: snap.date,
        tickers: snap.rows.length, floor: snap.floor,
        top: snap.rows.slice(0, 5).map((r) => `${r.ticker}:${r.mentions}`),
      }),
    };
  } catch (err: any) {
    log.error('failed', { err: String(err?.message ?? err), durationMs: Date.now() - start });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
});
