// Scheduled trigger for the catalyst dow scan.
//
// Cron: 0,30 13-21 * * 1-5. The scan itself runs in scan-catalyst-dow-background (Netlify grants
// the 15-minute budget only to *-background workers — the previous inline
// version was killed at the synchronous ceiling before it could write a
// snapshot; dead-cron remediation, runtime audit 2026-07-15).

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';

const WORKER_PATH = '/.netlify/functions/scan-catalyst-dow-background';

export const handler = schedule('0,30 13-21 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-catalyst-dow', universe: 'dow' });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  try {
    const res = await fetch(`${origin}${WORKER_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    log.info('worker_dispatched', { status: res.status });
    return { statusCode: 200, body: JSON.stringify({ ok: true, board: 'catalyst', universe: 'dow', workerStatus: res.status }) };
  } catch (err: any) {
    log.error('worker_dispatch_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, body: JSON.stringify({ ok: false, board: 'catalyst', universe: 'dow', error: String(err?.message ?? err) }) };
  }
});
