// Per-universe scheduled scan: prophet board, russell.
//
// 4c-2: this scanner now uses the 3-stage sieve instead of a single-pass
// scan over 2000 names. The sieve scores EVERY Russell ticker at Stage 1
// (cheap bars-only filter), narrows to ~80 with Stage 2 (earnings-quality
// gate per Chad's product priority), then runs the full 7-layer scan on
// survivors at Stage 3.
//
// Why: pre-sieve, the single-pass scan exhausted the 14-min container
// budget around ~600 tickers, leaving 1400+ Russell names un-scored.
// The sieve guarantees universe-wide first-pass coverage.

import { schedule } from '@netlify/functions';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';
import { narrateAll } from './shared/narrative-generator';
import { inIndex } from './shared/universe';
import { runProphetSieve } from './shared/prophet-sieve';

const NARRATE_BUDGET_MS = 60_000; // 1 min budget after the sieve finishes
const NARRATE_CONCURRENCY = 4;

const STORE_KEY: UniverseKey = 'russell2k';

export const handler = schedule('0,30 13-21 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-prophet-russell', universe: 'russell' });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', { board: 'prophet', universe: 'russell', mode: 'sieve' });

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

    const { snapshotId } = await writeSnapshot('prophet', STORE_KEY, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: sieveResult.scanDurationMs,
      universeChecked: sieveResult.universeChecked,
      results: sieveResult.picks,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.prophet,
      warnings: sieveResult.warnings,
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
      picks: count,
      narrated: narratedCount,
      universeChecked: sieveResult.universeChecked,
      scanDurationMs: sieveResult.scanDurationMs,
      overallDurationMs: Date.now() - overallStart,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'prophet',
        universe: 'russell',
        snapshotId,
        picks: count,
        narrated: narratedCount,
        universeChecked: sieveResult.universeChecked,
        scanDurationMs: sieveResult.scanDurationMs,
        sieve: sieveResult.meta,
        warnings: sieveResult.warnings,
      }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('scheduled_scan_failed', { err: msg, universe: 'russell' });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, board: 'prophet', universe: 'russell', error: msg }),
    };
  }
});
