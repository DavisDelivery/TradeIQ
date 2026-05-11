// Per-universe scheduled scan: prophet board.
// Prophet has 3 universes (largecap, russell, all) — one function each.
//
// Board:    prophet
// Universe: russell (stored as 'russell2k')
// Schedule: 0,30 13-21 * * 1-5
//
// Split from Phase 1's multi-universe scan-prophet.ts so each universe gets
// its own 15-min Netlify background container instead of competing for one.

import { schedule } from '@netlify/functions';
import { runProphetScan, type ProphetUniverseKey } from './shared/scan-prophet';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

// 14 min — leaves 60s margin under the 15-min Netlify background timeout.
const PER_SCAN_BUDGET_MS = 14 * 60_000;

const UNIVERSE: ProphetUniverseKey = 'russell';
const STORE_KEY: UniverseKey = 'russell2k';

export const handler = schedule('0,30 13-21 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-prophet-russell', universe: UNIVERSE });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', { board: 'prophet', universe: UNIVERSE });

  try {
    const scan = await runProphetScan({
      universe: UNIVERSE,
      scanBudgetMs: PER_SCAN_BUDGET_MS,
      concurrency: 7,
      sufficientQualified: Infinity,
      logger: log,
    });

    const { snapshotId } = await writeSnapshot('prophet', STORE_KEY, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      universeChecked: scan.universeChecked,
      results: scan.picks,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.prophet,
      warnings: scan.warnings,
    });

    const count = scan.picks.length;
    log.info('snapshot_written', {
      snapshotId,
      picks: count,
      universeChecked: scan.universeChecked,
      scanDurationMs: scan.scanDurationMs,
      overallDurationMs: Date.now() - overallStart,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'prophet',
        universe: UNIVERSE,
        snapshotId,
        picks: count,
        universeChecked: scan.universeChecked,
        scanDurationMs: scan.scanDurationMs,
        warnings: scan.warnings,
      }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('scheduled_scan_failed', { err: msg, universe: UNIVERSE });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, board: 'prophet', universe: UNIVERSE, error: msg }),
    };
  }
});
