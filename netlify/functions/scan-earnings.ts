// Scheduled trigger for the earnings board scan.
//
// FIX-1 W1 — ported to the checkpoint-resume pattern (#95/#96/#97):
// this file is now a THIN TRIGGER that recovers stuck runs and fires the
// background worker (`scan-earnings-background.ts`). The old in-handler
// monolith ran the whole calendar+bars+history sweep inside a scheduled
// function and — worse — published its snapshot UNCONDITIONALLY. The
// production failure (diagnosed 2026-07-08 from snapshot history) was:
//   1. The Finnhub calendar-range call intermittently failed and was
//      swallowed into `[]` → the scan "completed" in ~200ms with
//      universeChecked=0.
//   2. writeSnapshot then advanced `_latest` to the hollow snapshot —
//      several times clobbering a GOOD snapshot written seconds earlier
//      by a duplicate invocation (e.g. 2026-07-07 11:31:58 good/786
//      rows vs 11:32:01 empty).
// The worker closes both: publish-guarded terminal write + failed
// calendar resolution never publishes.
//
// Schedule (was `30 11,21 * * 1-5`):
//   - 11:50 UTC ≈ 06:50 ET pre-market (BMO prints + morning calendar
//     adds). Kept in the morning, moved off the :30 slot.
//   - 23:50 UTC ≈ 18:50/19:50 ET — moved OUT of the 21:30–22:45 UTC
//     Finnhub-contention window (insider russell2k 21:30 chain, insider
//     ndx/dow 21:40/21:45, lynch ×4 at 22:00, insider sp500 22:45, and
//     the 23:00 target-board chains). The earnings scan is
//     Finnhub-heavy (calendar + per-ticker earnings history) and the
//     evening 21:30 slot collided head-on with the insider russell2k
//     chain — one cause of the empty-calendar runs.
//
// Strategy unchanged: scan at the WIDEST window (30 days ahead + 5 days
// back); one 'all' snapshot covers all 4 read-time window variants.
// NO Claude/Anthropic in the scan path.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';
import { recoverStuckRuns } from './shared/scan-resume/finalize';

const WORKER_PATH = '/.netlify/functions/scan-earnings-background';
const RUN_ID_PREFIX = 'earnings-all-';

export const handler = schedule('50 11,23 * * 1-5', async () => {
  const log = logger.child({
    fn: 'scan-earnings',
    universe: 'all',
    schedule: '50 11,23 * * 1-5',
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
        board: 'earnings',
        universe: 'all',
        workerStatus: res.status,
      }),
    };
  } catch (err: any) {
    log.error('worker_dispatch_failed', { err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        board: 'earnings',
        universe: 'all',
        error: String(err?.message ?? err),
      }),
    };
  }
});
