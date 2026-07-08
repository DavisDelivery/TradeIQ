// Checkpoint-resume background worker for the earnings board scan.
//
// FIX-1 W1 — adapted from `scan-lynch-russell2k-background.ts` (#96),
// which is itself the #95/#97 pattern: the scheduled trigger
// (`scan-earnings.ts`, cron `50 11,23 * * 1-5`) POSTs the initial
// invocation with an empty body. Each invocation:
//   1. Reads `scanRuns/{runId}` for an existing cursor; resumes if
//      present, else starts fresh.
//   2. FRESH START ONLY: resolves the calendar-driven universe ONCE
//      (Finnhub calendar range, paced + 429-retried, watchlist-probe
//      fallback) and persists the resolved entries on the run doc so
//      every resumed invocation walks the SAME universe — the calendar
//      may change between invocations, the run's universe must not.
//      A FAILED calendar resolution ends the run `error` immediately
//      and publishes nothing: the previous good `_latest` stays served.
//      (The pre-FIX-1 monolith published the hollow snapshot instead —
//      that unguarded write is the bug that blanked the earnings board.)
//   3. Loops `runEarningsScanBatch` BATCH_SIZE entries at a time,
//      writing scored setups to the partial subcollection; the cursor
//      advances after each batch. Breaks when the 13-min watchdog
//      trips; self-reinvokes via `Context.waitUntil(fetch(...))`.
//   4. On the terminal (finalizing) invocation: reads back every
//      partial doc, sorts by (date asc, ticker), runs the publish
//      guard, writes ONE snapshot via `writeSnapshot` under the 'all'
//      store key, prunes runs/ to 30, deletes partials. The guard
//      decision is stamped on the run doc (`publishAction` /
//      `publishReason`) so /api/scan-status can explain an `error` run.
//
// The previous complete snapshot stays served at `_latest` for the whole
// scan; only the terminal step's guarded writeSnapshot flips the pointer.
// NO Claude in the scan path (rule-based scoring only).

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';
import { MODEL_VERSION } from './shared/model-version';
import {
  runEarningsScanBatch,
  resolveEarningsScanUniverse,
  EARNINGS_SCHEDULED_WINDOW_DAYS,
  POST_PRINT_LOOKBACK_DAYS,
  type EarningsCalendarEntry,
} from './shared/scan-earnings';
import type { EarningsSetup } from './shared/types';
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

const STORE_KEY: UniverseKey = 'all';
const BOARD = 'earnings';
const UNIVERSE_LABEL = 'all';

// 13-min wall-clock budget leaves 90s margin under Netlify's 15-min
// background-function kill ceiling.
const BUDGET_MS = Number(process.env.EARNINGS_SCAN_BUDGET_MS ?? 13 * 60_000);
// Earnings per-entry work is bars (Polygon) + earnings history (Finnhub,
// paced through the shared token bucket). 40 keeps each batch well
// inside the watchdog window even when the bucket is draining slowly.
const BATCH_SIZE = Number(process.env.EARNINGS_SCAN_BATCH_SIZE ?? 40);
const CONCURRENCY = Number(process.env.EARNINGS_SCAN_CONCURRENCY ?? 10);
const RETENTION_KEEP = 30;

interface WorkerPayload {
  runId?: string;
  resume?: boolean;
}

/** Run-doc field where the fresh-start invocation persists the resolved
 *  calendar universe for resumed invocations to read back. */
const CALENDAR_FIELD = 'calendarEntries';

