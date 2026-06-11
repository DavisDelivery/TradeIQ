// Wave 2D (CR-7) — Prophet 'all' snapshot scan, scheduled BACKGROUND
// worker.
//
// The thin cron dispatcher (`scan-prophet-all.ts`, cron
// `0,30 13-21 * * 1-5`) POSTs here after its holiday guard passes. The
// scan body is the pre-Wave-2D scheduled handler's, carried over
// unchanged: full 7-layer scan over the ~2,200-name 'all' universe on a
// 14-min budget, then pre-narration of qualified picks (4c-1 W4) before
// the snapshot write. Background functions get the 15-minute container
// this needs; the old in-handler cron was killed at the ~26s synchronous
// ceiling before writeSnapshot ever ran.
//
// Wave 2D (CR-8) — partial-publish discipline, previously missing on
// this path:
//   - status stamped from the scan's budgetExceeded flag (the 'all'
//     universe at concurrency 7 routinely truncates), so a partial run
//     lands in runs/ for diagnostics but never swaps _latest;
//   - assessSnapshotPublish guards the publish: a "complete" run that
//     assembled a hollow result (provider outage → 0 picks over ~2,200
//     names) is demoted to status:'partial' instead of replacing the
//     prior good snapshot.
//
// AUTH: none, mirroring the insider/target cron→worker self-invokes
// (owner decision: no token gating on scan paths).

import type { Handler } from '@netlify/functions';
import { runProphetScan, type ProphetUniverseKey } from './shared/scan-prophet';
import {
  writeSnapshot,
  assessSnapshotPublish,
  pruneOldSnapshots,
  FRESHNESS_BUDGETS_MS,
  type UniverseKey,
} from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';
import { narrateAll } from './shared/narrative-generator';

const PER_SCAN_BUDGET_MS = 14 * 60_000;
// 'all' covers ~2200 tickers — scan duration is variable. 2 min narration
// budget covers most cases without risking the container limit.
const NARRATE_BUDGET_MS = 2 * 60_000;
const NARRATE_CONCURRENCY = 4;

const UNIVERSE: ProphetUniverseKey = 'all';
const STORE_KEY: UniverseKey = 'all';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const log = logger.child({ fn: 'scan-prophet-all-background', universe: UNIVERSE });
  const overallStart = Date.now();
  log.info('background_scan_started', { board: 'prophet', universe: UNIVERSE });

  try {
    const scan = await runProphetScan({
      universe: UNIVERSE,
      scanBudgetMs: PER_SCAN_BUDGET_MS,
      concurrency: 7,
      sufficientQualified: Infinity,
      logger: log,
    });

    if (process.env.ANTHROPIC_API_KEY && scan.picks.length > 0) {
      const narrateResult = await narrateAll(scan.picks, {
        concurrency: NARRATE_CONCURRENCY,
        budgetMs: NARRATE_BUDGET_MS,
        onWarn: (msg, ticker, err) =>
          log.warn(msg, { ticker, err: String((err as any)?.message ?? err) }),
      });
      log.info('narrate_all_complete', {
        picks: scan.picks.length,
        narrated: narrateResult.narrated,
        failed: narrateResult.failed,
        skipped: narrateResult.skipped,
        durationMs: narrateResult.durationMs,
      });
    }

    // Wave 2D (CR-8) — stamp status from the scan's budget flag so a
    // truncated run never swaps _latest (writeSnapshot's partial-safe
    // guard), mirroring runProphetSnapshot on the largecap path.
    let status: 'complete' | 'partial' = scan.budgetExceeded ? 'partial' : 'complete';
    const warnings = [...scan.warnings];
    let degraded: boolean | undefined;
    let degradedReason: string | undefined;

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

    const { snapshotId, promotedToLatest } = await writeSnapshot('prophet', STORE_KEY, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      // runProphetScan's universeChecked is the universe size; the
      // single-pass scan has no separate scored count (a truncated run
      // is stamped status:'partial' instead). Stamp universeSize so
      // consumers read a consistent shape across Prophet universes.
      universeChecked: scan.universeChecked,
      universeSize: scan.universeChecked,
      results: scan.picks,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.prophet,
      warnings,
      degraded,
      degradedReason,
      status,
    });

    const count = scan.picks.length;
    const narratedCount = scan.picks.filter((p) => p.narrative).length;
    log.info('snapshot_written', {
      snapshotId,
      status,
      promotedToLatest,
      picks: count,
      narrated: narratedCount,
      universeChecked: scan.universeChecked,
      scanDurationMs: scan.scanDurationMs,
      overallDurationMs: Date.now() - overallStart,
    });

    // Wave 4A — keep-daily-close retention. The 'all' cron fires every
    // 30 min in market hours; beyond the 30-day horizon only each day's
    // last snapshot (the backtest substrate snapshotBeforeDate reads) is
    // kept. Best-effort: a prune failure must never fail a successful scan.
    try {
      const { deleted, kept } = await pruneOldSnapshots('prophet', STORE_KEY, {
        mode: 'keep-daily-close',
      });
      log.info('snapshot_retention_pruned', { universe: STORE_KEY, deleted, kept });
    } catch (err: any) {
      log.warn('snapshot_retention_prune_failed', { err: String(err?.message ?? err) });
    }

    // The response body is discarded by Netlify for background functions;
    // the payload below surfaces only in function logs/tests.
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'prophet',
        universe: UNIVERSE,
        snapshotId,
        status,
        promotedToLatest,
        picks: count,
        narrated: narratedCount,
        universeChecked: scan.universeChecked,
        scanDurationMs: scan.scanDurationMs,
        warnings,
      }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('background_scan_failed', { err: msg, universe: UNIVERSE });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, board: 'prophet', universe: UNIVERSE, error: msg }),
    };
  }
};
