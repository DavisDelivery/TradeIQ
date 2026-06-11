// Wave 2D (CR-7) — Prophet Large Cap snapshot scan, scheduled BACKGROUND
// worker.
//
// The thin cron dispatcher (`scan-prophet-largecap.ts`, cron
// `0 22 * * 1-5`) POSTs here after its holiday guard passes. Background
// functions get the 15-minute container the ~10-min largecap scan needs;
// the old in-handler cron was killed at the ~26s synchronous ceiling
// before writeSnapshot ever ran.
//
// It calls the EXACT same shared body (`runProphetSnapshot`) the manual
// trigger worker (`scan-prophet-largecap-trigger-background.ts`) does,
// so the cron and the trigger produce identical snapshots — including
// the PR-H partial-safe write and the Wave 2D publish guard. NO Claude
// in the scan path (enforced inside the shared runner).
//
// AUTH: none, mirroring the insider/target cron→worker self-invokes
// (owner decision: no token gating on scan paths). The trigger worker
// keeps its existing token gate because the manual path forwards a
// user-supplied token; the cron path deliberately does not reuse that
// worker — its gate fails closed when SCHEDULED_SCAN_TRIGGER_TOKEN is
// unset, which would silently disable the nightly cron on a config
// change.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { runProphetSnapshot } from './shared/prophet-snapshot-runner';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const log = logger.child({ fn: 'scan-prophet-largecap-background', universe: 'largecap' });

  const result = await runProphetSnapshot({
    universe: 'largecap',
    storeKey: 'largecap',
    logger: log,
  });

  log.info('worker_complete', {
    ok: result.ok,
    snapshotId: result.snapshotId,
    status: result.status,
    promotedToLatest: result.promotedToLatest,
    picks: result.picks,
    universeChecked: result.universeChecked,
    scanDurationMs: result.scanDurationMs,
    overallDurationMs: result.overallDurationMs,
    error: result.error,
  });

  // The response body is discarded by Netlify for background functions
  // (the gateway already returned 202 to the dispatcher). The status
  // code is surfaced only in function logs.
  return { statusCode: result.ok ? 200 : 500, body: '' };
};
