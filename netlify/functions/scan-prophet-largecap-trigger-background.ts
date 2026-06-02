// Phase 6 PR-H — Prophet Large Cap snapshot scan, BACKGROUND worker.
//
// This is the muscle behind the manual trigger. The synchronous trigger
// (`scan-prophet-largecap-trigger.ts`) does all the gating — POST-only,
// token auth, holiday guard — then POSTs here to do the actual scan.
//
// WHY A BACKGROUND FUNCTION: a complete largecap scan walks ~208 tickers
// through the 7-layer ensemble and runs for minutes (~5–6 min observed).
// A synchronous Netlify function is capped at ~26s, so the old
// synchronous trigger could only ever 504 before `writeSnapshot` ran —
// it could never produce a `complete` snapshot on demand. Background
// functions get the 15-minute container budget the scheduled cron
// already uses, so the manual path now matches the cron's behaviour.
//
// It calls the EXACT same shared body (`runProphetSnapshot`) the
// scheduled handler (`scan-prophet-largecap.ts`) does, so the cron, the
// trigger, and this worker all produce identical snapshots.
//
// AUTH (defense-in-depth): Netlify exposes every function at its own
// `/.netlify/functions/<name>` URL, so this background worker is publicly
// POST-able even though only the sync trigger is meant to call it. We
// re-check `SCHEDULED_SCAN_TRIGGER_TOKEN` here (passed by the trigger via
// the `x-trigger-token` header) and fail closed if it's absent/wrong.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { runProphetSnapshot } from './shared/prophet-snapshot-runner';

// Test seam — the unit test passes `runProphetSnapshot` directly so we can
// assert it was called with the expected opts without actually scanning.
export interface WorkerDeps {
  run: typeof runProphetSnapshot;
}
const defaultDeps: WorkerDeps = { run: runProphetSnapshot };

export function makeWorker(deps: WorkerDeps = defaultDeps): Handler {
  return async (event) => {
    const log = logger.child({ fn: 'scan-prophet-largecap-trigger-background' });

    const expectedToken = process.env.SCHEDULED_SCAN_TRIGGER_TOKEN;
    if (!expectedToken) {
      log.warn('worker_unconfigured');
      return { statusCode: 503, body: '' };
    }
    const headers = event.headers ?? {};
    const provided =
      headers['x-trigger-token'] ??
      headers['X-Trigger-Token'] ??
      event.queryStringParameters?.token ??
      '';
    if (provided !== expectedToken) {
      log.warn('worker_auth_failed');
      return { statusCode: 401, body: '' };
    }

    const forcePartial = event.queryStringParameters?.forcePartial === '1';

    const result = await deps.run({
      universe: 'largecap',
      storeKey: 'largecap',
      forcePartial,
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
}

export const handler: Handler = makeWorker();
