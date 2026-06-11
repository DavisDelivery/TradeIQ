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
  assessSnapshotPublish,
  pruneOldSnapshots,
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
      // Largecap is now the full S&P 500 ∪ Nasdaq-100 ∪ Dow union (~508
      // names, up from a curated 208). At concurrency 7 a 508-ticker scan
      // ran ~16 min — past the 14-min budget → it would land `partial` and
      // never promote. 12 brings it to ~10 min with margin. The partial-safe
      // write guard still protects prod if a future universe growth ever
      // pushes it back over budget.
      concurrency: opts.concurrency ?? 12,
      sufficientQualified: Infinity,
      logger: log,
    });

    let status: 'complete' | 'partial' =
      opts.forcePartial || scan.budgetExceeded ? 'partial' : 'complete';
    const warnings = [...(scan.warnings ?? [])];
    let degraded: boolean | undefined;
    let degradedReason: string | undefined;

    // Wave 2D (CR-8) — publish guard on the Prophet publish path. A scan
    // that "completed" but assembled a hollow result (e.g. a data-provider
    // outage yielding 0 picks over a 500+-name universe) must not swap
    // _latest. We demote it to status:'partial' so it still lands in
    // runs/ for diagnostics but the prior good snapshot stays canonical —
    // the same discipline the insider/target workers enforce via
    // assessSnapshotPublish before their terminal write.
    if (status === 'complete') {
      const decision = assessSnapshotPublish({
        resultCount: scan.picks.length,
        universeChecked: scan.universeChecked,
      });
      if (decision.action === 'skip') {
        log.warn('publish_guard_skip', { reason: decision.reason });
        status = 'partial';
        warnings.push(`publish guard: ${decision.reason}`);
      } else if (decision.action === 'publish-degraded') {
        log.warn('publish_guard_degraded', { reason: decision.reason });
        degraded = true;
        degradedReason = decision.reason;
      }
    }

    const snapshot: BoardSnapshot = {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      // runProphetScan's universeChecked is the universe size; the
      // single-pass largecap scan has no separate scored count (a
      // truncated run is stamped status:'partial' instead). Stamp
      // universeSize so consumers read a consistent shape (Wave 4A M8).
      universeChecked: scan.universeChecked,
      universeSize: scan.universeChecked,
      results: scan.picks,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.prophet,
      warnings,
      degraded,
      degradedReason,
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

    // Wave 4A — keep-daily-close retention on the Prophet runs/ history.
    // The largecap path writes one snapshot per weekday (cron) plus any
    // manual-trigger runs; beyond the 30-day horizon only each day's
    // last snapshot survives (the backtest substrate snapshotBeforeDate
    // reads). Best-effort: a prune failure must never fail the scan.
    try {
      const { deleted, kept } = await pruneOldSnapshots('prophet', opts.storeKey, {
        mode: 'keep-daily-close',
      });
      log.info('snapshot_retention_pruned', { universe: opts.storeKey, deleted, kept });
    } catch (pruneErr: unknown) {
      log.warn('snapshot_retention_prune_failed', {
        err: pruneErr instanceof Error ? pruneErr.message : String(pruneErr),
      });
    }

    return {
      ok: true,
      snapshotId,
      promotedToLatest,
      status,
      picks: scan.picks.length,
      universeChecked: scan.universeChecked,
      scanDurationMs: scan.scanDurationMs,
      overallDurationMs: Date.now() - overallStart,
      warnings,
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
