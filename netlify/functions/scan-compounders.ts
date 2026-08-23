// COMP-1 — Compounders: thin cron dispatcher (holiday guard → worker POST).
//
// 21:55 UTC weekdays. THE CRON LIVES HERE, IN THE schedule() WRAPPER —
// Netlify registers scheduled functions from that call at deploy time, so a
// cron declared anywhere else is a cron that never fires.
//
// Why this slot: after the 21:00 close and before the 00:20 league capture
// (a slot at or after 00:20 is captured a day late, every day, forever), and
// in a gap the evening calendar actually leaves free — crosses 21:10,
// insider russell2k 21:30, insider ndx 21:40, insider dow 21:45,
// institutional-flow/prophet/lynch 22:00, trident 22:15/22:20,
// quiet-strength 22:40, insider sp500 22:54, target-board 23:00, fable 23:30,
// earnings/screens 23:50.
//
// This was 21:40 and that was WRONG — an exact collision with
// scan-insider-ndx, which fires the same minute on the same days. The survey
// that picked it read DAILY_CLOSE_SLOTS, which registers the insider family at
// its earliest slot (21:30) as a conservative bound, so the 21:40 and 21:45
// triggers were invisible there. 21:55 is clear of the whole insider run and
// still leaves this scan's 13-minute budget finishing before 22:15.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';
import { isMarketClosed } from './shared/us-market-holidays';

export const CRON = '55 21 * * 1-5';

export const handler = schedule(CRON, async () => {
  const log = logger.child({ fn: 'scan-compounders', schedule: CRON });
  // Without this a holiday re-publishes the prior session's names under a
  // fresh generatedAt, and the forward league enters a duplicate cohort into
  // a record that is never edited afterwards.
  if (isMarketClosed(new Date())) {
    log.info('skipped_market_closed', {});
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: 'market_closed' }) };
  }
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  try {
    const res = await fetch(`${origin}/.netlify/functions/scan-compounders-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    log.info('worker_dispatched', { status: res.status });
    return { statusCode: 200, body: JSON.stringify({ ok: true, workerStatus: res.status }) };
  } catch (err: any) {
    log.error('worker_dispatch_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
});
