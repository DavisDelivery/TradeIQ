// Scheduled trigger for the sp500 news-sentiment scan.
//
// Cron: `20 12 * * 1-5` (12:20 UTC weekdays). This slot sits AFTER the 11:50
// morning earnings run and BEFORE the 13:00 catalyst intraday chains, so the
// ~9-min Finnhub sweep of the S&P 500 doesn't contend with the other
// Finnhub-heavy scans for the shared 60-rpm account (the same contention that
// caused the insider 429 storms — see scan-insider-sp500.ts).
//
// The worker is single-shot (no checkpoint chain): this trigger just POSTs it
// with an empty body. Re-tune the slot if the universe grows past a one-run
// budget.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';

const WORKER_PATH = '/.netlify/functions/scan-sentiment-sp500-background';

export const handler = schedule('20 12 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-sentiment-sp500', universe: 'sp500', schedule: '20 12 * * 1-5' });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  try {
    const res = await fetch(`${origin}${WORKER_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.text();
    log.info('worker_dispatched', { status: res.status, body: body.slice(0, 200) });
    return { statusCode: 200, body: JSON.stringify({ ok: true, board: 'sentiment', universe: 'sp500', workerStatus: res.status }) };
  } catch (err: any) {
    log.error('worker_dispatch_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
});
