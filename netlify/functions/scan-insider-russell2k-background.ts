// Phase 4l W2 — checkpoint-resume background worker for russell2k insider scan.
//
// The scheduled trigger (`scan-insider-russell2k.ts`, cron `30 21 * *
// 1-5`) POSTs the initial invocation. Each invocation:
//   1. Reads `insiderScanRuns/{runId}` for an existing cursor; resumes
//      if present, else starts fresh.
//   2. Loops `runInsiderScanBatch` BATCH_SIZE tickers at a time. Each
//      batch fetches Finnhub insider transactions, optionally enriches
//      with Polygon prices + EDGAR roles, and writes scored rows to
//      the partial subcollection. The cursor advances after each
//      batch.
//   3. Breaks the loop when the 13-min watchdog trips; self-reinvokes
//      via `Context.waitUntil(fetch(...))` to continue in a fresh
//      container.
//   4. On the terminal batch: reads back every partial doc, sorts,
//      writes ONE snapshot via `writeSnapshot`, advances the `_latest`
//      pointer atomically, prunes runs/ to the most recent 30, deletes
//      the partial subcollection.
//
// The previous complete snapshot stays served at `_latest` for the
// entire scan duration; only the terminal batch's writeSnapshot flips
// the pointer. A failed mid-scan leaves the last good snapshot
// untouched. This mirrors Phase 4h's russell2k target-board worker —
// identical machinery, different per-batch payload.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';
import { MODEL_VERSION } from './shared/model-version';
import {
  runInsiderScanBatch,
  resolveInsiderUniverse,
  INSIDER_SCHEDULED_WINDOW_DAYS,
  type InsiderUniverseKey,
} from './shared/scan-insider';
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
import type { InsiderBoardRow } from './shared/types';

const UNIVERSE: InsiderUniverseKey = 'russell2k';
const STORE_KEY: UniverseKey = 'russell2k';
const BOARD = 'insider';

// 13-min wall-clock budget leaves 90s margin under Netlify's 15-min
// background-function kill ceiling.
const BUDGET_MS = Number(process.env.INSIDER_SCAN_BUDGET_MS ?? 13 * 60_000);
// Batch granularity. Insider per-ticker work is a single Finnhub call
// (~200-400ms) + optional Polygon price (~200ms) + optional EDGAR role
// enrichment (~500ms for the top buyer). At concurrency 8 a 50-ticker
// batch runs ~6-8s; ~100 batches before the watchdog fires.
const BATCH_SIZE = Number(process.env.INSIDER_SCAN_BATCH_SIZE ?? 50);
const CONCURRENCY = Number(process.env.INSIDER_SCAN_CONCURRENCY ?? 8);
// Retention identical to Phase 4h's russell2k target-board worker.
const RETENTION_KEEP = 30;

interface WorkerPayload {
  runId?: string;
  resume?: boolean;
}

export const handler: Handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const log = logger.child({ fn: 'scan-insider-russell2k-background', universe: UNIVERSE });

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
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, runId, note: 'no cursor; already complete' }),
      };
    }
  }

  const allTickers = resolveInsiderUniverse(UNIVERSE);
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
      const batchResult = await runInsiderScanBatch({
        universe: UNIVERSE,
        windowDays: INSIDER_SCHEDULED_WINDOW_DAYS,
        startIdx: batchStart,
        batchSize: BATCH_SIZE,
        concurrency: CONCURRENCY,
        enrichRoles: true,
        enrichPrice: true,
        logger: log,
      });
      warnings.push(...batchResult.warnings);

      if (batchResult.rows.length > 0) {
        await appendPartialBatch<InsiderBoardRow>(
          db,
          runId,
          activeCursor.partialBatchCount,
          batchResult.rows,
        );
      }

      activeCursor = {
        ...activeCursor,
        nextTickerIndex: batchStart + batchResult.tickersConsumed,
        partialBatchCount:
          activeCursor.partialBatchCount + (batchResult.rows.length > 0 ? 1 : 0),
        scoredCount: activeCursor.scoredCount + batchResult.rows.length,
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
    return { statusCode: 500, body: JSON.stringify({ ok: false, runId, error: msg }) };
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

    const allRows = await readAllPartialBatches<InsiderBoardRow>(db, runId);
    // Sort to match runInsiderScan's invariant: buyDollars desc,
    // awardDollars desc tiebreaker.
    allRows.sort((a, b) => {
      if (a.buyDollars !== b.buyDollars) return b.buyDollars - a.buyDollars;
      return b.awardDollars - a.awardDollars;
    });

    const { snapshotId } = await writeSnapshot(BOARD, STORE_KEY, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - new Date(cursor.startedAt).getTime(),
      universeChecked: totalTickers,
      results: allRows,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS[BOARD],
      warnings,
    });

    await clearScanCursor(db, runId, 'done');

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
      resultsCount: allRows.length,
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
        resultsCount: allRows.length,
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
    '/.netlify/functions/scan-insider-russell2k-background',
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
  return `insider-${universe}-${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

// Exposed for tests.
export const _internals = { BUDGET_MS, BATCH_SIZE, RETENTION_KEEP, newRunId };
