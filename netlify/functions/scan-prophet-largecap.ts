// Phase 6 PR-H / Wave 2D (CR-7) — after-close scheduled Prophet snapshot
// scan (Large Cap), restructured as a THIN CRON DISPATCHER.
//
// CADENCE: weekdays at 22:00 UTC — safely after the 4pm-ET close in both
// EST and EDT and after EOD data settles. The cron itself skips
// weekends; an additional US-market-holiday guard skips Thanksgiving,
// Christmas, Good Friday, etc. so we never overwrite a good snapshot
// with junk data on a closed-market day.
//
// WHY A DISPATCHER: a scheduled Netlify function runs with synchronous
// limits (~26s kill ceiling) — only `-background` functions get the
// 15-min container. The full largecap scan runs ~10 min at concurrency
// 12, so running it in-handler (the pre-Wave-2D shape of this file)
// meant the platform killed the cron mid-scan before writeSnapshot ran.
// This cron now only gates (holiday guard) and POSTs to
// `scan-prophet-largecap-background`, exactly like the insider/target
// cron→worker pairs (`scan-insider-russell2k.ts`,
// `scan-target-board-sp500.ts`).
//
// The worker calls the same shared `runProphetSnapshot` body the manual
// trigger path (`scan-prophet-largecap-trigger*.ts`) uses, so the cron,
// the trigger, and both workers produce identical snapshots — including
// the PR-H safety discipline (partial-safe write, NO Claude in the scan).

import { schedule } from '@netlify/functions';
import { makeProphetCronHandler } from './shared/prophet-cron-dispatcher';

export const CRON = '0 22 * * 1-5';
export const WORKER_PATH = '/.netlify/functions/scan-prophet-largecap-background';

export const handler = schedule(
  CRON,
  makeProphetCronHandler({
    fn: 'scan-prophet-largecap',
    universe: 'largecap',
    schedule: CRON,
    workerPath: WORKER_PATH,
  }),
);
