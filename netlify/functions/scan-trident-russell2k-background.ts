// TRIDENT russell2k — CHECKPOINT-RESUME background worker (the #95-97
// house pattern for every Russell-2000 board).
//
// The single-container version died docless four times on 2026-07-18:
// 1,928 names × per-ticker provider fetches do not fit one 15-min
// container, exactly as insider/lynch/catalyst/target r2k learned before
// it. Each invocation: read cursor → process ticker batches under a
// 12.5-min watchdog → append slim rows to the partial subcollection →
// checkpoint cursor → self-reinvoke. Terminal step gets its own fresh
// container: read partials → fresh regime → demotion + percentiles →
// writeSnapshot → clear cursor.

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import {
  readScanCursor,
  writeScanCursor,
  clearScanCursor,
  appendPartialBatch,
  readAllPartialBatches,
  deletePartialBatches,
  getCursorPhase,
  type ScanCursor,
} from './shared/scan-resume/cursor';
import {
  dispatchFinalizingReinvoke,
} from './shared/scan-resume/finalize';
import { createWatchdog } from './shared/backtest-resume/watchdog';
import {
  dispatchReinvoke,
  inferFunctionUrl,
  type ReinvokeContext,
} from './shared/backtest-resume/reinvoke';
import {
  runTridentBatch,
  fetchTridentContext,
  finalizeTridentRows,
  type TridentBatchResult,
} from './shared/trident/scan-trident';
import { inIndex } from './shared/universe';
import {
  writeSnapshot,
  assessSnapshotPublish,
  FRESHNESS_BUDGETS_MS,
} from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

const UNIVERSE = 'russell2k' as const;
const BUDGET_MS = 12.5 * 60_000;
const BATCH_SIZE = 40;
const CONCURRENCY = 8;

type SlimRow = TridentBatchResult['rows'][number];

interface Payload {
  runId?: string;
  resume?: boolean;
}

