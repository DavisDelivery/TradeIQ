// Phase 4h W1 — scheduled trigger for the russell2k target-board scan.
//
// Cron: `0 23 * * *` (23:00 UTC = 7:00pm EDT / 6:00pm EST, both
// comfortably after the 4pm ET US market close). Replaces the
// every-30-minute weekday cron AND the 01:00 UTC nightly stopgap that
// shipped earlier in this phase — one scheduled fire per day per
// universe, matching Chad's settled decision (brief PART IX § 1, § 2).
//
// This file is intentionally thin. The actual scan lives in
// `scan-target-board-russell2k-background.ts`, which runs in a 15-min
// background container, supports checkpoint-resume via Firestore
// cursor + Context.waitUntil self-reinvoke, and is the only function
// that calls `writeSnapshot`. The trigger fires that worker with an
// empty body (fresh-start payload); the worker generates its own runId
// and chains itself until the universe is done.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';

const WORKER_PATH = '/.netlify/functions/scan-target-board-russell2k-background';

export const handler = schedule('0 23 * * *', async () => {
  const log = logger.child({
    fn: 'scan-target-board-russell2k',
    universe: 'russell2k',
    schedule: '0 23 * * *',
  });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  const url = `${origin}${WORKER_PATH}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Empty body: worker treats this as a fresh-start invocation
      // and generates its own runId for the checkpoint chain.
      body: JSON.stringify({}),
    });
    const body = await res.text();
    log.info('worker_dispatched', { status: res.status, body: body.slice(0, 200) });
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'target-board',
        universe: 'russell2k',
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
        universe: 'russell2k',
        error: String(err?.message ?? err),
      }),
    };
  }
});
