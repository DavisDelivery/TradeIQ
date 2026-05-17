// Phase 4h W1 — checkpoint-resume background worker for russell2k target-board.
//
// The scheduled trigger (`scan-target-board-russell2k.ts`, cron `0 23
// * * *`) POSTs the initial invocation. Each invocation:
//   1. Reads `scanRuns/{runId}` for an existing cursor; resumes if
//      present, else starts fresh.
//   2. Pre-fetches the Polygon-cached company-name map (W3) on the
//      first invocation only; passes it through subsequent batches.
//   3. Loops `runTargetScanBatch` BATCH_SIZE tickers at a time, writing
//      each batch's scored rows to the `partial` subcollection and
//      advancing the cursor.
//   4. Breaks the loop when the 13-min watchdog trips; self-reinvokes
//      via `Context.waitUntil(fetch(...))` to continue in a fresh
//      container.
//   5. On the terminal batch: reads back every partial doc, sorts,
//      writes ONE snapshot, advances the `_latest` pointer, prunes
//      runs/ to the most recent 30, deletes the partial subcollection.
//
// The previous complete snapshot stays served at `_latest` for the
// entire scan duration; only the terminal batch's writeSnapshot flips
// the pointer. A failed mid-scan leaves the last good snapshot
// untouched.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';
import { MODEL_VERSION } from './shared/model-version';
import {
  resolveTargetUniverse,
  runTargetScanBatch,
  type TargetUniverseKey,
} from './shared/scan-target';
import {
  writeSnapshot,
  FRESHNESS_BUDGETS_MS,
  pruneOldSnapshots,
  type UniverseKey,
} from './shared/snapshot-store';
import {
  appendPartialBatch,
  clearScanCursor,
  deletePartialBatches,
  readAllPartialBatches,
  readScanCursor,
  writeScanCursor,
  type ScanCursor,
} from './shared/scan-resume/cursor';
import { createWatchdog } from './shared/backtest-resume/watchdog';
import {
  dispatchReinvoke,
  inferFunctionUrl,
  type ReinvokeContext,
} from './shared/backtest-resume/reinvoke';
import { enrichTickerNames } from './shared/ticker-reference';
import { computeRegime, regimeToMacroBias } from './shared/regime';
import type { Target } from './shared/types';

const UNIVERSE: TargetUniverseKey = 'russell2k';
const STORE_KEY: UniverseKey = 'russell2k';
const BOARD = 'target-board';

// 13-min wall-clock budget leaves 90s margin under Netlify's 15-min
// background-function kill ceiling — enough for the terminal Firestore
// writes + the self-reinvoke fetch to land.
const BUDGET_MS = Number(process.env.SCAN_BUDGET_MS ?? 13 * 60_000);
// Batch granularity. 50 tickers × ~1.5s × concurrency 6 ≈ 12.5s per
// batch, so a 13-min invocation processes ~60 batches before the
// watchdog fires. Override via SCAN_BATCH_SIZE for tuning.
const BATCH_SIZE = Number(process.env.SCAN_BATCH_SIZE ?? 50);
// Keep the 30 most recent snapshots per universe — Chad's settled
// retention decision in the phase-4h brief (PART IX § 4).
const RETENTION_KEEP = 30;

interface WorkerPayload {
  runId?: string;
  resume?: boolean;
}

