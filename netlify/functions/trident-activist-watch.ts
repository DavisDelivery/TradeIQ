// TRIDENT 13D watcher — thin cron dispatcher. Daily 03:10 UTC Tue-Sat:
// EDGAR posts the prior trading day's form index ~22:00 ET (~02:00 UTC),
// so this catches yesterday's activist filings before the US open, and
// the 3-day catch-up window inside the worker absorbs holidays/outages.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';

export const CRON = '10 3 * * 2-6';

export const handler = schedule(CRON, async () => {
  const log = logger.child({ fn: 'trident-activist-watch', schedule: CRON });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  try {
    const res = await fetch(`${origin}/.netlify/functions/trident-activist-watch-background`, {
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
