// QS-1 — Quiet Strength scan, background worker (15-min container).
// Dispatched by scan-quiet-strength.ts.

import type { Handler } from '@netlify/functions';
import { runQuietStrengthScan } from './shared/scan-quiet-strength';
import {
  writeSnapshot,
  assessSnapshotPublish,
  FRESHNESS_BUDGETS_MS,
} from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

const PER_SCAN_BUDGET_MS = 13 * 60_000;
const BOARD = 'quiet-strength' as const;
const UNIVERSE = 'all' as const;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const log = logger.child({ fn: 'scan-quiet-strength-background', universe: UNIVERSE });
  const started = Date.now();
  try {
    const scan = await runQuietStrengthScan({
      scanBudgetMs: PER_SCAN_BUDGET_MS - 90_000, // leave room for the write
      concurrency: 8,
      logger: log,
    });

    let status: 'complete' | 'partial' = scan.budgetExceeded ? 'partial' : 'complete';
    const warnings = [...scan.warnings];

    // A factor gap is not a partial SCAN — every provider answered — but it
    // does mean the board is not the measurement it advertises, so it must
    // not become the canonical snapshot.
    if (scan.factorLatestYm !== null && scan.factorLatestYm < scan.scoringEndYm) {
      status = 'partial';
      warnings.push(
        `factor series ends ${scan.factorLatestYm}, scoring window needs ${scan.scoringEndYm} — not promoted`,
      );
    }

    if (status === 'complete') {
      const decision = assessSnapshotPublish({
        resultCount: scan.rows.length,
        universeChecked: scan.universeChecked,
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
      results: scan.rows,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS[BOARD],
      warnings,
      status,
      // The banner and the exposure decision ride the SNAPSHOT, not a UI
      // component. The kickoff requires the evidence grade and the haircut
      // to be undroppable by a front-end refactor, and this is what makes
      // that structurally true: any reader of the snapshot has them.
      banner: scan.banner,
      exposure: scan.exposure,
      scored: scan.scored,
      excludedCounts: scan.excludedCounts,
      unscorableCounts: scan.unscorableCounts,
      factorLatestYm: scan.factorLatestYm,
      scoringEndYm: scan.scoringEndYm,
      returnBasis: scan.returnBasis,
      datesFetched: scan.datesFetched,
    } as any);

    log.info('snapshot_written', {
      snapshotId, status, promotedToLatest,
      rows: scan.rows.length, scored: scan.scored,
      datesFetched: scan.datesFetched, durationMs: Date.now() - started,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, snapshotId, status, rows: scan.rows.length }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('quiet_strength_scan_failed', { err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
