// Scheduled trigger for the nightly forward-test run.
//
// Cron: `20 0 * * 2-6` (00:20 UTC Tue–Sat = Mon–Fri evenings ET). This sits
// AFTER the whole evening scan calendar (insider 22:45, target-board 23:00,
// earnings 23:50 UTC) so every board's snapshot is tonight's before we log
// its top-20, and Polygon's grouped-daily for the session is final.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';

const WORKER_PATH = '/.netlify/functions/forward-test-nightly-background';

export const handler = schedule('20 0 * * 2-6', async () => {
  const log = logger.child({ fn: 'forward-test-nightly', schedule: '20 0 * * 2-6' });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  try {
    const res = await fetch(`${origin}${WORKER_PATH}`, {
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
