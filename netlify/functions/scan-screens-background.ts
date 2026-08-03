// FVZ-6 — nightly snapshot worker for the published screening strategies.
//
// Writes ONE snapshot per screen under board 'screens' with the screen id as
// the universe key, which is what lets forward-test.ts treat each strategy as
// its own cohort and rank them against each other — and against our own
// boards — on identical terms.
//
// A screen whose upstream fetch FAILED is skipped entirely rather than
// published empty. Publishing zero rows would enter a phantom "no candidates
// tonight" into that screen's permanent forward-test record, which is
// indistinguishable after the fact from a night where the strategy genuinely
// had nothing to say. Skipping leaves a visible gap instead.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';
import { runAllScreenScans } from './shared/scan-screens';
import {
  writeSnapshot,
  FRESHNESS_BUDGETS_MS,
  pruneOldSnapshots,
  trimResultsForDocLimit,
  type UniverseKey,
} from './shared/snapshot-store';

const BOARD = 'screens';
const RETENTION_KEEP = 30;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const log = logger.child({ fn: 'scan-screens-background' });
  const started = Date.now();

  try {
    const { results, failed } = await runAllScreenScans();
    log.info('screens_scanned', {
      published: results.length,
      failed: failed.length,
      failedIds: failed,
    });

    let written = 0;
    for (const res of results) {
      const trimmed = trimResultsForDocLimit(res.rows);
      const { snapshotId, promotedToLatest } = await writeSnapshot(
        BOARD,
        // The screen id stands in for the universe key: each strategy is its
        // own cohort. Cast is deliberate — UniverseKey is a closed union of
        // index names and these are screen ids, but the store only uses it
        // as an opaque document key.
        res.screenId as unknown as UniverseKey,
        {
          modelVersion: MODEL_VERSION,
          generatedAt: new Date().toISOString(),
          scanDurationMs: Date.now() - started,
          universeChecked: res.universeChecked,
          universeSize: res.universeChecked,
          results: trimmed.results,
          freshnessBudgetMs: FRESHNESS_BUDGETS_MS[BOARD],
          warnings: res.warnings,
          truncated: trimmed.truncated,
          originalResultCount: res.rows.length,
          // Carried so the league can show WHAT it is measuring without
          // re-deriving it from the screen catalog.
          screenName: res.screenName,
          evidence: res.evidence,
          sourceUniverse: res.universe,
        } as any,
      );
      written++;
      log.info('snapshot_written', {
        screenId: res.screenId,
        snapshotId,
        promotedToLatest,
        rows: trimmed.results.length,
      });
      await pruneOldSnapshots(BOARD, res.screenId as unknown as UniverseKey, RETENTION_KEEP).catch(
        () => {},
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, written, failed, durationMs: Date.now() - started }),
    };
  } catch (err: any) {
    log.error('scan_failed', { error: err, durationMs: Date.now() - started });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
};
