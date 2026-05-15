// Per-universe scheduled scan: target board (nightly companion).
//
// STOPGAP for Phase 4h. Pairs with scan-target-board-russell2k.ts
// (daytime weekday schedule) to also fire one evening scan attempt.
// Cannot complete russell2k in 15 min today (~2000 names × ~1-2s scoring
// each = 33-67 min compute); partial scores still write to Firestore and
// the daytime scans tomorrow continue catching up.
//
// Phase 4h proper fix: apply Phase 4e-1-infra's checkpoint-and-resume
// pattern (cursor + watchdog + Context.waitUntil self-reinvoke) so this
// scan can chain across the 15-min ceiling. Until then, this nightly
// attempt at least keeps a recurring evening signal alive.
//
// Board:    target-board
// Universe: russell2k
// Schedule: 0 1 * * *      (daily at 01:00 UTC = 21:00 EDT = 20:00 EST)
//
// All other behavior is identical to scan-target-board-russell2k.ts;
// shares runTargetScan + writeSnapshot.

import { schedule } from '@netlify/functions';
import { runTargetScan, type TargetUniverseKey } from './shared/scan-target';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

// 14 min — leaves 60s margin under the 15-min Netlify background timeout.
const PER_SCAN_BUDGET_MS = 14 * 60_000;

const UNIVERSE: TargetUniverseKey = 'russell2k';
const STORE_KEY: UniverseKey = 'russell2k';

export const handler = schedule('0 1 * * *', async () => {
  const log = logger.child({
    fn: 'scan-target-board-russell2k-nightly',
    universe: UNIVERSE,
    schedule: 'nightly-01:00-UTC',
  });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', {
    board: 'target-board',
    universe: UNIVERSE,
    note: 'nightly stopgap until 4h ships checkpoint-resume',
  });

  try {
    const scan = await runTargetScan({
      universe: UNIVERSE,
      pass2Max: 200,
      scanBudgetMs: PER_SCAN_BUDGET_MS,
      analystConcurrency: 6,
      logger: log,
    });

    const { snapshotId } = await writeSnapshot('target-board', STORE_KEY, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      universeChecked: scan.universeChecked,
      results: scan.results,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS['target-board'],
      warnings: scan.warnings,
    });

    const count = scan.results.length;
    log.info('snapshot_written', {
      snapshotId,
      resultsCount: count,
      universeChecked: scan.universeChecked,
      scanDurationMs: scan.scanDurationMs,
      overallDurationMs: Date.now() - overallStart,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'target-board',
        universe: UNIVERSE,
        snapshotId,
        resultsCount: count,
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
      body: JSON.stringify({ ok: false, board: 'target-board', universe: UNIVERSE, error: msg }),
    };
  }
});
