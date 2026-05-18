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
  assessSnapshotPublish,
  trimResultsForDocLimit,
  type UniverseKey,
} from './shared/snapshot-store';
import {
  appendPartialBatch,
  clearScanCursor,
  deletePartialBatches,
  readAllPartialBatches,
  readScanCursor,
  writeScanCursor,
  getCursorPhase,
  type ScanCursor,
} from './shared/scan-resume/cursor';
import { dispatchFinalizingReinvoke } from './shared/scan-resume/finalize';
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
// enrichment (~500ms for the top buyer).
const BATCH_SIZE = Number(process.env.INSIDER_SCAN_BATCH_SIZE ?? 50);
// Phase 4o W1: dropped from 8 to 4. Finnhub's free tier is ~60 calls/min;
// the W1 token bucket paces the steady-state call rate, but a lower
// concurrency keeps the cold-start burst from blowing through the
// bucket's capacity (≈ FINNHUB_RPM) on the first batch and forcing
// every later ticker into 429-retry backoff.
const CONCURRENCY = Number(process.env.INSIDER_SCAN_CONCURRENCY ?? 4);
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
      phase: 'scanning',
      nextTickerIndex: 0,
      totalTickers,
      invocationCount: 1,
      startedAt: new Date().toISOString(),
      lastInvocationStartedAt: new Date().toISOString(),
      partialBatchCount: 0,
      scoredCount: 0,
      apiCalls: 0,
      apiRateLimited: 0,
      apiErrors: 0,
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
      phase: getCursorPhase(cursor),
    });
  }

  // Phase 4p W1 — dedicated terminal-step invocation. See sibling
  // target-board worker for the design rationale (and briefs/phase-4p-brief.md
  // for the diagnostic that proved why the inline terminal step was
  // running out of platform budget).
  if (getCursorPhase(cursor) === 'finalizing') {
    log.info('scan_finalizing_invocation', {
      runId,
      invocationCount: cursor.invocationCount,
      totalScored: cursor.scoredCount,
      totalTickers,
    });
    await writeScanCursor(db, runId, cursor);
    return await runTerminalStep({ db, log, runId, cursor, warnings: [] });
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
        apiCalls: (activeCursor.apiCalls ?? 0) + batchResult.finnhubCalls,
        apiRateLimited: (activeCursor.apiRateLimited ?? 0) + batchResult.finnhubRateLimited,
        apiErrors: (activeCursor.apiErrors ?? 0) + batchResult.finnhubErrors,
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

  // Reinvoke plumbing — shared between the W1 finalizing dispatch and
  // the mid-walk reinvoke.
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

  // Phase 4p W1 — universe walk complete. Transition to 'finalizing'
  // and reinvoke once more so the terminal step gets its own fresh
  // 15-min platform budget. See sibling target-board worker / brief.
  if (cursor.nextTickerIndex >= totalTickers) {
    log.info('scan_walk_complete_dispatching_finalizing', {
      runId,
      invocationCount: cursor.invocationCount,
      batchesThisInvocation,
      totalScored: cursor.scoredCount,
      totalTickers,
      invocationElapsedMs: elapsedMs,
    });
    const { cursor: finalizingCursor, dispatched } = await dispatchFinalizingReinvoke({
      db,
      runId,
      cursor,
      reinvokeUrl,
      ctx: reinvokeCtx,
    });
    if (!dispatched.ok) {
      log.error('finalizing_reinvoke_dispatch_failed', { runId, err: dispatched.error });
    } else {
      log.info('finalizing_reinvoke_dispatched', {
        runId,
        reinvokeAttempts: finalizingCursor.reinvokeAttempts,
      });
    }
    return {
      statusCode: 202,
      body: JSON.stringify({
        ok: true,
        runId,
        continuing: true,
        phase: 'finalizing',
        invocationCount: finalizingCursor.invocationCount,
        nextTickerIndex: finalizingCursor.nextTickerIndex,
        totalTickers,
      }),
    };
  }

  // Non-terminal mid-walk — checkpoint and reinvoke (unchanged 4l/4o behavior).
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

  // Phase 4o W2 — stamp reinvoke attempt to the cursor before dispatch.
  // See sibling target-board worker for the reasoning.
  cursor = {
    ...cursor,
    lastReinvokeAt: new Date().toISOString(),
    reinvokeAttempts: (cursor.reinvokeAttempts ?? 0) + 1,
  };
  await writeScanCursor(db, runId, cursor);
  log.info('reinvoke_dispatching', { runId, reinvokeUrl, reinvokeAttempts: cursor.reinvokeAttempts });

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

// ====================================================================
// Phase 4p W1 — terminal step, extracted so the finalizing-phase entry
// branch can invoke it with a fresh 15-min platform budget.
//
// W2 idempotency: same contract as the target-board sibling — re-reading
// the partials and re-writing the snapshot for the same runId is safe;
// clearScanCursor runs only at the very end, so a killed-and-retried
// finalizing invocation simply redoes the work and completes.
// ====================================================================

interface TerminalStepArgs {
  db: ReturnType<typeof getAdminDb>;
  log: ReturnType<typeof logger.child>;
  runId: string;
  cursor: ScanCursor;
  warnings: string[];
}

async function runTerminalStep(args: TerminalStepArgs) {
  const { db, log, runId, cursor } = args;
  const warnings = [...args.warnings];
  const totalTickers = cursor.totalTickers;

  log.info('scan_terminal_step_start', {
    runId,
    invocationCount: cursor.invocationCount,
    totalScored: cursor.scoredCount,
    totalTickers,
    phase: getCursorPhase(cursor),
  });

  const allRows = await readAllPartialBatches<InsiderBoardRow>(db, runId);
  // Sort to match runInsiderScan's invariant: buyDollars desc,
  // awardDollars desc tiebreaker.
  allRows.sort((a, b) => {
    if (a.buyDollars !== b.buyDollars) return b.buyDollars - a.buyDollars;
    return b.awardDollars - a.awardDollars;
  });

  // Phase 4o W3 — degraded-publish guard. Fed the ORIGINAL row count.
  const decision = assessSnapshotPublish({
    resultCount: allRows.length,
    universeChecked: totalTickers,
    totalCalls: cursor.apiCalls ?? 0,
    rateLimitedCalls: cursor.apiRateLimited ?? 0,
    errorCalls: cursor.apiErrors ?? 0,
  });
  log.info('publish_guard_decision', {
    runId,
    action: decision.action,
    reason: decision.reason,
    resultCount: allRows.length,
    universeChecked: totalTickers,
    apiCalls: cursor.apiCalls,
    apiRateLimited: cursor.apiRateLimited,
    apiErrors: cursor.apiErrors,
  });

  if ((cursor.apiRateLimited ?? 0) > 0) {
    warnings.push(
      `finnhub rate-limit exhausted on ${cursor.apiRateLimited}/${cursor.apiCalls} tickers`,
    );
  }
  if ((cursor.apiErrors ?? 0) > 0) {
    warnings.push(
      `finnhub errors on ${cursor.apiErrors}/${cursor.apiCalls} tickers`,
    );
  }

  let snapshotId: string | null = null;
  if (decision.action === 'skip') {
    log.warn('publish_guard_skip', { runId, reason: decision.reason });
    await clearScanCursor(db, runId, 'error');
  } else {
    // Phase 4p W2 — size safety. InsiderBoardRow's `filings` array can
    // be fat for a high-activity ticker; combined with up to ~hundreds
    // of rows on the russell2k board this can approach the 1 MiB
    // Firestore ceiling. Truncate by sorted order (highest buyDollars
    // first) and flag the snapshot if we had to.
    const sized = trimResultsForDocLimit(allRows);
    if (sized.truncated) {
      log.warn('snapshot_truncated_for_doc_limit', {
        runId,
        originalCount: sized.originalCount,
        storedCount: sized.storedCount,
        estimatedBytes: sized.estimatedBytes,
      });
      warnings.push(
        `snapshot results truncated for doc-size safety: ${sized.storedCount}/${sized.originalCount} rows kept (~${sized.estimatedBytes} bytes)`,
      );
    }

    const written = await writeSnapshot(BOARD, STORE_KEY, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - new Date(cursor.startedAt).getTime(),
      universeChecked: totalTickers,
      results: sized.results,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS[BOARD],
      warnings,
      degraded: decision.action === 'publish-degraded' ? true : undefined,
      degradedReason:
        decision.action === 'publish-degraded' ? decision.reason : undefined,
      truncated: sized.truncated ? true : undefined,
      originalResultCount: sized.truncated ? sized.originalCount : undefined,
    });
    snapshotId = written.snapshotId;
    await clearScanCursor(db, runId, 'done');
  }

  // Partial-batch cleanup runs whether or not we published — the
  // partials are just scratch space for this run; nothing else reads
  // them once the terminal step has assembled the full row list.
  try {
    const { deleted } = await deletePartialBatches(db, runId);
    log.info('partial_subcollection_cleaned', { runId, deleted });
  } catch (err: any) {
    log.warn('partial_cleanup_failed', { runId, err: String(err?.message ?? err) });
  }
  if (snapshotId !== null) {
    try {
      const { deleted, kept } = await pruneOldSnapshots(BOARD, STORE_KEY, RETENTION_KEEP);
      log.info('snapshot_retention_pruned', { universe: STORE_KEY, deleted, kept });
    } catch (err: any) {
      log.warn('snapshot_retention_prune_failed', { err: String(err?.message ?? err) });
    }
  }

  log.info('scan_complete', {
    runId,
    snapshotId,
    resultsCount: allRows.length,
    totalTickers,
    invocationCount: cursor.invocationCount,
    scanWallClockMs: Date.now() - new Date(cursor.startedAt).getTime(),
    publishAction: decision.action,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      runId,
      snapshotId,
      resultsCount: allRows.length,
      invocationCount: cursor.invocationCount,
      publishAction: decision.action,
      publishReason: decision.reason,
    }),
  };
}

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
