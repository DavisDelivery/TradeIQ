// FVZ-6 — scheduled trigger for the nightly screen snapshots.
//
// Cron: `50 23 * * 1-5` (23:50 UTC weekdays). Chosen to sit AFTER every
// other daily board has published (crosses 21:10, trident 22:15, prophet
// and lynch 22:00, target-board 23:00, fable 23:30) and BEFORE the
// forward-test nightly at 00:20 UTC — so the league always reads a snapshot
// captured the same evening, never one a day behind.
//
// It also puts the run inside the US extended-hours session, which is what
// makes the after-hours leg of the PEAD screen actually populated: most S&P
// names report after the close, and Finviz only carries After-Hours Change
// during that window.
//
// Cheap by construction: 9 of the 13 screens are pure predicates over the
// cached Finviz universe, so the whole sweep costs a handful of upstream
// calls rather than one per screen.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';
import { isMarketClosed } from './shared/us-market-holidays';

const WORKER_PATH = '/.netlify/functions/scan-screens-background';
export const CRON = '50 23 * * 1-5';

export const handler = schedule(CRON, async () => {
  const log = logger.child({ fn: 'scan-screens', schedule: CRON });

  // A holiday has no close to snapshot; capturing one would enter a
  // duplicate of the prior session into every screen's forward-test record.
  if (isMarketClosed(new Date())) {
    log.info('skipped_market_closed');
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: 'market_closed' }) };
  }

  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  try {
    const res = await fetch(`${origin}${WORKER_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.text();
    log.info('worker_dispatched', { status: res.status, body: body.slice(0, 200) });
    return { statusCode: 200, body: JSON.stringify({ ok: true, board: 'screens', workerStatus: res.status }) };
  } catch (err: any) {
    log.error('worker_dispatch_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
});
