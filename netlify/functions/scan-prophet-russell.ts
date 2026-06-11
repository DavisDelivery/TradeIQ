// Per-universe scheduled scan: prophet board, russell — THIN CRON
// DISPATCHER (Wave 2D, CR-7).
//
// The 3-stage sieve body (Stage 1 cheap bars-only filter over every
// Russell ticker → Stage 2 earnings-quality gate → Stage 3 full 7-layer
// scan on survivors) runs ~14 minutes. A scheduled Netlify function has
// synchronous limits (~26s kill ceiling), so the pre-Wave-2D shape of
// this file — sieve + narrate in-handler — was killed mid-scan before
// writeSnapshot ever ran. The scan body now lives in
// `scan-prophet-russell-background.ts` (15-min background container);
// this cron only guards holidays and dispatches, mirroring the
// insider/target cron→worker pattern.

import { schedule } from '@netlify/functions';
import { makeProphetCronHandler } from './shared/prophet-cron-dispatcher';

export const CRON = '0,30 13-21 * * 1-5';
export const WORKER_PATH = '/.netlify/functions/scan-prophet-russell-background';

export const handler = schedule(
  CRON,
  makeProphetCronHandler({
    fn: 'scan-prophet-russell',
    universe: 'russell',
    schedule: CRON,
    workerPath: WORKER_PATH,
  }),
);
