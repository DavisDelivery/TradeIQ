// Phase 6 PR-H — after-close scheduled Prophet snapshot scan (Large Cap).
//
// CADENCE: weekdays at 22:00 UTC — safely after the 4pm-ET close in both
// EST and EDT and after EOD data settles. The cron itself skips
// weekends; an additional US-market-holiday guard skips Thanksgiving,
// Christmas, Good Friday, etc. so we never overwrite a good snapshot
// with junk data on a closed-market day.
//
// SAFETY DISCIPLINE (brief's hard rule):
//   - NEVER overwrite a good complete snapshot with a failed/empty one.
//     `writeSnapshot` only promotes the new doc to `_latest/` when
//     `status: 'complete'`. Partial scans land in `runs/` for diagnostics
//     and leave the canonical pointer alone.
//   - NO Claude in the scan. The scan body calls only deterministic
//     scoring (the existing 7-layer Prophet path). Per-ticker thesis
//     stays on-demand via `/api/prophet-narrate`, cached per (ticker,
//     snapshotDate) in Firestore.
//
// This file is intentionally a thin scheduling shim around
// `runProphetSnapshot`. The manual-trigger HTTP endpoint
// (`scan-prophet-largecap-trigger.ts`) invokes the same shared body, so
// the schedule and the test-run produce identical behaviour.

import { schedule } from '@netlify/functions';
import { logger } from './shared/logger';
import { runProphetSnapshot } from './shared/prophet-snapshot-runner';
import { isMarketClosed } from './shared/us-market-holidays';

export const handler = schedule('0 22 * * 1-5', async () => {
  const now = new Date();
  const log = logger.child({ fn: 'scan-prophet-largecap', universe: 'largecap', triggeredAt: now.toISOString() });

  if (isMarketClosed(now)) {
    log.info('scheduled_scan_skipped_market_closed', { date: now.toISOString().slice(0, 10) });
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'prophet',
        universe: 'largecap',
        skipped: true,
        reason: 'market_closed',
        date: now.toISOString().slice(0, 10),
      }),
    };
  }

  const result = await runProphetSnapshot({
    universe: 'largecap',
    storeKey: 'largecap',
    logger: log,
  });

  return {
    statusCode: result.ok ? 200 : 500,
    body: JSON.stringify({
      ok: result.ok,
      board: 'prophet',
      universe: 'largecap',
      snapshotId: result.snapshotId,
      status: result.status,
      promotedToLatest: result.promotedToLatest,
      picks: result.picks,
      universeChecked: result.universeChecked,
      scanDurationMs: result.scanDurationMs,
      warnings: result.warnings,
      error: result.error,
    }),
  };
});
