// Phase 4e-1-infra — backtest checkpoint cursor.
//
// Netlify Background Functions have a hard 15-minute wall-clock ceiling.
// A full 7-year sp500/monthly backtest needs ~88 min of compute (≈84
// rebalances × ~63s each), so a single invocation cannot complete the
// work. To extend execution we save a cursor at each batch boundary,
// then self-reinvoke via `Context.waitUntil(fetch(...))`; the next
// invocation reads the cursor and resumes from where the previous one
// left off.
//
// The cursor is stored as a top-level `cursor` field on the same
// run document (`portfolioBacktests/{runId}` for portfolio runs,
// `backtestRuns/{runId}` for regular runs). Keeping it inline with
// the doc means a single Firestore read can recover both the run's
// status and its resume position; a separate cursor collection would
// require a second round trip and break atomicity on terminal writes.
//
// Engine-specific state (positions, cash, running equity curve, etc.)
// is stored in the generic `state` field; the cursor type is intentionally
// agnostic of which engine produced it. Each bg-function defines its own
// state shape and passes it as the generic type parameter.

import type { Firestore } from 'firebase-admin/firestore';

/**
 * Per-run cursor that the bg-function reads on entry and writes at each
 * batch boundary.
 *
 * Generic over the engine-specific state payload `TState`. The portfolio
 * harness stores `{cash, positions, equityCurve, swaps, ...}`; the regular
 * engine stores `{nav, portfolio, dailyEquity, trades, attribution, ...}`.
 *
 * `state` is null on the first invocation (before any rebalance has run);
 * it becomes non-null after the first batch completes. Terminal writes
 * either clear the cursor field entirely (preferred — `clearCursor`) or
 * set it to null.
 */
export interface BacktestCursor<TState = unknown> {
  /** 0-based index of the NEXT rebalance to process. */
  nextRebalanceIndex: number;
  /** Computed once at run start; immutable across batches. */
  totalRebalances: number;
  /** ISO timestamp of the current invocation's start (debug provenance). */
  lastInvocationStartedAt: string;
  /** 1-indexed invocation counter. Increments on each batch. */
  invocationCount: number;
  /** Engine-specific resume payload — opaque to this module. */
  state: TState | null;
  /** Counters that survive across batches without needing the full state. */
  cumulativeMetrics: {
    tradeCount: number;
    mlTrainingCount: number;
  };
  /** Most recent error (if any). Cleared on successful batch. */
  lastError?: string;
  /** Set if a self-reinvoke fetch failed; orchestrator may need to recover. */
  lastReinvokeError?: string;
  /** Phase 4r-W1b — ISO timestamp of the most recent self-reinvoke
   *  dispatch attempt. When `status === 'running'` and this is set,
   *  we KNOW the watchdog tripped and we attempted to chain. If the
   *  cursor's `lastInvocationStartedAt` does not advance past this
   *  point, the reinvoke dispatch either failed or the next invocation
   *  never landed — that pinpoints the stall to the reinvoke layer
   *  rather than the watchdog or the batch loop. Mirrors the
   *  Phase 4o W2 addition on the scan-side cursor. */
  lastReinvokeAt?: string;
  /** Phase 4r-W1b — running counter of self-reinvoke dispatch attempts
   *  (one increment per call to `dispatchReinvoke`, not per retry
   *  inside it). Compare to `invocationCount` post-mortem: if
   *  reinvokeAttempts === N and invocationCount === N (rather than
   *  N+1), the chain stalled at the Nth handoff. */
  reinvokeAttempts?: number;
  /** Phase 4r-W1b — number of retries the LAST dispatch consumed
   *  (1..maxAttempts). > 1 means the gateway throttled at least once;
   *  routinely > 1 across runs hints at concurrency pressure. */
  lastReinvokeRetries?: number;
  /** Phase 4r-W1b — HTTP status of the last dispatch's final attempt,
   *  when one was received. Diagnostic only — the cursor moves
   *  forward on success and stamps lastReinvokeError on failure. */
  lastReinvokeStatus?: number;
  /** Phase 4r-W1b W3 — number of stuck-run recovery attempts the
   *  recovery sweep has issued for this run. Capped by
   *  MAX_RECOVERY_ATTEMPTS in `recover.ts`; on cap exhaustion the run
   *  is failed cleanly so a fresh run can take the window. */
  recoveryAttempts?: number;
}

/**
 * Read the cursor field from a run document. Returns null when:
 *   - The doc doesn't exist (caller should treat as missing run).
 *   - The doc exists but has no `cursor` field, or the field is null
 *     (caller should treat as fresh-start).
 */
export async function readCursor<TState>(
  db: Firestore,
  collection: string,
  runId: string,
): Promise<BacktestCursor<TState> | null> {
  const snap = await db.collection(collection).doc(runId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || data.cursor == null) return null;
  return data.cursor as BacktestCursor<TState>;
}

/**
 * Merge-write a cursor onto a run document. Existing fields on the doc
 * (`config`, `status`, `startedAt`, etc.) are preserved.
 */
export async function writeCursor<TState>(
  db: Firestore,
  collection: string,
  runId: string,
  cursor: BacktestCursor<TState>,
): Promise<void> {
  await db
    .collection(collection)
    .doc(runId)
    .set({ cursor, updatedAt: new Date().toISOString() }, { merge: true });
}

/**
 * Null out the cursor on terminal write. Done atomically with the
 * status flip in the bg-function so a stale re-invocation can't loop.
 *
 * Implemented as a merge-write of `cursor: null` rather than a field
 * delete because Firestore admin SDK's FieldValue.delete() requires
 * importing the sentinel and the null sentinel is simpler/equivalent
 * for our read path (readCursor treats null and missing identically).
 */
export async function clearCursor(
  db: Firestore,
  collection: string,
  runId: string,
): Promise<void> {
  await db
    .collection(collection)
    .doc(runId)
    .set({ cursor: null, updatedAt: new Date().toISOString() }, { merge: true });
}
