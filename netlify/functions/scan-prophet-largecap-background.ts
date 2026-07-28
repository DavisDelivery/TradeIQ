// Prophet Large Cap snapshot scan — CHECKPOINT-RESUME background worker.
//
// WHY THIS WAS REWRITTEN (2026-07-28). The single-shot version could no longer
// finish the universe, and the symptom was invisible in the worst possible
// way: the board served FIVE-DAY-OLD data behind a "stale fallback" banner
// while newer snapshots sat unused in Firestore.
//
// The chain, measured on prod:
//   1. Largecap grew from a curated ~208 names to the full S&P500 ∪ NDX ∪ Dow
//      union (~508). An earlier patch raised concurrency 7 → 12 to bring the
//      run from ~16 min back to ~10; provider degradation has since eaten that
//      margin (the 07-27 snapshot also warns of unavailable catalyst data).
//   2. Every run now trips the 14-min budget mid-universe and stamps
//      `status: 'partial'` — 47 picks scored out of 508.
//   3. writeSnapshot REFUSES to promote a partial into `_latest` (correct: a
//      fragment must never replace a complete board), so `_latest` froze on
//      2026-07-23 while runs/ kept accumulating 07-24 and 07-27.
//   4. The board reads `_latest` → 117h stale, indefinitely, no self-healing.
//
// Raising concurrency again is the fix that already regressed once. The
// durable answer is the pattern the insider/target/lynch scans adopted for the
// IDENTICAL universe-growth failure (PRs #95/#96/#97): walk the universe in
// batches across self-reinvoking containers, checkpointing a cursor, then
// publish ONE complete snapshot from the terminal invocation. The previous
// complete snapshot stays canonical for the whole scan; only the terminal
// write swaps `_latest`.
//
// The per-batch scoring seam is `runProphetScan`'s existing `explicitTickers`
// override (already used by the sieve's Stage 3), so the scoring math is
// untouched — only WHEN it runs changes. The manual trigger worker still uses
// the single-shot runner; it is operator-invoked and bounded by its own gate.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';
import { runProphetScan, resolveProphetUniverse, type ProphetPick } from './shared/scan-prophet';
import { publishProphetSnapshot } from './shared/prophet-snapshot-runner';
import type { UniverseKey } from './shared/snapshot-store';
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

const UNIVERSE = 'largecap' as const;
const STORE_KEY: UniverseKey = 'largecap';
const BOARD = 'prophet';

/** 11-min wall clock leaves margin under the 15-min container ceiling for the
 *  batch in flight plus the checkpoint write and reinvoke dispatch. */
const BUDGET_MS = Number(process.env.PROPHET_SCAN_BUDGET_MS ?? 11 * 60_000);
/** Tickers per batch. Prophet's per-ticker cost is the heaviest of any board
 *  (7-layer ensemble across several providers), so batches stay small enough
 *  that a watchdog trip never strands much work. */
const BATCH_SIZE = Number(process.env.PROPHET_SCAN_BATCH_SIZE ?? 60);
const CONCURRENCY = Number(process.env.PROPHET_SCAN_CONCURRENCY ?? 12);

interface WorkerPayload {
  runId?: string;
  resume?: boolean;
}

