// Scheduled trigger for the FABLE sp500 scan.
//
// Cron: 23:30 UTC weekdays — after the insider 22:45 chain drains and
// clear of the 23:00 target-board chains (Finnhub-contention lesson from
// FIX-1). The worker is single-pass; this trigger just dispatches it.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';

const WORKER_PATH = '/.netlify/functions/scan-fable-sp500-background';

export const handler = schedule('30 23 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-fable-sp500', universe: 'sp500' });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  try {
    const res = await fetch(`${origin}${WORKER_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    log.info('worker_dispatched', { status: res.status });
    return { statusCode: 200, body: JSON.stringify({ ok: true, board: 'fable', workerStatus: res.status }) };
  } catch (err: any) {
    log.error('worker_dispatch_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
});
