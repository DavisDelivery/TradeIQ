// Phase 6 PR-H — manual trigger for the Prophet Large Cap snapshot scan.
//
// POST /api/scan-prophet-largecap-trigger?token=<SCHEDULED_SCAN_TRIGGER_TOKEN>
//   [&forcePartial=1]            — exercise the partial-safe write path
//   [&ignoreHoliday=1]            — let the test fire on a closed-market day
//
// Why this exists: the scheduled cron runs at 22:00 UTC weekdays. We
// need a way to test-run the scan once before relying on the schedule
// (and to re-run on demand after a missed slot). The trigger calls the
// EXACT same shared body (`runProphetSnapshot`) the scheduled handler
// does, so test runs and production runs are behaviourally identical.
//
// Authentication: simple token check via the `SCHEDULED_SCAN_TRIGGER_TOKEN`
// environment variable. If unset, the endpoint refuses to run (fail-
// closed). The endpoint also refuses GET to make accidental browser
// hits a no-op.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { runProphetSnapshot } from './shared/prophet-snapshot-runner';
import { isMarketClosed } from './shared/us-market-holidays';

// Test seam — the unit test passes `runProphetSnapshot` directly so we can
// assert it was called with the expected opts without actually scanning.
export interface TriggerDeps {
  run: typeof runProphetSnapshot;
  marketClosed: typeof isMarketClosed;
}
const defaultDeps: TriggerDeps = { run: runProphetSnapshot, marketClosed: isMarketClosed };

export function makeHandler(deps: TriggerDeps = defaultDeps): Handler {
  return async (event) => {
    const log = logger.child({ fn: 'scan-prophet-largecap-trigger' });

    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: 'method_not_allowed', expected: 'POST' });
    }

    const expectedToken = process.env.SCHEDULED_SCAN_TRIGGER_TOKEN;
    if (!expectedToken) {
      log.warn('trigger_unconfigured');
      return json(503, { ok: false, error: 'trigger_unconfigured' });
    }
    const providedToken = event.queryStringParameters?.token ?? '';
    if (providedToken !== expectedToken) {
      log.warn('trigger_auth_failed');
      return json(401, { ok: false, error: 'unauthorized' });
    }

    const forcePartial = event.queryStringParameters?.forcePartial === '1';
    const ignoreHoliday = event.queryStringParameters?.ignoreHoliday === '1';

    const now = new Date();
    if (!ignoreHoliday && deps.marketClosed(now)) {
      return json(200, {
        ok: true,
        skipped: true,
        reason: 'market_closed',
        date: now.toISOString().slice(0, 10),
        hint: 'pass ?ignoreHoliday=1 to run anyway',
      });
    }

    const result = await deps.run({
      universe: 'largecap',
      storeKey: 'largecap',
      forcePartial,
      logger: log,
    });

    return json(result.ok ? 200 : 500, {
      ok: result.ok,
      board: 'prophet',
      universe: 'largecap',
      snapshotId: result.snapshotId,
      status: result.status,
      promotedToLatest: result.promotedToLatest,
      picks: result.picks,
      universeChecked: result.universeChecked,
      scanDurationMs: result.scanDurationMs,
      overallDurationMs: result.overallDurationMs,
      warnings: result.warnings,
      error: result.error,
    });
  };
}

export const handler: Handler = makeHandler();

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}
