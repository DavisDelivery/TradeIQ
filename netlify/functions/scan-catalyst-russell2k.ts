// Scheduled trigger for the russell2k catalyst scan.
//
// Cron: `0,30 13-21 * * 1-5` (every 30 min during market hours, weekdays).
// Kept at the original russell2k slot.
//
// Previously this file ran the scan inline via `runCatalystScan`. Catalyst
// is the heaviest board (4 providers/ticker); russell2k (~1928 names ×
// 4 providers) blew well past Netlify's 15-min background ceiling and wrote
// no snapshot from 2026-06-07 onward. It now adopts the same checkpoint-
// resume pattern as the russell2k insider/target scans: a thin scheduled
// trigger fires a background worker that batches the universe, checkpoints a
// cursor in Firestore, and self-reinvokes via `Context.waitUntil` until the
// sweep completes.
//
// The actual scan lives in `scan-catalyst-russell2k-background.ts`. The
// trigger fires that worker with an empty body (fresh-start payload); the
// worker generates its own runId and chains itself until the universe is done.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';
import { recoverStuckRuns } from './shared/scan-resume/finalize';

const WORKER_PATH = '/.netlify/functions/scan-catalyst-russell2k-background';
const RUN_ID_PREFIX = 'catalyst-russell2k-';

export const handler = schedule('0,30 13-21 * * 1-5', async () => {
  const log = logger.child({
    fn: 'scan-catalyst-russell2k',
    universe: 'russell2k',
    schedule: '0,30 13-21 * * 1-5',
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
      body: JSON.stringify({}),
    });
    const body = await res.text();
    log.info('worker_dispatched', { status: res.status, body: body.slice(0, 200) });
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'catalyst',
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
        board: 'catalyst',
        universe: 'russell2k',
        error: String(err?.message ?? err),
      }),
    };
  }
});
