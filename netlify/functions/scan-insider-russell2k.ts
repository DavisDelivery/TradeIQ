// Phase 4l W2 — scheduled trigger for the russell2k insider scan.
//
// Cron: `30 21 * * 1-5` (21:30 UTC, weekdays, after US close).
//
// Phase 4o W1 — kept at 21:30 (earliest slot). The four insider-scan
// crons are staggered so they no longer compete for Finnhub quota on
// the same minute: russell2k first (longest scan, most calls), then
// sp500, ndx, dow at 5-minute intervals. See the sister cron files
// for the other slots.
//
// The russell2k insider scan walks ~2,000 Finnhub insider-transaction
// calls — too many to finish in Netlify's 15-min background ceiling
// as a single pass. Phase 4l W2 adopts the same checkpoint-resume
// pattern Phase 4h shipped for `scan-target-board-russell2k`: a thin
// scheduled trigger fires a background worker that batches the
// universe, checkpoints a cursor in Firestore, and self-reinvokes via
// `Context.waitUntil` until the sweep completes.
//
// This file is intentionally thin. The actual scan lives in
// `scan-insider-russell2k-background.ts`. The trigger fires that
// worker with an empty body (fresh-start payload); the worker
// generates its own runId and chains itself until the universe is
// done.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';
import { recoverStuckRuns } from './shared/scan-resume/finalize';

const WORKER_PATH = '/.netlify/functions/scan-insider-russell2k-background';
const RUN_ID_PREFIX = 'insider-russell2k-';

export const handler = schedule('30 21 * * 1-5', async () => {
  const log = logger.child({
    fn: 'scan-insider-russell2k',
    universe: 'russell2k',
    schedule: '30 21 * * 1-5',
  });
  const origin = process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  const url = `${origin}${WORKER_PATH}`;

  // Phase 4p W3 — recover stuck runs before dispatching a fresh scan.
  // The insider scan has the same pre-W1 freeze pattern as the
  // target-board sibling. Best-effort; never blocks the fresh dispatch.
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
        board: 'insider',
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
        board: 'insider',
        universe: 'russell2k',
        error: String(err?.message ?? err),
      }),
    };
  }
});
