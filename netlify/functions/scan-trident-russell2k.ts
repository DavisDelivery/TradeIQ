// TRIDENT russell2k — thin cron dispatcher (staggered 5 min after sp500).

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';
import { isMarketClosed } from './shared/us-market-holidays';

export const CRON = '20 22 * * 1-5';

export const handler = schedule(CRON, async () => {
  const log = logger.child({ fn: 'scan-trident-russell2k', schedule: CRON });
  if (isMarketClosed(new Date())) {
    log.info('skipped_market_closed', {});
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: 'market_closed' }) };
  }
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  try {
    const res = await fetch(`${origin}/.netlify/functions/scan-trident-russell2k-background`, {
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
