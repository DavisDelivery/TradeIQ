// Scheduled trigger for the sp500 insider scan.
//
// Cron: `45 22 * * 1-5` (22:45 UTC, weekdays, after US close).
//
// FIX-1 W1 -- moved from `35 21` (21:35 UTC). The 21:35 slot put this
// 503-ticker Finnhub chain INSIDE the russell2k insider chain's window
// (21:30 -> ~22:06): two containers each pacing their own 55-rpm token
// bucket against Finnhub's single 60-rpm account limit = ~110 rpm
// demand -> sustained 429 storms on BOTH chains -> failure rate over
// the 50% publish-guard skip threshold -> both runs ended
// `status: 'error'` (guard skip) every night from 2026-06-23 (the
// night this port, #95, first contended) with no snapshot published.
// 22:45 sits after the lynch 22:00 chains (also Finnhub-heavy) drain
// and clears the 23:00 target-board chains with ~10 min of margin.
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

export const handler = schedule('45 22 * * 1-5', async () => {
  const log = logger.child({
    fn: 'scan-insider-sp500',
    universe: 'sp500',
    schedule: '45 22 * * 1-5',
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