export const handler: Handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const log = logger.child({ fn: 'scan-prophet-largecap-background', universe: UNIVERSE });
  const invocationStart = Date.now();
  const db = getAdminDb();

  let payload: WorkerPayload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch (e: any) {
    log.error('payload_parse_failed', { err: String(e?.message ?? e) });
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid payload json' }) };
  }

  const isResume = payload.resume === true && typeof payload.runId === 'string';
  const runId = isResume ? (payload.runId as string) : newRunId();

  let cursor: ScanCursor | null = null;
  if (isResume) {
    cursor = await readScanCursor(db, runId);
    if (!cursor) {
      // Stale reinvoke for a run whose terminal write already cleared the
      // cursor. Safe no-op.
      log.info('resume_no_cursor', { runId });
      return { statusCode: 200, body: JSON.stringify({ ok: true, runId, note: 'already complete' }) };
    }
  }

  // Resolve the universe ONCE and pin it on the run doc: every resumed
  // invocation must walk the identical list or the cursor index means nothing
  // (the same discipline the earnings worker uses for its calendar).
  const runRef = db.collection('scanRuns').doc(runId);
  let tickers: string[];
  if (isResume) {
    const doc = await runRef.get();
    tickers = (doc.data()?.prophetTickers as string[]) ?? [];
    if (tickers.length === 0) {
      log.warn('resume_missing_universe', { runId });
      tickers = resolveProphetUniverse(UNIVERSE).map((t: any) => t.ticker);
    }
  } else {
    tickers = resolveProphetUniverse(UNIVERSE).map((t: any) => t.ticker);
    await runRef.set({ prophetTickers: tickers }, { merge: true });
  }
  const totalTickers = tickers.length;

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
    };
    await writeScanCursor(db, runId, cursor);
    log.info('scan_started', { runId, totalTickers });
  } else {
    cursor = {
      ...cursor,
      invocationCount: cursor.invocationCount + 1,
      lastInvocationStartedAt: new Date().toISOString(),
    };
  }

  // The terminal step gets its own fresh container budget.
  if (getCursorPhase(cursor) === 'finalizing') {
    await writeScanCursor(db, runId, cursor);
    return await runTerminalStep({ db, log, runId, cursor });
  }

  const watchdog = createWatchdog(BUDGET_MS, () => {
    log.warn('watchdog_expired', { runId, elapsedMs: Date.now() - invocationStart });
  });
  watchdog.start();

  let activeCursor: ScanCursor = cursor;
  try {
    while (activeCursor.nextTickerIndex < totalTickers && !watchdog.isExpired()) {
      const startIdx = activeCursor.nextTickerIndex;
      const slice = tickers.slice(startIdx, startIdx + BATCH_SIZE);
      if (slice.length === 0) break;

      const scan = await runProphetScan({
        universe: UNIVERSE,
        explicitTickers: slice,
        // Per-batch budget: whatever remains of this invocation's wall clock.
        scanBudgetMs: Math.max(30_000, BUDGET_MS - (Date.now() - invocationStart)),
        concurrency: CONCURRENCY,
        sufficientQualified: Infinity,
        logger: log,
      });

      if (scan.picks.length > 0) {
        await appendPartialBatch<ProphetPick>(db, runId, activeCursor.partialBatchCount, scan.picks);
      }
      activeCursor = {
        ...activeCursor,
        nextTickerIndex: startIdx + slice.length,
        partialBatchCount: activeCursor.partialBatchCount + (scan.picks.length > 0 ? 1 : 0),
        scoredCount: activeCursor.scoredCount + scan.picks.length,
        warnings: [...(activeCursor.warnings ?? []), ...(scan.warnings ?? [])].slice(-40),
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
  const reinvokeUrl = inferFunctionUrl(headers, '/.netlify/functions/scan-prophet-largecap-background');
  const ctx = context as unknown as ReinvokeContext;

  if (cursor.nextTickerIndex >= totalTickers) {
    log.info('scan_walk_complete', { runId, scored: cursor.scoredCount, totalTickers });
    const { cursor: finalizing, dispatched } = await dispatchFinalizingReinvoke({
      db, runId, cursor, reinvokeUrl, ctx,
    });
    if (!dispatched.ok) log.error('finalizing_dispatch_failed', { runId, err: dispatched.error });
    return {
      statusCode: 202,
      body: JSON.stringify({
        ok: true, runId, continuing: true, phase: 'finalizing',
        invocationCount: finalizing.invocationCount,
      }),
    };
  }

  cursor = {
    ...cursor,
    lastReinvokeAt: new Date().toISOString(),
    reinvokeAttempts: (cursor.reinvokeAttempts ?? 0) + 1,
  };
  await writeScanCursor(db, runId, cursor);
  const dispatched = await dispatchReinvoke(reinvokeUrl, runId, ctx);
  if (!dispatched.ok) {
    await writeScanCursor(db, runId, { ...cursor, lastReinvokeError: dispatched.error });
    log.error('reinvoke_dispatch_failed', { runId, err: dispatched.error });
  }
  return {
    statusCode: 202,
    body: JSON.stringify({
      ok: true, runId, continuing: true,
      nextTickerIndex: cursor.nextTickerIndex, totalTickers,
    }),
  };
};

async function runTerminalStep(args: {
  db: ReturnType<typeof getAdminDb>;
  log: ReturnType<typeof logger.child>;
  runId: string;
  cursor: ScanCursor;
}) {
  const { db, log, runId, cursor } = args;
  const picks = await readAllPartialBatches<ProphetPick>(db, runId);
  picks.sort((a, b) => b.composite - a.composite);

  // The walk covered the whole universe, so this IS a complete scan —
  // budgetExceeded is false by construction. That is the entire point of the
  // port: the old single-shot run could only ever report `partial` here, and a
  // partial never promotes.
  const { snapshotId, promotedToLatest, status } = await publishProphetSnapshot({
    storeKey: STORE_KEY,
    picks,
    universeChecked: cursor.totalTickers,
    scanDurationMs: Date.now() - new Date(cursor.startedAt).getTime(),
    warnings: cursor.warnings ?? [],
    budgetExceeded: false,
    logger: log,
  });

  await clearScanCursor(db, runId, 'done', { publishAction: status });
  try {
    const { deleted } = await deletePartialBatches(db, runId);
    log.info('partial_subcollection_cleaned', { runId, deleted });
  } catch (err: any) {
    log.warn('partial_cleanup_failed', { runId, err: String(err?.message ?? err) });
  }

  log.info('scan_complete', {
    runId, snapshotId, status, promotedToLatest,
    picks: picks.length, totalTickers: cursor.totalTickers,
    invocationCount: cursor.invocationCount,
  });
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, runId, snapshotId, status, promotedToLatest, picks: picks.length }),
  };
}

function newRunId(): string {
  const n = new Date();
  const p = (v: number) => String(v).padStart(2, '0');
  return `prophet-${UNIVERSE}-${n.getUTCFullYear()}${p(n.getUTCMonth() + 1)}${p(n.getUTCDate())}-${p(n.getUTCHours())}${p(n.getUTCMinutes())}${p(n.getUTCSeconds())}`;
}

export const _internals = { BUDGET_MS, BATCH_SIZE, CONCURRENCY, newRunId };
