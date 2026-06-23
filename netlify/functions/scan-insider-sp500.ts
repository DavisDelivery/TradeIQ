// Scheduled trigger for the sp500 insider scan.
//
// Cron: `35 21 * * 1-5` (21:35 UTC, weekdays, after US close). Kept at the
// original sp500 slot — staggered from russell2k (21:30), ndx (21:40) and
// dow (21:45) so the insider crons don't share a Finnhub-quota minute.
//
// Previously this file ran the scan inline via `runInsiderScan`. After PR
// #66 expanded sp500 208→503, the single-pass scan exceeded Netlify's
// 15-min background ceiling and wrote no snapshot from 2026-06-03 onward.
// It now adopts the same checkpoint-resume pattern as the russell2k
// sibling: a thin scheduled trigger fires a background worker that batches
// the universe, checkpoints a cursor in Firestore, and self-reinvokes via
// `Context.waitUntil` until the sweep completes.
//
// The actual scan lives in `scan-insider-sp500-background.ts`. The trigger
// fires that worker with an empty body (fresh-start payload); the worker
// generates its own runId and chains itself until the universe is done.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';
import { recoverStuckRuns } from './shared/scan-resume/finalize';

const WORKER_PATH = '/.netlify/functions/scan-insider-sp500-background';
const RUN_ID_PREFIX = 'insider-sp500-';

export const handler = schedule('35 21 * * 1-5', async () => {
  const log = logger.child({
    fn: 'scan-insider-sp500',
    universe: 'sp500',
    schedule: '35 21 * * 1-5',
  });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  const url = `${origin}${WORKER_PATH}`;

  // Recover stuck runs before dispatching a fresh scan. Best-effort; never
  // blocks the fresh dispatch.
  try {
    const report = await recoverStuckRuns({
      db: getAdminDb(),
      runIdPrefix: RUN_ID_PREFIX,
    });
    if (report.recovered.length > 0) {
      log.warn('stuck_runs_recovered', {
        inspected: report.inspected,
        recovered: report.recovered,
      });
    } else {
      log.info('stuck_run_sweep_clean', { inspected: report.inspected });
    }
  } catch (err: any) {
    log.error('stuck_run_recovery_failed', { err: String(err?.message ?? err) });
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Empty body: worker treats this as a fresh-start invocation and
      // generates its own runId for the checkpoint chain.
      body: JSON.stringify({}),
    });
    const body = await res.text();
    log.info('worker_dispatched', { status: res.status, body: body.slice(0, 200) });
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'insider',
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
        board: 'insider',
        universe: 'sp500',
        error: String(err?.message ?? err),
      }),
    };
  }
});