export const handler: Handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const db = getAdminDb();
  const log = logger.child({ fn: 'scan-trident-russell2k-background', universe: UNIVERSE });
  const invocationStart = Date.now();

  let payload: Payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    /* fresh start */
  }

  const totalTickers = inIndex(UNIVERSE).length;
  const isResume = payload.resume === true && typeof payload.runId === 'string';
  let runId = isResume ? (payload.runId as string) : `trident-r2k-${Date.now()}`;

  let cursor: ScanCursor | null = null;
  if (isResume) {
    cursor = await readScanCursor(db, runId);
    if (!cursor) {
      log.info('resume_no_cursor', { runId });
      return { statusCode: 200, body: JSON.stringify({ ok: true, runId, note: 'no cursor; already complete' }) };
    }
  } else {
    // Guard: if a live chain exists, don't start a competitor — resume it.
    const existing = await readScanCursor(db, 'trident-r2k-live');
    if (existing && existing.status === 'running') {
      const ageMs = Date.now() - Date.parse(existing.lastInvocationStartedAt);
      if (ageMs < 20 * 60_000) {
        log.info('live_chain_exists_skipping', { ageMs });
        return { statusCode: 200, body: JSON.stringify({ ok: true, note: 'chain already running' }) };
      }
      // Stale chain — take it over.
      runId = 'trident-r2k-live';
      cursor = existing;
    }
  }

  if (!cursor) {
    runId = 'trident-r2k-live'; // single stable id: partials + cursor per run
    // Clear any leftovers from a prior completed/stale run.
    await deletePartialBatches(db, runId).catch(() => {});
    cursor = {
      universe: UNIVERSE,
      board: 'trident',
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
    log.info('scan_started', { runId, totalTickers });
  } else {
    cursor = {
      ...cursor,
      invocationCount: cursor.invocationCount + 1,
      lastInvocationStartedAt: new Date().toISOString(),
    };
    log.info('scan_resumed', {
      runId,
      invocationCount: cursor.invocationCount,
      nextTickerIndex: cursor.nextTickerIndex,
      phase: getCursorPhase(cursor),
    });
  }

  // Terminal step in its own invocation (fresh platform budget).
  if (getCursorPhase(cursor) === 'finalizing') {
    await writeScanCursor(db, runId, cursor);
    return await runTerminalStep(db, log, runId, cursor);
  }

  let watchdogExpired = false;
  const watchdog = createWatchdog(BUDGET_MS, () => {
    watchdogExpired = true;
    log.warn('watchdog_expired', { runId, invocationCount: cursor!.invocationCount });
  });
  watchdog.start();

  // Benchmark bars once per invocation (IWM, cached upstream by Polygon speed).
  let benchBars: Awaited<ReturnType<typeof fetchTridentContext>>['benchBars'] = [];
  try {
    benchBars = (await fetchTridentContext(UNIVERSE)).benchBars;
  } catch {
    /* RS components go neutral */
  }

  let activeCursor: ScanCursor = cursor;
  try {
    while (activeCursor.nextTickerIndex < totalTickers && !watchdog.isExpired()) {
      const startIdx = activeCursor.nextTickerIndex;
      const batch = await runTridentBatch({
        universe: UNIVERSE,
        startIdx,
        batchSize: BATCH_SIZE,
        concurrency: CONCURRENCY,
        benchBars,
        logger: log,
      });
      if (batch.rows.length > 0) {
        await appendPartialBatch<SlimRow>(db, runId, activeCursor.partialBatchCount, batch.rows);
      }
      activeCursor = {
        ...activeCursor,
        nextTickerIndex: startIdx + batch.tickersConsumed,
        partialBatchCount: activeCursor.partialBatchCount + (batch.rows.length > 0 ? 1 : 0),
        scoredCount: activeCursor.scoredCount + batch.rows.length,
      };
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

  const headers: Record<string, string | undefined> = {};
  if (event.headers) for (const [k, v] of Object.entries(event.headers)) headers[k] = v ?? undefined;
  const reinvokeUrl = inferFunctionUrl(headers, '/.netlify/functions/scan-trident-russell2k-background');
  const reinvokeCtx: ReinvokeContext = context as unknown as ReinvokeContext;

  if (cursor.nextTickerIndex >= totalTickers) {
    log.info('walk_complete_dispatching_finalizing', {
      runId, scored: cursor.scoredCount, elapsedMs: Date.now() - invocationStart,
    });
    const { dispatched } = await dispatchFinalizingReinvoke({ db, runId, cursor, reinvokeUrl, ctx: reinvokeCtx });
    if (!dispatched.ok) log.error('finalizing_dispatch_failed', { runId, err: dispatched.error });
    return { statusCode: 202, body: JSON.stringify({ ok: true, runId, continuing: true, phase: 'finalizing' }) };
  }

  cursor = {
    ...cursor,
    lastReinvokeAt: new Date().toISOString(),
    reinvokeAttempts: (cursor.reinvokeAttempts ?? 0) + 1,
  };
  await writeScanCursor(db, runId, cursor);
  const dispatched = await dispatchReinvoke(reinvokeUrl, runId, reinvokeCtx);
  if (!dispatched.ok) {
    cursor = { ...cursor, lastReinvokeError: dispatched.error };
    await writeScanCursor(db, runId, cursor);
    log.error('reinvoke_dispatch_failed', { runId, err: dispatched.error });
  }
  return {
    statusCode: 202,
    body: JSON.stringify({
      ok: true, runId, continuing: true,
      invocationCount: cursor.invocationCount,
      nextTickerIndex: cursor.nextTickerIndex,
      totalTickers,
    }),
  };
};

async function runTerminalStep(
  db: FirebaseFirestore.Firestore,
  log: ReturnType<typeof logger.child>,
  runId: string,
  cursor: ScanCursor,
) {
  const raw = await readAllPartialBatches<SlimRow>(db, runId);
  const { regime } = await fetchTridentContext(UNIVERSE);
  const rows = finalizeTridentRows(raw, regime, UNIVERSE);

  let status: 'complete' | 'partial' = 'complete';
  const warnings: string[] = [];
  const decision = assessSnapshotPublish({
    resultCount: rows.length,
    universeChecked: cursor.nextTickerIndex,
  });
  if (decision.action === 'skip') {
    status = 'partial';
    warnings.push(`publish guard: ${decision.reason}`);
  }

  const { snapshotId, promotedToLatest } = await writeSnapshot('trident', 'russell2k', {
    modelVersion: MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - Date.parse(cursor.startedAt),
    universeChecked: cursor.nextTickerIndex,
    universeSize: cursor.totalTickers,
    results: rows,
    freshnessBudgetMs: FRESHNESS_BUDGETS_MS.trident,
    warnings,
    status,
    regime,
    stage1Survivors: rows.length,
  } as any);

  await deletePartialBatches(db, runId).catch(() => {});
  await clearScanCursor(db, runId).catch(() => {});

  log.info('terminal_complete', {
    runId, snapshotId, status, promotedToLatest,
    rows: rows.length, invocations: cursor.invocationCount,
  });
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, runId, snapshotId, status, rows: rows.length }),
  };
}
