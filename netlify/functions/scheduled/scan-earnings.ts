// Scheduled scan: earnings board, twice daily.
//
// Schedule:
//   - 11:30 UTC ≈ 06:30 ET pre-market (catches new BMO prints from earlier
//     and morning-of additions to the calendar).
//   - 21:30 UTC ≈ 16:30 ET after close (catches AMC reports and tomorrow
//     morning's calendar updates).
//
// Strategy: scan at the WIDEST window (30 days ahead + 5 days back). Snapshot
// stores the full unfiltered setup list; the live endpoint filters down to
// the user's requested window (3/7/14/30) and quality threshold at read time.
// One snapshot covers all 4 window variants without 4× the API cost.
//
// Universe is calendar-driven, not index-driven: earnings calendar is pulled
// across the whole UNIVERSE constant, so this single snapshot covers every
// tracked ticker that has earnings in the window.
//
// IMPORTANT: this scan does NOT call Claude/Anthropic. Rule-based scoring only.

import type { Handler } from '@netlify/functions';
import {
  runEarningsScan,
  EARNINGS_SCHEDULED_WINDOW_DAYS,
  POST_PRINT_LOOKBACK_DAYS,
} from '../shared/scan-earnings';
import { writeSnapshot, FRESHNESS_BUDGETS_MS } from '../shared/snapshot-store';
import { MODEL_VERSION } from '../shared/model-version';
import { logger } from '../shared/logger';

const PER_SCAN_BUDGET_MS = 14 * 60_000;

export const handler: Handler = async () => {
  const log = logger.child({ fn: 'scan-earnings' });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', {
    board: 'earnings',
    windowDays: EARNINGS_SCHEDULED_WINDOW_DAYS,
    postPrintLookbackDays: POST_PRINT_LOOKBACK_DAYS,
  });

  try {
    const scan = await runEarningsScan({
      windowDays: EARNINGS_SCHEDULED_WINDOW_DAYS,
      postPrintLookbackDays: POST_PRINT_LOOKBACK_DAYS,
      scanBudgetMs: PER_SCAN_BUDGET_MS,
      concurrency: 10,
      logger: log,
    });

    // Earnings universe is calendar-driven; we use 'all' as the storeKey since
    // the scan covers the union of UNIVERSE + calendar regardless of index.
    const { snapshotId } = await writeSnapshot('earnings', 'all', {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      universeChecked: scan.universeChecked,
      results: scan.setups,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.earnings,
      warnings: scan.warnings,
    });

    log.info('snapshot_written', {
      snapshotId,
      setupsFound: scan.setups.length,
      universeChecked: scan.universeChecked,
      scanDurationMs: scan.scanDurationMs,
      budgetExceeded: scan.budgetExceeded,
      overallDurationMs: Date.now() - overallStart,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'earnings',
        snapshotId,
        setupsFound: scan.setups.length,
        universeChecked: scan.universeChecked,
        scanDurationMs: scan.scanDurationMs,
        budgetExceeded: scan.budgetExceeded,
        warnings: scan.warnings,
      }),
    };
  } catch (err: any) {
    log.error('scheduled_scan_failed', { err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, board: 'earnings', error: String(err?.message ?? err) }),
    };
  }
};
