// P1-S3 — consensus archive: thin cron dispatcher.
//
// 21:50 UTC weekdays, after the US close and before the evening scan
// calendar gets busy. Deliberately EARLY relative to the other jobs: this
// one only has to happen, and the cheapest way to guarantee that is to not
// queue it behind ~160-call scans that can exhaust a budget.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';
import { isMarketClosed } from './shared/us-market-holidays';

export const CRON = '50 21 * * 1-5';

export const handler = schedule(CRON, async () => {
  const log = logger.child({ fn: 'archive-consensus', schedule: CRON });
  // A holiday would archive Friday's consensus stamped with Monday's date —
  // a phantom observation in a record that is written once and never edited.
  if (isMarketClosed(new Date())) {
    log.info('skipped_market_closed', {});
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: 'market_closed' }) };
  }
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  try {
    const res = await fetch(`${origin}/.netlify/functions/archive-consensus-background`, {
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
