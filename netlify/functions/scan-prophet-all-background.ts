// Wave 2D (CR-7) — Prophet 'all' snapshot scan, scheduled BACKGROUND
// worker.
//
// The thin cron dispatcher (`scan-prophet-all.ts`, cron
// `0,30 13-21 * * 1-5`) POSTs here after its holiday guard passes.
//
// Wave 3 (track-3 critical #7 follow-up) — the body now runs the 3-stage
// SIEVE, not a single-pass scan. The ~2,200-name 'all' universe cannot
// complete a full 7-layer single pass inside the 14-min container budget:
// the pre-Wave-3 body routinely hit budgetExceeded → status:'partial' →
// writeSnapshot's partial-safe guard never promoted it → `_latest/all`
// went stale on 2026-05-12 and stayed there. The sieve (the same one
// russell uses) Stage-1 cheap-scores the FULL universe, then deepens
// survivors through Stages 2/3 — guaranteeing universe-wide coverage AND
// a promotable `complete` snapshot within budget.
//
// Wave 2D (CR-8) — partial-publish discipline:
//   - status stamped from the sieve's per-stage partial flags, so a
//     budget-truncated stage lands in runs/ for diagnostics but never
//     swaps _latest;
//   - assessSnapshotPublish guards the publish: a "complete" run that
//     assembled a hollow result (provider outage → 0 picks over ~2,200
//     names) is demoted to status:'partial' instead of replacing the
//     prior good snapshot.
//
// AUTH: none, mirroring the insider/target cron→worker self-invokes
// (owner decision: no token gating on scan paths).

import type { Handler } from '@netlify/functions';
import { resolveProphetUniverse, type ProphetUniverseKey } from './shared/scan-prophet';
import { runProphetSieve } from './shared/prophet-sieve';
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
    // Wave 3 (track-3 critical #7 follow-up) — the 'all' universe (~2,200
    // names) CANNOT complete a single-pass 7-layer scan inside the 14-min
    // budget (the pre-Wave-3 body routinely hit budgetExceeded → status:
    // partial → never promoted → _latest/all went stale 2026-05-12). Drive
    // it through the same 3-stage sieve russell uses: Stage 1 cheap-scores
    // the FULL universe, then deepens survivors — guaranteeing universe-wide
    // coverage AND a promotable `complete` snapshot.
    const entries = resolveProphetUniverse(UNIVERSE);
    const sieveResult = await runProphetSieve({
      entries,
      universe: UNIVERSE,
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

    // Wave 2D (CR-8) — stamp status from the sieve's per-stage partial
    // flags. Any stage that ran out of budget means a truncated result, so
    // the snapshot must not swap _latest (writeSnapshot's partial-safe guard).
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
        // Wave 4A (M8) — the guard's denominator is the universe size at
        // scan start, not the scored count (which universeChecked carries).
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
        universeChecked: sieveResult.universeChecked,
        scanDurationMs: sieveResult.scanDurationMs,
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
