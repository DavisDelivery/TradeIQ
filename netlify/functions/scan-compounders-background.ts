// COMP-1 — Compounders scan, background worker (15-min container).
// Dispatched by scan-compounders.ts.

import type { Handler } from '@netlify/functions';
import {
  runCompoundersScan,
  MIN_EXACT_BASIS_SHARE,
} from './shared/scan-compounders';
import {
  writeSnapshot,
  assessSnapshotPublish,
  FRESHNESS_BUDGETS_MS,
} from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

const PER_SCAN_BUDGET_MS = 13 * 60_000;
/**
 * Below this the largecap universe is not a universe, it is an outage. The
 * three index legs together are ~600 names; a third of one leg would still
 * clear a low floor, so this sits high enough to catch a leg going missing.
 */
const MIN_UNIVERSE = 300;

/**
 * Minimum share of finalists that must actually score.
 *
 * A healthy run scores roughly 170 of 250 finalists (~68%); the rest are the
 * quality floor doing its job plus a handful of missing statements. The first
 * live run managed 21 of 250 — 8% — and published it. Set at 40%: low enough
 * that an ordinary bad day still publishes, high enough that a provider
 * change silently gutting the statement or margin checks does not.
 */
const MIN_SCORED_SHARE = 0.4;

const BOARD = 'compounders' as const;
const UNIVERSE = 'largecap' as const;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const log = logger.child({ fn: 'scan-compounders-background', universe: UNIVERSE });
  const started = Date.now();
  try {
    const scan = await runCompoundersScan({
      scanBudgetMs: PER_SCAN_BUDGET_MS - 90_000, // leave room for the write
      concurrency: 8,
      logger: log,
    });

    let status: 'complete' | 'partial' = scan.budgetExceeded ? 'partial' : 'complete';
    const warnings = [...scan.warnings];

    // THE BASIS RULE. A board can finish inside its budget, with every
    // provider answering, and still not be the measurement it advertises:
    // if most of the scored names fell back to the ROE proxy, "quality-led"
    // means a leverage-gameable ratio, not Novy-Marx gross profitability.
    // That is not a partial SCAN, but it must not become the canonical
    // snapshot either — same discipline as the quiet-strength factor gap.
    const exactShare = scan.scored > 0 ? scan.exactBasisCount / scan.scored : 0;
    if (scan.scored > 0 && exactShare < MIN_EXACT_BASIS_SHARE) {
      status = 'partial';
      warnings.push(
        `only ${scan.exactBasisCount}/${scan.scored} scored names on the exact ` +
          `gross-profits-to-assets basis (< ${(MIN_EXACT_BASIS_SHARE * 100).toFixed(0)}%) — not promoted`,
      );
    }

    // A COLLAPSED OR PARTIAL UNIVERSE IS NOT A BOARD.
    //
    // fetchFinvizScreener returns null rather than throwing, so a provider
    // outage arrives here as a small-but-plausible universe with rows in it.
    // The publish guard cannot catch that on its own: every arm is
    // denominator-gated, and a zero universe misses all of them and is cleared
    // to overwrite a good snapshot with an empty one. snapshot-store's own rule
    // is "NEVER overwrite a good complete snapshot with a failed/empty one",
    // so the refusal belongs here, where the universe counts are known.
    if (scan.universeLegsAnswered < scan.universeLegsRequested) {
      status = 'partial';
      warnings.push(
        `universe incomplete: ${scan.universeLegsAnswered}/${scan.universeLegsRequested} ` +
          `index legs answered — not promoted`,
      );
    }
    if (scan.universeSize < MIN_UNIVERSE) {
      status = 'partial';
      warnings.push(
        `universe collapsed to ${scan.universeSize} names (floor ${MIN_UNIVERSE}) — not promoted`,
      );
    }

    // A BOARD THAT SHRANK IS NOT A BOARD, EVEN WHEN IT IS NOT EMPTY.
    //
    // assessSnapshotPublish only refuses at resultCount === 0, so the first
    // live run published 21 names out of a 518-name universe as a healthy
    // 'complete' snapshot and nothing objected — the collapse was found by
    // reading the payload by hand. Every failure on this board so far has had
    // that shape: not an error, just far fewer names than there should be,
    // rendering as an ordinary ranking. The scored count is the one number
    // that moves in all of them, so it gets a floor of its own.
    const scoredShare = scan.finalistsScored > 0 ? scan.scored / scan.finalistsScored : 0;
    if (scan.finalistsScored > 0 && scoredShare < MIN_SCORED_SHARE) {
      status = 'partial';
      warnings.push(
        `only ${scan.scored}/${scan.finalistsScored} finalists scored ` +
          `(${(scoredShare * 100).toFixed(0)}%, floor ${(MIN_SCORED_SHARE * 100).toFixed(0)}%) — not promoted`,
      );
    }

    if (status === 'complete') {
      const decision = assessSnapshotPublish({
        resultCount: scan.rows.length,
        universeChecked: scan.universeChecked,
        // The statement stage is where this scan can silently hollow out, so
        // the guard gets its failure-rate arm the counts it needs.
        totalCalls: scan.statementCalls,
        errorCalls: scan.statementErrors,
        rateLimitedCalls: scan.statementRateLimited,
      });
      if (decision.action === 'skip') {
        status = 'partial';
        warnings.push(`publish guard: ${decision.reason}`);
      }
    }

    const { snapshotId, promotedToLatest } = await writeSnapshot(BOARD, UNIVERSE, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      universeChecked: scan.universeChecked,
      universeSize: scan.universeSize,
      // `results` is what the snapshot infrastructure reads — the doc-size
      // trim, the PIT/backtest reads and forward-test.extractTopN all take it
      // by that name — while the board contract names the same array `rows`.
      // Both are written, pointing at one array, rather than making either
      // reader guess. Bounded by the finalist count (~250 rows, ~40KB), so
      // the duplication is nowhere near the 1 MiB ceiling.
      results: scan.rows,
      // NO SEPARATE `rows` KEY. writeSnapshot's 1 MiB size-safety trim only
      // trims `results`, then rebuilds the doc with a spread — a parallel
      // `rows` array rides through untrimmed, so the doc still busts the
      // ceiling, `truncated: true` becomes a lie, and the endpoint's
      // `rows ?? results` would prefer the untrimmed copy. The board endpoint
      // already falls back to `results`.
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS[BOARD],
      warnings,
      status,
      // The banner rides the SNAPSHOT, not a UI component: the evidence grade
      // and the UNMEASURED verdict must not be droppable by a front-end
      // refactor, and this is what makes that structurally true.
      banner: scan.banner,
      scored: scan.scored,
      excludedCounts: scan.excludedCounts,
      unscorableCounts: scan.unscorableCounts,
      exactBasisCount: scan.exactBasisCount,
      qualityBasis: scan.qualityBasis,
      finalistCount: scan.finalistCount,
      momentumStartYm: scan.momentumStartYm,
      momentumEndYm: scan.momentumEndYm,
      momentumSkippedYm: scan.momentumSkippedYm,
      datesFetched: scan.datesFetched,
    } as any);

    log.info('snapshot_written', {
      snapshotId, status, promotedToLatest,
      rows: scan.rows.length, scored: scan.scored,
      exactBasisCount: scan.exactBasisCount, qualityBasis: scan.qualityBasis,
      durationMs: Date.now() - started,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, snapshotId, status, rows: scan.rows.length }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('compounders_scan_failed', { err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