export const handler: Handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const log = logger.child({ fn: 'scan-target-board-russell2k-background', universe: UNIVERSE });

  let payload: WorkerPayload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch (e: any) {
    log.error('payload_parse_failed', { err: String(e?.message ?? e) });
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid payload json' }) };
  }

  const invocationStart = Date.now();
  const db = getAdminDb();

  const isResume = payload.resume === true && typeof payload.runId === 'string';
  const runId = isResume ? (payload.runId as string) : newRunId(UNIVERSE);

  let cursor: ScanCursor | null = null;
  if (isResume) {
    cursor = await readScanCursor(db, runId);
    if (!cursor) {
      // Stale reinvoke for a run whose terminal write already cleared
      // the cursor. Safe no-op.
      log.info('resume_no_cursor', { runId });
      return { statusCode: 200, body: JSON.stringify({ ok: true, runId, note: 'no cursor; already complete' }) };
    }
  }

  const allTickers = resolveTargetUniverse(UNIVERSE);
  const totalTickers = allTickers.length;

  if (!cursor) {
    cursor = {
      universe: UNIVERSE,
      board: BOARD,
      status: 'running',
      nextTickerIndex: 0,
      totalTickers,
      invocationCount: 1,
      startedAt: new Date().toISOString(),
      lastInvocationStartedAt: new Date().toISOString(),
      partialBatchCount: 0,
      scoredCount: 0,
    };
    await writeScanCursor(db, runId, cursor);
    log.info('scan_started', { runId, universe: UNIVERSE, totalTickers });
  } else {
    cursor = {
      ...cursor,
      invocationCount: cursor.invocationCount + 1,
      lastInvocationStartedAt: new Date().toISOString(),
    };
    log.info('scan_resumed', {
      runId,
      universe: UNIVERSE,
      invocationCount: cursor.invocationCount,
      nextTickerIndex: cursor.nextTickerIndex,
      totalTickers,
    });
  }

  // First-invocation cost: pre-fetch the Polygon company-name cache
  // for the entire universe. Cache-warm on subsequent scans returns
  // in O(reads) with no Polygon calls.
  let nameMap: Record<string, string> = {};
  if (cursor.invocationCount === 1) {
    try {
      nameMap = await enrichTickerNames(allTickers);
      log.info('ticker_name_enrich_complete', { entries: Object.keys(nameMap).length });
    } catch (err: any) {
      log.warn('ticker_name_enrich_failed', { err: String(err?.message ?? err) });
    }
  } else {
    // Resume invocations re-fetch from the cache (it's all hits now).
    try {
      nameMap = await enrichTickerNames(
        allTickers.slice(cursor.nextTickerIndex, totalTickers),
      );
    } catch {
      // best-effort; falls back to in-repo names per-ticker
    }
  }

  // Macro regime — cheap, called once per invocation.
  let macroBias = 0;
  try {
    const regime = await computeRegime();
    macroBias = regimeToMacroBias(regime);
  } catch (err: any) {
    log.warn('regime_compute_failed', { err: String(err?.message ?? err) });
  }

  let watchdogExpired = false;
  const watchdog = createWatchdog(BUDGET_MS, () => {
    watchdogExpired = true;
    log.warn('watchdog_expired', {
      runId,
      invocationCount: cursor!.invocationCount,
      elapsedMs: Date.now() - invocationStart,
    });
  });
  watchdog.start();

  const warnings: string[] = [];
  let batchesThisInvocation = 0;

  let activeCursor: ScanCursor = cursor;
  try {
    while (activeCursor.nextTickerIndex < totalTickers && !watchdog.isExpired()) {
      const batchStart: number = activeCursor.nextTickerIndex;
      const batchResult = await runTargetScanBatch({
        universe: UNIVERSE,
        startIdx: batchStart,
        batchSize: BATCH_SIZE,
        nameMap,
        macroBias,
        logger: log,
      });
      warnings.push(...batchResult.warnings);

      if (batchResult.results.length > 0) {
        await appendPartialBatch<Target>(
          db,
          runId,
          activeCursor.partialBatchCount,
          batchResult.results,
        );
      }

      activeCursor = {
        ...activeCursor,
        nextTickerIndex: batchStart + batchResult.tickersConsumed,
        partialBatchCount:
          activeCursor.partialBatchCount + (batchResult.results.length > 0 ? 1 : 0),
        scoredCount: activeCursor.scoredCount + batchResult.results.length,
      };
      batchesThisInvocation += 1;
      await writeScanCursor(db, runId, activeCursor);
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('batch_loop_failed', { runId, err: msg });
    activeCursor = { ...activeCursor, lastError: msg };
    await writeScanCursor(db, runId, activeCursor);
    watchdog.stop();
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, runId, error: msg }),
    };
  } finally {
    watchdog.stop();
  }
  cursor = activeCursor;

  const elapsedMs = Date.now() - invocationStart;

  // Terminal batch: assemble the full snapshot.
  if (cursor.nextTickerIndex >= totalTickers) {
    log.info('scan_terminal_batch', {
      runId,
      invocationCount: cursor.invocationCount,
      batchesThisInvocation,
      totalScored: cursor.scoredCount,
      totalTickers,
    });

    const allResults = await readAllPartialBatches<Target>(db, runId);
    allResults.sort((a, b) => b.composite - a.composite);

    const { snapshotId } = await writeSnapshot(BOARD, STORE_KEY, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - new Date(cursor.startedAt).getTime(),
      universeChecked: totalTickers,
      results: allResults,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS[BOARD],
      warnings,
    });

    await clearScanCursor(db, runId, 'done');

    // Best-effort cleanup of the partial subcollection + history pruning.
    try {
      const { deleted } = await deletePartialBatches(db, runId);
      log.info('partial_subcollection_cleaned', { runId, deleted });
    } catch (err: any) {
      log.warn('partial_cleanup_failed', { runId, err: String(err?.message ?? err) });
    }
    try {
      const { deleted, kept } = await pruneOldSnapshots(BOARD, STORE_KEY, RETENTION_KEEP);
      log.info('snapshot_retention_pruned', { universe: STORE_KEY, deleted, kept });
    } catch (err: any) {
      log.warn('snapshot_retention_prune_failed', { err: String(err?.message ?? err) });
    }

    log.info('scan_complete', {
      runId,
      snapshotId,
      resultsCount: allResults.length,
      totalTickers,
      invocationCount: cursor.invocationCount,
      scanWallClockMs: Date.now() - new Date(cursor.startedAt).getTime(),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        runId,
        snapshotId,
        resultsCount: allResults.length,
        invocationCount: cursor.invocationCount,
      }),
    };
  }

  // Non-terminal — checkpoint and reinvoke.
  log.info('scan_batch_continuing', {
    runId,
    invocationCount: cursor.invocationCount,
    nextTickerIndex: cursor.nextTickerIndex,
    totalTickers,
    scoredCount: cursor.scoredCount,
    batchesThisInvocation,
    invocationElapsedMs: elapsedMs,
    watchdogExpired,
  });

  const headers: Record<string, string | undefined> = {};
  if (event.headers) {
    for (const [k, v] of Object.entries(event.headers)) {
      headers[k] = v ?? undefined;
    }
  }
  const reinvokeUrl = inferFunctionUrl(
    headers,
    '/.netlify/functions/scan-target-board-russell2k-background',
  );

  const reinvokeCtx: ReinvokeContext = context as unknown as ReinvokeContext;
  const dispatched = await dispatchReinvoke(reinvokeUrl, runId, reinvokeCtx);

  if (!dispatched.ok) {
    cursor = { ...cursor, lastReinvokeError: dispatched.error };
    await writeScanCursor(db, runId, cursor);
    log.error('reinvoke_dispatch_failed', { runId, err: dispatched.error });
  }

  return {
    statusCode: 202,
    body: JSON.stringify({
      ok: true,
      runId,
      continuing: true,
      invocationCount: cursor.invocationCount,
      nextTickerIndex: cursor.nextTickerIndex,
      totalTickers,
    }),
  };
};

function newRunId(universe: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `target-board-${universe}-${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

// Exposed for tests.
export const _internals = { BUDGET_MS, BATCH_SIZE, RETENTION_KEEP, newRunId };
