// scan-williams-dow-background — 15-min background worker.
//
// Dead-cron remediation (runtime audit 2026-07-15): this scan previously
// ran INLINE in its scheduled function. Netlify grants the 15-minute
// budget only to *-background names; the inline scan was killed at the
// synchronous ceiling before writeSnapshot — the same failure class the
// #95-#97 remediation fixed for four other boards. The cron file is now a
// thin dispatcher; the scan body below is verbatim from the old inline
// handler.

// Per-universe scheduled scan: williams board.
//
// Board:    williams
// Universe: dow (stored as 'dow')
// Schedule: 0,30 13-21 * * 1-5
//
// Split from Phase 1's multi-universe scan-williams.ts so each universe gets
// its own 15-min Netlify background container instead of competing for one.

import type { Handler } from '@netlify/functions';
import { runWilliamsScan, type WilliamsUniverseKey } from './shared/scan-williams';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

// 14 min — leaves 60s margin under the 15-min Netlify background timeout.
const PER_SCAN_BUDGET_MS = 14 * 60_000;

const UNIVERSE: WilliamsUniverseKey = 'dow';
const STORE_KEY: UniverseKey = 'dow';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const log = logger.child({ fn: 'scan-williams-dow', universe: UNIVERSE });
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
};
