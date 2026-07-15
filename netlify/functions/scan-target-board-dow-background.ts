// scan-target-board-dow-background — 15-min background worker.
//
// Dead-cron remediation (runtime audit 2026-07-15): this scan previously
// ran INLINE in its scheduled function. Netlify grants the 15-minute
// budget only to *-background names; the inline scan was killed at the
// synchronous ceiling before writeSnapshot — the same failure class the
// #95-#97 remediation fixed for four other boards. The cron file is now a
// thin dispatcher; the scan body below is verbatim from the old inline
// handler.

// Per-universe scheduled scan: target board.
// Splits Phase 1's 4-universe-in-loop pattern into one function per
// universe so each gets its own 15-min Netlify background container.
//
// Board:    target-board
// Universe: dow (stored as 'dow')
// Schedule: 0,30 13-21 * * 1-5
//
// Split from Phase 1's multi-universe scan-target-board.ts so each universe gets
// its own 15-min Netlify background container instead of competing for one.

import type { Handler } from '@netlify/functions';
import { runTargetScan, type TargetUniverseKey } from './shared/scan-target';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

// 14 min — leaves 60s margin under the 15-min Netlify background timeout.
const PER_SCAN_BUDGET_MS = 14 * 60_000;

const UNIVERSE: TargetUniverseKey = 'dow';
const STORE_KEY: UniverseKey = 'dow';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const log = logger.child({ fn: 'scan-target-board-dow', universe: UNIVERSE });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', { board: 'target-board', universe: UNIVERSE });

  try {
    const scan = await runTargetScan({
      universe: UNIVERSE,
      pass2Max: 30,
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
};
