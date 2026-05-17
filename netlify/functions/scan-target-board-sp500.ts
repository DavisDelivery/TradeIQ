// Phase 4h W1 — scheduled trigger for the sp500 target-board scan.
//
// Cron: `0 23 * * *` (23:00 UTC = 7:00pm EDT / 6:00pm EST). Same
// nightly cadence as the russell2k trigger; the two functions run in
// independent containers so they don't compete for one budget.
//
// Replaces the every-30-minute weekday cron. Sp500 (~500 names) was
// borderline under the old single-pass single-invocation design; the
// background worker's checkpoint-resume makes completion deterministic.
//
// This file is intentionally thin. See
// `scan-target-board-sp500-background.ts` for the actual scan logic.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';

const WORKER_PATH = '/.netlify/functions/scan-target-board-sp500-background';

export const handler = schedule('0 23 * * *', async () => {
  const log = logger.child({
    fn: 'scan-target-board-sp500',
    universe: 'sp500',
    schedule: '0 23 * * *',
  });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  const url = `${origin}${WORKER_PATH}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.text();
    log.info('worker_dispatched', { status: res.status, body: body.slice(0, 200) });
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'target-board',
        universe: 'sp500',
        workerStatus: res.status,
      }),
    };
  } catch (err: any) {
    log.error('worker_dispatch_failed', { err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        board: 'target-board',
        universe: 'sp500',
        error: String(err?.message ?? err),
      }),
    };
  }
});
