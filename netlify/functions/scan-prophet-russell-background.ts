// Wave 2D (CR-7) — Prophet russell snapshot scan, scheduled BACKGROUND
// worker.
//
// The thin cron dispatcher (`scan-prophet-russell.ts`, cron
// `0,30 13-21 * * 1-5`) POSTs here after its holiday guard passes. The
// scan body is the pre-Wave-2D scheduled handler's, carried over
// unchanged: the 3-stage sieve (4c-2) scores EVERY Russell ticker at
// Stage 1 (cheap bars-only filter), narrows to ~80 with Stage 2
// (earnings-quality gate), runs the full 7-layer scan on survivors at
// Stage 3, then pre-narrates qualified picks (4c-1 W4) before the
// snapshot write. Background functions get the 15-minute container the
// ~14-min sieve needs; the old in-handler cron was killed at the ~26s
// synchronous ceiling before writeSnapshot ever ran.
//
// Wave 2D (CR-8) — partial-publish discipline, previously missing on
// this path:
//   - status stamped from the sieve's per-stage partial flags, so a
//     truncated run lands in runs/ for diagnostics but never swaps
//     _latest (writeSnapshot's partial-safe guard);
//   - assessSnapshotPublish guards the publish: a "complete" run that
//     assembled a hollow result (provider outage → 0 picks over the
//     ~1,930-name universe) is demoted to status:'partial' instead of
//     replacing the prior good snapshot.
//
// AUTH: none, mirroring the insider/target cron→worker self-invokes
// (owner decision: no token gating on scan paths).

import type { Handler } from '@netlify/functions';
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
import { inIndex } from './shared/universe';
import { runProphetSieve } from './shared/prophet-sieve';

const NARRATE_BUDGET_MS = 60_000; // 1 min budget after the sieve finishes
const NARRATE_CONCURRENCY = 4;

const STORE_KEY: UniverseKey = 'russell2k';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const log = logger.child({ fn: 'scan-prophet-russell-background', universe: 'russell' });
  const overallStart = Date.now();
  log.info('background_scan_started', { board: 'prophet', universe: 'russell', mode: 'sieve' });

  try {
    const entries = inIndex('russell2k');

    const sieveResult = await runProphetSieve({
      entries,
      universe: 'russell',
      logger: log,
    });

    if (process.env.ANTHROPIC_API_KEY && sieveResult.picks.length > 0) {
      const narrateResult = await narrateAll(sieveResult.picks, {
        concurrency: NARRATE_CONCURRENCY,
        budgetMs: NARRATE_BUDGET_MS,
        onWarn: (msg, ticker, err) =>
          log.warn(msg, { ticker, err: String((err as any)?.message ?? err) }),
      });
      log.info('narrate_all_complete', {
        picks: sieveResult.picks.length,
        narrated: narrateResult.narrated,
        failed: narrateResult.failed,
        skipped: narrateResult.skipped,
        durationMs: narrateResult.durationMs,
      });
    }

    // Wave 2D (CR-8) — stamp status from the sieve's partial flags. Any
    // stage that ran out of budget means the result set is truncated, so
    // the snapshot must not be promoted as canonical.
    const sievePartial =
      sieveResult.meta.stage1.partial ||
      sieveResult.meta.stage2.partial ||
      sieveResult.meta.stage3.partial;
    let status: 'complete' | 'partial' = sievePartial ? 'partial' : 'complete';
    const warnings = [...sieveResult.warnings];
    let degraded: boolean | undefined;
    let degradedReason: string | undefined;

    if (status === 'complete') {
      const decision = assessSnapshotPublish({
        resultCount: sieveResult.picks.length,
        // Wave 4A (M8) — the guard's denominator is "universe size at
        // scan start" (the Bug-A empty-over-large-universe check), not
        // the scored count, which is what universeChecked now carries.
        universeChecked: sieveResult.universeSize,
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
      scanDurationMs: sieveResult.scanDurationMs,
      // Wave 4A (M8) — honest coverage: universeChecked is Stage 1's
      // actually-scored count; universeSize is the full universe.
      universeChecked: sieveResult.universeChecked,
      universeSize: sieveResult.universeSize,
      results: sieveResult.picks,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.prophet,
      warnings,
      degraded,
      degradedReason,
      status,
      sieve: {
        stage1: {
          scored: sieveResult.meta.stage1.scored,
          survived: sieveResult.meta.stage1.survived,
          thresholdScore: sieveResult.meta.stage1.thresholdScore,
          budgetMs: sieveResult.meta.stage1.budgetMs,
          partial: sieveResult.meta.stage1.partial,
        },
        stage2: {
          scored: sieveResult.meta.stage2.scored,
          survived: sieveResult.meta.stage2.survived,
          thresholdScore: sieveResult.meta.stage2.thresholdScore,
          budgetMs: sieveResult.meta.stage2.budgetMs,
          partial: sieveResult.meta.stage2.partial,
        },
        stage3: {
          scored: sieveResult.meta.stage3.scored,
          survived: sieveResult.meta.stage3.survived,
          budgetMs: sieveResult.meta.stage3.budgetMs,
          partial: sieveResult.meta.stage3.partial,
        },
      },
    });

    const count = sieveResult.picks.length;
    const narratedCount = sieveResult.picks.filter((p) => p.narrative).length;
    log.info('snapshot_written', {
      snapshotId,
      status,
      promotedToLatest,
      picks: count,
      narrated: narratedCount,
      universeChecked: sieveResult.universeChecked,
      universeSize: sieveResult.universeSize,
      scanDurationMs: sieveResult.scanDurationMs,
      overallDurationMs: Date.now() - overallStart,
    });

    // Wave 4A — keep-daily-close retention. The russell cron fires every
    // 30 min in market hours, so runs/ accumulates up to ~18 snapshots a
    // day at up to 800KB; beyond the 30-day horizon only each day's last
    // snapshot (the backtest substrate snapshotBeforeDate reads) is kept.
    // Best-effort, mirroring the insider/target workers: a prune failure
    // must never fail a successful scan.
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
        universe: 'russell',
        snapshotId,
        status,
        promotedToLatest,
        picks: count,
        narrated: narratedCount,
        universeChecked: sieveResult.universeChecked,
        universeSize: sieveResult.universeSize,
        scanDurationMs: sieveResult.scanDurationMs,
        sieve: sieveResult.meta,
        warnings,
      }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('background_scan_failed', { err: msg, universe: 'russell' });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, board: 'prophet', universe: 'russell', error: msg }),
    };
  }
};
