// Per-universe scheduled scan: prophet board, all — THIN CRON DISPATCHER
// (Wave 2D, CR-7).
//
// Prophet has 3 universes (largecap, russell, all) — one cron each.
// The 'all' scan walks ~2,200 tickers on a 14-min budget plus a 2-min
// narrate step. A scheduled Netlify function has synchronous limits
// (~26s kill ceiling), so the pre-Wave-2D shape of this file — scan +
// narrate in-handler — was killed mid-scan before writeSnapshot ever
// ran. The scan body now lives in `scan-prophet-all-background.ts`
// (15-min background container); this cron only guards holidays and
// dispatches, mirroring the insider/target cron→worker pattern.

import { schedule } from '@netlify/functions';
import { makeProphetCronHandler } from './shared/prophet-cron-dispatcher';

export const CRON = '0,30 13-21 * * 1-5';
export const WORKER_PATH = '/.netlify/functions/scan-prophet-all-background';

export const handler = schedule(
  CRON,
  makeProphetCronHandler({
    fn: 'scan-prophet-all',
    universe: 'all',
    schedule: CRON,
    workerPath: WORKER_PATH,
  }),
);
