// Per-universe scheduled scan: williams board.
//
// Board:    williams
// Universe: ndx (stored as 'ndx')
// Schedule: 0,30 13-21 * * 1-5
//
// Split from Phase 1's multi-universe scan-williams.ts so each universe gets
// its own 15-min Netlify background container instead of competing for one.

import { schedule } from '@netlify/functions';
import { runWilliamsScan, type WilliamsUniverseKey } from './shared/scan-williams';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

// 14 min — leaves 60s margin under the 15-min Netlify background timeout.
const PER_SCAN_BUDGET_MS = 14 * 60_000;

const UNIVERSE: WilliamsUniverseKey = 'ndx';
const STORE_KEY: UniverseKey = 'ndx';

export const handler = schedule('0,30 13-21 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-williams-ndx', universe: UNIVERSE });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', { board: 'williams', universe: UNIVERSE });

  try {
    const scan = await runWilliamsScan({
      universe: UNIVERSE,
      scanBudgetMs: PER_SCAN_BUDGET_MS,
      concurrency: 10,
      logger: log,
    });

    const { snapshotId } = await writeSnapshot('williams', STORE_KEY, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      universeChecked: scan.universeChecked,
      results: scan.candidates,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.williams,
      warnings: scan.warnings,
    });

    const count = scan.candidates.length;
    log.info('snapshot_written', {
      snapshotId,
      candidates: count,
      universeChecked: scan.universeChecked,
      scanDurationMs: scan.scanDurationMs,
      overallDurationMs: Date.now() - overallStart,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'williams',
        universe: UNIVERSE,
        snapshotId,
        candidates: count,
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
      body: JSON.stringify({ ok: false, board: 'williams', universe: UNIVERSE, error: msg }),
    };
  }
});
