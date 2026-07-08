// Checkpoint-resume background worker for the sp500 catalyst scan.
//
// Why this exists: catalyst is the heaviest board (4 providers/ticker).
// PR #66 (2026-06-03) expanded sp500 208→503; the old single-shot
// `scan-catalyst-sp500` then exceeded Netlify's 15-min background-container
// ceiling and wrote NO snapshot from 2026-06-03 onward (catalyst/sp500
// went 14d stale → /api/health 503). This worker brings sp500 catalyst
// onto the checkpoint-resume machinery the russell2k insider/target scans
// already use to survive full-index sizes.
//
// The scheduled trigger (`scan-catalyst-sp500.ts`) POSTs the initial
// invocation. Each invocation batches `runCatalystScanBatch`, checkpoints a
// Firestore cursor, and self-reinvokes until the walk completes; a
// dedicated finalizing invocation reads back the partials, sorts by
// composite desc, writes ONE snapshot, and atomically swaps `_latest`.
// Adapted from scan-insider-russell2k-background.ts — catalyst per-batch
// function + pick shape; provider-null skips surface as a warning but do
// NOT trip the publish guard's failure-rate branch (small-universe catalyst
// runs routinely skip many tickers on transient Quiver gaps).

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';
import { MODEL_VERSION } from './shared/model-version';
import {
  runCatalystScanBatch,
  resolveCatalystUniverse,
  type CatalystUniverseKey,
  type CatalystPick,
} from './shared/scan-catalyst';
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

const UNIVERSE: CatalystUniverseKey = 'sp500';
const STORE_KEY: UniverseKey = 'sp500';
const BOARD = 'catalyst';
const WORKER_PATH = '/.netlify/functions/scan-catalyst-sp500-background';

const BUDGET_MS = Number(process.env.CATALYST_SCAN_BUDGET_MS ?? 13 * 60_000);
// Catalyst per-ticker work is 3 Quiver calls + a Polygon bars fetch + local
// setup detection. 40 keeps each batch inside the watchdog window.
const BATCH_SIZE = Number(process.env.CATALYST_SCAN_BATCH_SIZE ?? 40);
const CONCURRENCY = Number(process.env.CATALYST_SCAN_CONCURRENCY ?? 8);
const RETENTION_KEEP = 30;

interface WorkerPayload {
  runId?: string;
  resume?: boolean;
}

export const handler: Handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const log = logger.child({ fn: 'scan-catalyst-sp500-background', universe: UNIVERSE });

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
      log.info('resume_no_cursor', { runId });
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, runId, note: 'no cursor; already complete' }),
      };
    }
  }

  const allTickers = resolveCatalystUniverse(UNIVERSE);
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
      const batchResult = await runCatalystScanBatch({
        universe: UNIVERSE,
        startIdx: batchStart,
        batchSize: BATCH_SIZE,
        concurrency: CONCURRENCY,
        logger: log,
      });
      warnings.push(...batchResult.warnings);

      if (batchResult.picks.length > 0) {
        await appendPartialBatch<CatalystPick>(
          db,
          runId,
          activeCursor.partialBatchCount,
          batchResult.picks,
        );
      }

      activeCursor = {
        ...activeCursor,
        nextTickerIndex: batchStart + batchResult.tickersConsumed,
        partialBatchCount:
          activeCursor.partialBatchCount + (batchResult.picks.length > 0 ? 1 : 0),
        scoredCount: activeCursor.scoredCount + batchResult.picks.length,
        apiCalls: (activeCursor.apiCalls ?? 0) + batchResult.tickersConsumed,
        // apiErrors carries provider-null skips for the terminal warning
        // ONLY — it is NOT fed to the publish guard's failure-rate branch.
        apiErrors: (activeCursor.apiErrors ?? 0) + batchResult.providerNullSkips,
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

  const headers: Record<string, string | undefined> = {};
  if (event.headers) {
    for (const [k, v] of Object.entries(event.headers)) {
      headers[k] = v ?? undefined;
    }
  }
  const reinvokeUrl = inferFunctionUrl(headers, WORKER_PATH);
  const reinvokeCtx: ReinvokeContext = context as unknown as ReinvokeContext;

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

  const allRows = await readAllPartialBatches<CatalystPick>(db, runId);
  allRows.sort((a, b) => b.composite - a.composite);

  // Failure-rate branch intentionally disabled (totalCalls/errors = 0):
  // catalyst routinely skips many tickers on transient provider gaps, so
  // only the empty-universe guard applies (don't overwrite _latest with a
  // fully-empty scan).
  const decision = assessSnapshotPublish({
    resultCount: allRows.length,
    universeChecked: totalTickers,
    totalCalls: 0,
    rateLimitedCalls: 0,
    errorCalls: 0,
  });
  log.info('publish_guard_decision', {
    runId,
    action: decision.action,
    reason: decision.reason,
    resultCount: allRows.length,
    universeChecked: totalTickers,
    providerNullSkips: cursor.apiErrors ?? 0,
  });

  if ((cursor.apiErrors ?? 0) > 0) {
    warnings.push(
      `provider data unavailable (insider/political/contracts) for ${cursor.apiErrors} tickers — skipped, not scored as neutral`,
    );
  }

  let snapshotId: string | null = null;
  if (decision.action === 'skip') {
    log.warn('publish_guard_skip', { runId, reason: decision.reason });
    await clearScanCursor(db, runId, 'error', {
      publishAction: decision.action,
      publishReason: decision.reason ?? null,
    });
  } else {
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
      truncated: sized.truncated ? true : undefined,
      originalResultCount: sized.truncated ? sized.originalCount : undefined,
    });
    snapshotId = written.snapshotId;
    await clearScanCursor(db, runId, 'done', {
      publishAction: decision.action,
      publishReason: decision.reason ?? null,
    });
  }

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
  return `catalyst-${universe}-${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

// Exposed for tests.
export const _internals = { BUDGET_MS, BATCH_SIZE, RETENTION_KEEP, newRunId };