async function readPersistedCalendar(
  db: ReturnType<typeof getAdminDb>,
  runId: string,
): Promise<EarningsCalendarEntry[] | null> {
  const snap = await db.collection('scanRuns').doc(runId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  const entries = data?.[CALENDAR_FIELD];
  return Array.isArray(entries) ? (entries as EarningsCalendarEntry[]) : null;
}

export const handler: Handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const log = logger.child({ fn: 'scan-earnings-background', universe: UNIVERSE_LABEL });

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
  const runId = isResume ? (payload.runId as string) : newRunId();

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

  const warnings: string[] = [];
  let entries: EarningsCalendarEntry[];

  if (!cursor) {
    // Fresh start — resolve the calendar universe ONCE and persist it.
    const resolution = await resolveEarningsScanUniverse({
      windowDays: EARNINGS_SCHEDULED_WINDOW_DAYS,
      postPrintLookbackDays: POST_PRINT_LOOKBACK_DAYS,
      logger: log,
    });
    warnings.push(...resolution.warnings);
    entries = resolution.entries;

    if (resolution.calendarFailed || entries.length === 0) {
      // Publish guard, applied at the earliest possible point: a failed
      // or empty calendar resolution means there is NOTHING trustworthy
      // to scan. End the run as error with the reason stamped; the
      // previous good `_latest` snapshot stays served.
      const reason = resolution.calendarFailed
        ? `earnings calendar resolution FAILED (${resolution.warnings.join('; ') || 'no detail'}); refusing to scan/publish`
        : 'earnings calendar resolved to 0 entries; nothing to scan, not publishing';
      log.warn('calendar_resolution_unusable', { runId, reason });
      await clearScanCursor(db, runId, 'error', {
        publishAction: 'skip',
        publishReason: reason,
      });
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: false, runId, skipped: true, reason }),
      };
    }

    await db
      .collection('scanRuns')
      .doc(runId)
      .set({ [CALENDAR_FIELD]: entries }, { merge: true });

    cursor = {
      universe: UNIVERSE_LABEL,
      board: BOARD,
      status: 'running',
      phase: 'scanning',
      nextTickerIndex: 0,
      totalTickers: entries.length,
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
    log.info('scan_started', { runId, universe: UNIVERSE_LABEL, totalTickers: entries.length });
  } else {
    const persisted = await readPersistedCalendar(db, runId);
    if (!persisted || persisted.length === 0) {
      const msg = 'resume without persisted calendar entries; failing run';
      log.error('resume_calendar_missing', { runId });
      await clearScanCursor(db, runId, 'error', {
        publishAction: 'skip',
        publishReason: msg,
      });
      return { statusCode: 500, body: JSON.stringify({ ok: false, runId, error: msg }) };
    }
    entries = persisted;
    cursor = {
      ...cursor,
      invocationCount: cursor.invocationCount + 1,
      lastInvocationStartedAt: new Date().toISOString(),
    };
    log.info('scan_resumed', {
      runId,
      universe: UNIVERSE_LABEL,
      invocationCount: cursor.invocationCount,
      nextTickerIndex: cursor.nextTickerIndex,
      totalTickers: cursor.totalTickers,
      phase: getCursorPhase(cursor),
    });
  }

  const totalTickers = cursor.totalTickers;

  // Dedicated terminal-step invocation — the finalizing step gets its own
  // fresh 15-min platform budget.
  if (getCursorPhase(cursor) === 'finalizing') {
    log.info('scan_finalizing_invocation', {
      runId,
      invocationCount: cursor.invocationCount,
      totalScored: cursor.scoredCount,
      totalTickers,
    });
    await writeScanCursor(db, runId, cursor);
    return await runTerminalStep({ db, log, runId, cursor, warnings });
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

  let batchesThisInvocation = 0;
  let activeCursor: ScanCursor = cursor;
  try {
    while (activeCursor.nextTickerIndex < totalTickers && !watchdog.isExpired()) {
      const batchStart: number = activeCursor.nextTickerIndex;
      const batchResult = await runEarningsScanBatch({
        entries,
        startIdx: batchStart,
        batchSize: BATCH_SIZE,
        concurrency: CONCURRENCY,
        logger: log,
      });
      warnings.push(...batchResult.warnings);

      if (batchResult.setups.length > 0) {
        await appendPartialBatch<EarningsSetup>(
          db,
          runId,
          activeCursor.partialBatchCount,
          batchResult.setups,
        );
      }

      activeCursor = {
        ...activeCursor,
        nextTickerIndex: batchStart + batchResult.tickersConsumed,
        partialBatchCount:
          activeCursor.partialBatchCount + (batchResult.setups.length > 0 ? 1 : 0),
        scoredCount: activeCursor.scoredCount + batchResult.setups.length,
        apiCalls: (activeCursor.apiCalls ?? 0) + batchResult.tickersConsumed,
        apiErrors: (activeCursor.apiErrors ?? 0) + batchResult.tickersErrored,
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
  const reinvokeUrl = inferFunctionUrl(
    headers,
    '/.netlify/functions/scan-earnings-background',
  );
  const reinvokeCtx: ReinvokeContext = context as unknown as ReinvokeContext;

  // Universe walk complete — transition to 'finalizing' and reinvoke once
  // more so the terminal step gets its own fresh 15-min platform budget.
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

  // Non-terminal mid-walk — checkpoint and reinvoke.
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

// ====================================================================
// Terminal step — extracted so the finalizing-phase entry branch can
// invoke it with a fresh 15-min platform budget. Idempotent: re-reading
// the partials and re-writing the snapshot for the same runId is safe;
// clearScanCursor runs only at the very end.
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

  const allRows = await readAllPartialBatches<EarningsSetup>(db, runId);
  // Stable presentation order: soonest report date first, then ticker
  // (matches the calendar-driven order the single-pass scan produced).
  allRows.sort((a, b) =>
    a.reportDate === b.reportDate
      ? a.ticker.localeCompare(b.ticker)
      : a.reportDate < b.reportDate
        ? -1
        : 1,
  );

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
  });

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
      degraded: decision.action === 'publish-degraded' ? true : undefined,
      degradedReason:
        decision.action === 'publish-degraded' ? decision.reason : undefined,
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

function newRunId(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `earnings-all-${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

// Exposed for tests.
export const _internals = { BUDGET_MS, BATCH_SIZE, RETENTION_KEEP, newRunId, CALENDAR_FIELD };
