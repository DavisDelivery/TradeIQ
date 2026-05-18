// Phase 4p W1 + W3 — shared helpers for the dedicated finalizing
// reinvocation and for stuck-run recovery.
//
// W1: the bg-worker no longer crams the terminal step into the tail of
// the last batch-processing invocation. When the cursor reaches the end
// of the universe, the worker stamps `phase: 'finalizing'` and dispatches
// one more self-reinvoke. The next invocation reads the finalizing cursor,
// skips the batch loop, and runs only the terminal step — with a fresh
// full 15-min platform budget. See briefs/phase-4p-brief.md for the
// /api/scan-status diagnostic that pinned this exact failing step.
//
// W3: in production, two russell2k runs sit frozen `status: running`
// since 2026-05-17 / 2026-05-18 — the old terminal-step starvation. The
// scheduled trigger calls `recoverStuckRuns` BEFORE dispatching a fresh
// scan: any `running` run whose `updatedAt` is older than the platform
// kill ceiling is, by definition, dead. We mark it `error` so it stops
// polluting /api/scan-status; the fresh scan starts unblocked. (We
// could also re-fire stale finalizing runs — W2 idempotency makes that
// safe — but a fresh scan covers the same data with cleaner state, so
// for now we just clean up.)

import type { Firestore } from 'firebase-admin/firestore';
import {
  readScanCursor,
  writeScanCursor,
  clearScanCursor,
  type ScanCursor,
} from './cursor';
import {
  dispatchReinvoke,
  type ReinvokeContext,
} from '../backtest-resume/reinvoke';

/**
 * A `status: 'running'` run whose `updatedAt` is older than this is
 * presumed dead — the Netlify background-function ceiling is 15 min, so
 * a 30-min idle window means even the watchdog + reinvoke chain has had
 * time to land or fail visibly. Override via env for tests.
 */
export const STALE_RUN_THRESHOLD_MS = Number(
  process.env.SCAN_STALE_RUN_THRESHOLD_MS ?? 30 * 60_000,
);

/**
 * Pure transition: bump the cursor to the finalizing phase and stamp
 * the reinvoke-attempt accounting. Caller persists + dispatches.
 */
export function transitionCursorToFinalizing(cursor: ScanCursor): ScanCursor {
  return {
    ...cursor,
    phase: 'finalizing',
    lastReinvokeAt: new Date().toISOString(),
    reinvokeAttempts: (cursor.reinvokeAttempts ?? 0) + 1,
  };
}

export interface DispatchFinalizingReinvokeArgs {
  db: Firestore;
  runId: string;
  cursor: ScanCursor;
  reinvokeUrl: string;
  ctx: ReinvokeContext;
}

export interface DispatchFinalizingReinvokeResult {
  /** The updated cursor that was persisted (with phase=finalizing + reinvoke stamps). */
  cursor: ScanCursor;
  /** Outcome of the fetch-side dispatch. */
  dispatched: { ok: boolean; error?: string };
}

/**
 * Stamp `phase: 'finalizing'` on the cursor, persist it, and dispatch
 * the dedicated-terminal-step reinvoke. On dispatch failure the cursor
 * gets a `lastReinvokeError` stamp so the post-mortem in /api/scan-status
 * is unambiguous.
 *
 * The persist-then-dispatch order matters: the cursor must be observable
 * as `finalizing` before any retry-loop reaches the next invocation, so
 * the next entry can branch into the terminal-only path.
 */
export async function dispatchFinalizingReinvoke(
  args: DispatchFinalizingReinvokeArgs,
): Promise<DispatchFinalizingReinvokeResult> {
  const { db, runId, ctx, reinvokeUrl } = args;
  let cursor = transitionCursorToFinalizing(args.cursor);
  await writeScanCursor(db, runId, cursor);

  const dispatched = await dispatchReinvoke(reinvokeUrl, runId, ctx);
  if (!dispatched.ok) {
    cursor = { ...cursor, lastReinvokeError: dispatched.error };
    await writeScanCursor(db, runId, cursor);
  }
  return { cursor, dispatched };
}

/**
 * Phase 4p W3 — stuck-run recovery.
 *
 * Scan `scanRuns` for runs matching `<runIdPrefix>*` (e.g.
 * `'target-board-russell2k-'`) whose `status === 'running'` and whose
 * `updatedAt` is older than `staleThresholdMs`. Mark each as `error`
 * and null the cursor so it stops looking alive in /api/scan-status.
 *
 * Called by the scheduled trigger BEFORE it dispatches a fresh scan.
 * Best-effort: a Firestore hiccup here must not block the new scan.
 *
 * Returns a small report for the trigger to log.
 */
export interface RecoverStuckRunsArgs {
  db: Firestore;
  runIdPrefix: string;
  staleThresholdMs?: number;
  now?: number;
  /** Cap the prefix scan; per board+universe we never expect more than
   *  the retention window (30 runs). 50 is generous. */
  scanLimit?: number;
}

export interface StuckRunRecord {
  runId: string;
  updatedAt?: string;
  phase?: string;
  reason: string;
}

export interface RecoverStuckRunsResult {
  inspected: number;
  recovered: StuckRunRecord[];
}

export async function recoverStuckRuns(
  args: RecoverStuckRunsArgs,
): Promise<RecoverStuckRunsResult> {
  const {
    db,
    runIdPrefix,
    staleThresholdMs = STALE_RUN_THRESHOLD_MS,
    now = Date.now(),
    scanLimit = 50,
  } = args;

  // Range query on doc-id, descending — same shape /api/scan-status uses.
  const snap = await db
    .collection('scanRuns')
    .orderBy('__name__', 'desc')
    .startAt(runIdPrefix + '')
    .endAt(runIdPrefix)
    .limit(scanLimit)
    .get();

  const recovered: StuckRunRecord[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as {
      status?: string;
      updatedAt?: string;
      cursor?: ScanCursor | null;
    };
    if (data.status !== 'running') continue;
    const updatedAt = data.updatedAt;
    const t = updatedAt ? Date.parse(updatedAt) : NaN;
    if (!Number.isFinite(t)) continue;
    const ageMs = now - t;
    if (ageMs < staleThresholdMs) continue;

    // Stuck. Clear the cursor and stamp status=error.
    await clearScanCursor(db, doc.id, 'error');
    recovered.push({
      runId: doc.id,
      updatedAt,
      phase: data.cursor?.phase,
      reason: `stale running run, idle ${Math.round(ageMs / 60_000)} min`,
    });
  }

  return { inspected: snap.docs.length, recovered };
}

// Exposed for tests so a fixed `now` can be injected and the recovered
// cursor handler can be re-exported as a unit.
export { readScanCursor };
