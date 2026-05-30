// Phase 6 PR-H — extracted Prophet snapshot scan body.
//
// Shared between the scheduled after-close runner
// (`scan-prophet-largecap.ts`) and the manual-trigger HTTP endpoint
// (`scan-prophet-largecap-trigger.ts`) so test runs hit exactly the same
// code path the cron does.
//
// Strict scope: this module ONLY runs the deterministic 7-layer Prophet
// scorer and writes the snapshot. Zero Claude calls in the scan path —
// the post-snapshot thesis lives on the on-demand /api/prophet-narrate
// endpoint (Firestore-cached per (ticker, snapshotDate)). The brief's
// rule "NO Claude in the scan" is enforced by construction here: there
// is no anthropic-client import in this file, and the unit test asserts
// `narrateAll` and friends are NEVER invoked during a scan.

import { runProphetScan, type ProphetUniverseKey } from './scan-prophet';
import {
  writeSnapshot,
  FRESHNESS_BUDGETS_MS,
  type UniverseKey,
  type BoardSnapshot,
} from './snapshot-store';
import { MODEL_VERSION } from './model-version';
import type { Logger } from './logger';

// Default budget: 14 min (60s margin under the 15-min Netlify background
// container timeout). The manual-trigger endpoint passes a tighter budget
// since it runs in the foreground.
export const DEFAULT_PROPHET_SCAN_BUDGET_MS = 14 * 60_000;

export interface RunProphetSnapshotOpts {
  universe: ProphetUniverseKey;
  storeKey: UniverseKey;
  scanBudgetMs?: number;
  concurrency?: number;
  /** When true, force the scan to record a partial snapshot regardless of
   *  actual budget exhaustion. Used by the manual-trigger endpoint to
   *  verify the partial-safe write path end-to-end. */
  forcePartial?: boolean;
  logger: Logger;
}

export interface RunProphetSnapshotResult {
  ok: boolean;
  snapshotId?: string;
  promotedToLatest?: boolean;
  status: 'complete' | 'partial';
  picks: number;
  universeChecked: number;
  scanDurationMs: number;
  overallDurationMs: number;
  warnings?: string[];
  error?: string;
}

export async function runProphetSnapshot(
  opts: RunProphetSnapshotOpts,
): Promise<RunProphetSnapshotResult> {
  const log = opts.logger;
  const overallStart = Date.now();
  log.info('prophet_snapshot_started', { board: 'prophet', universe: opts.universe });

  try {
    const scan = await runProphetScan({
      universe: opts.universe,
      scanBudgetMs: opts.scanBudgetMs ?? DEFAULT_PROPHET_SCAN_BUDGET_MS,
      concurrency: opts.concurrency ?? 7,
      sufficientQualified: Infinity,
      logger: log,
    });

    const status: 'complete' | 'partial' =
      opts.forcePartial || scan.budgetExceeded ? 'partial' : 'complete';

    const snapshot: BoardSnapshot = {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      universeChecked: scan.universeChecked,
      results: scan.picks,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.prophet,
      warnings: scan.warnings,
      status,
    };

    const { snapshotId, promotedToLatest } = await writeSnapshot('prophet', opts.storeKey, snapshot);

    log.info('prophet_snapshot_written', {
      snapshotId,
      status,
      promotedToLatest,
      picks: scan.picks.length,
      universeChecked: scan.universeChecked,
      scanDurationMs: scan.scanDurationMs,
      overallDurationMs: Date.now() - overallStart,
    });

    return {
      ok: true,
      snapshotId,
      promotedToLatest,
      status,
      picks: scan.picks.length,
      universeChecked: scan.universeChecked,
      scanDurationMs: scan.scanDurationMs,
      overallDurationMs: Date.now() - overallStart,
      warnings: scan.warnings,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('prophet_snapshot_failed', { err: msg, universe: opts.universe });
    return {
      ok: false,
      status: 'partial',
      picks: 0,
      universeChecked: 0,
      scanDurationMs: 0,
      overallDurationMs: Date.now() - overallStart,
      error: msg,
    };
  }
}
