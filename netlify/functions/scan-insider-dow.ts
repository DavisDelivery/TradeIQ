// Per-universe scheduled scan: insider board (daily, after US close).
//
// Board:    insider
// Universe: dow (stored as 'dow')
// Schedule: 45 21 * * 1-5
//
// Split from Phase 1's multi-universe scan-insider.ts so each universe gets
// its own 15-min Netlify background container instead of competing for one.
//
// Phase 4o W1 — staggered from 21:30 to 21:45 so it doesn't share a
// Finnhub-quota minute with russell2k (21:30), sp500 (21:35), or ndx (21:40).

import { schedule } from '@netlify/functions';
import { runInsiderScan, type InsiderUniverseKey } from './shared/scan-insider';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';
import { INSIDER_SCHEDULED_WINDOW_DAYS } from './shared/scan-insider';

// 14 min — leaves 60s margin under the 15-min Netlify background timeout.
const PER_SCAN_BUDGET_MS = 14 * 60_000;

const UNIVERSE: InsiderUniverseKey = 'dow';
const STORE_KEY: UniverseKey = 'dow';

export const handler = schedule('45 21 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-insider-dow', universe: UNIVERSE });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', { board: 'insider', universe: UNIVERSE });

  try {
    const scan = await runInsiderScan({
      universe: UNIVERSE,
      windowDays: INSIDER_SCHEDULED_WINDOW_DAYS,
      scanBudgetMs: PER_SCAN_BUDGET_MS,
      concurrency: 8,
      enrichRoles: true,
      enrichPrice: true,
      logger: log,
    });

    const { snapshotId } = await writeSnapshot('insider', STORE_KEY, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      universeChecked: scan.universeChecked,
      results: scan.rows,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.insider,
      warnings: scan.warnings,
    });

    const count = scan.rows.length;
    log.info('snapshot_written', {
      snapshotId,
      rows: count,
      universeChecked: scan.universeChecked,
      scanDurationMs: scan.scanDurationMs,
      overallDurationMs: Date.now() - overallStart,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'insider',
        universe: UNIVERSE,
        snapshotId,
        rows: count,
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
      body: JSON.stringify({ ok: false, board: 'insider', universe: UNIVERSE, error: msg }),
    };
  }
});
