// Per-universe scheduled scan: prophet board.
// Prophet has 3 universes (largecap, russell, all) — one function each.
//
// Board:    prophet
// Universe: russell (stored as 'russell2k')
// Schedule: 0,30 13-21 * * 1-5
//
// Phase 4c-1 (W4): pre-narrate qualified picks before snapshot write.
// Russell is the universe most pressed against the 15-min container limit
// (4c-2's sieve architecture exists to address this), so the narration
// budget here is tighter than largecap. Un-narrated picks ship fine —
// the prophet-narrate endpoint regenerates on demand.

import { schedule } from '@netlify/functions';
import { runProphetScan, type ProphetUniverseKey } from './shared/scan-prophet';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';
import { narrateAll } from './shared/narrative-generator';

const PER_SCAN_BUDGET_MS = 14 * 60_000;
// Tighter cap on russell — scan itself often takes the full 14 min today.
// 90s is enough to narrate ~30 picks at concurrency 4 (the top of the
// list, which is what users look at). 4c-2's sieve will free up time;
// when it ships, this can be raised.
const NARRATE_BUDGET_MS = 90_000;
const NARRATE_CONCURRENCY = 4;

const UNIVERSE: ProphetUniverseKey = 'russell';
const STORE_KEY: UniverseKey = 'russell2k';

export const handler = schedule('0,30 13-21 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-prophet-russell', universe: UNIVERSE });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', { board: 'prophet', universe: UNIVERSE });

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

    const { snapshotId } = await writeSnapshot('prophet', STORE_KEY, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      universeChecked: scan.universeChecked,
      results: scan.picks,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.prophet,
      warnings: scan.warnings,
    });

    const count = scan.picks.length;
    const narratedCount = scan.picks.filter((p) => p.narrative).length;
    log.info('snapshot_written', {
      snapshotId,
      picks: count,
      narrated: narratedCount,
      universeChecked: scan.universeChecked,
      scanDurationMs: scan.scanDurationMs,
      overallDurationMs: Date.now() - overallStart,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board: 'prophet',
        universe: UNIVERSE,
        snapshotId,
        picks: count,
        narrated: narratedCount,
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
      body: JSON.stringify({ ok: false, board: 'prophet', universe: UNIVERSE, error: msg }),
    };
  }
});
